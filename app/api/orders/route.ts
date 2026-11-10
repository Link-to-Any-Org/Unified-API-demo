import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  createOrder,
  createOrderPayment,
  resolveOrderLineItems,
  MAX_LINE_ITEMS,
  type RequestedLineItem,
} from "@/lib/linktoany";
import { connectedAccountId, getSession } from "@/lib/session";
import { getSystemProfile } from "@/lib/system-profile";
import { getConfig } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import { BodyTooLargeError, readBodyWithLimit } from "@/lib/read-body";
import { paymentExternalIdFor } from "@/lib/idempotency";

const MAX_BODY_BYTES = 16 * 1024;

interface CreateOrderRequestBody {
  idempotencyKey?: string;
  lineItems?: unknown;
}

function isRequestedLineItem(item: unknown): item is RequestedLineItem {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  return (
    typeof candidate.variationExternalId === "string" &&
    candidate.variationExternalId.length > 0 &&
    typeof candidate.quantity === "number"
  );
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const session = await getSession();
  const accountId = connectedAccountId(session);

  if (!accountId) {
    return NextResponse.json({ error: "Not connected" }, { status: 401 });
  }

  if (!checkRateLimit(accountId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Fast reject on an honest Content-Length; the real cap is enforced while
  // reading, since chunked requests don't send the header at all.
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: CreateOrderRequestBody;
  try {
    const parsed: unknown = JSON.parse(await readBodyWithLimit(request.body, MAX_BODY_BYTES));
    // `null`, a number, a string or an array are all valid JSON but not a
    // request body; reading `.idempotencyKey` off `null` would throw.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as CreateOrderRequestBody;
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ error: "Request body too large" }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.idempotencyKey !== "string" || body.idempotencyKey.length < 8 || body.idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "idempotencyKey is required and must be an 8-128 character string" },
      { status: 400 }
    );
  }

  if (
    !Array.isArray(body.lineItems) ||
    body.lineItems.length === 0 ||
    body.lineItems.length > MAX_LINE_ITEMS ||
    !body.lineItems.every(isRequestedLineItem)
  ) {
    return NextResponse.json(
      {
        error: `lineItems must be a non-empty array of up to ${MAX_LINE_ITEMS} items, each with a variationExternalId and a numeric quantity`,
      },
      { status: 400 }
    );
  }

  const currencyCode = session.currencyCode ?? DEFAULT_CURRENCY;

  try {
    // Everything that can fail for reasons unrelated to this order is
    // resolved before the order is written, so a transient profile failure
    // never turns an order that was created into a reported failure.
    // Hard gate: with payment writes disabled the order is all that's
    // written - no payment record is ever sent. Also skipped when the system
    // has no payment write at all, which would only ever fail.
    const { capabilities } = await getSystemProfile();
    const recordsPayment = getConfig().paymentWritesEnabled && capabilities.payments;

    const lineItems = await resolveOrderLineItems(accountId, currencyCode, body.lineItems);
    const order = await createOrder(accountId, body.idempotencyKey, lineItems, currencyCode, {
      recordsPayment,
    });
    const orderResult = { orderId: order.id, total: order.total, currencyCode: order.currencyCode };

    if (!recordsPayment || order.total <= 0) {
      return NextResponse.json({ ...orderResult, paymentRecorded: false }, { status: 201 });
    }

    // Derived from the idempotency key, never minted per request: a retry of
    // the same checkout (say, after a dropped response) must reuse the same
    // payment externalId, or the Unified API would record a second capture
    // against an order it had just upserted.
    const paymentExternalId = paymentExternalIdFor(body.idempotencyKey);
    try {
      await createOrderPayment(accountId, order.id, paymentExternalId, order.total, order.currencyCode);
    } catch (err) {
      logger.error("orders.payment_failed", {
        requestId,
        accountId,
        orderId: order.id,
        orderIdIsNative: order.idIsNative,
        err,
      });
      // A retry can only help when the payment referenced the platform's own
      // order id. When that id could not be found and the app's externalId
      // was sent instead, every retry would fail the same way, so no pending
      // payment is kept and the client is told not to offer one.
      if (order.idIsNative) {
        // Keep what's needed to retry just the payment in the sealed session,
        // so the retry can't change the amount and reuses the same payment id.
        session.pendingPayment = {
          orderId: order.id,
          paymentExternalId,
          amount: order.total,
          currencyCode: order.currencyCode,
        };
        await session.save();
      }
      // Order exists but the payment write failed - a distinct status so the
      // client can tell "nothing happened" apart from "order placed, payment
      // did not go through", and offer a payment retry where one can succeed.
      return NextResponse.json(
        {
          ...orderResult,
          paymentRecorded: false,
          retryable: order.idIsNative,
          error: order.idIsNative
            ? "Order was created but recording the payment failed"
            : "Order was created, but this system's order id could not be read, so no payment can be recorded for it",
        },
        { status: 207 }
      );
    }

    return NextResponse.json({ ...orderResult, paymentRecorded: true }, { status: 201 });
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error("orders.create_failed", { requestId, accountId, err });
    return NextResponse.json({ error: "Failed to create order" }, { status: 502 });
  }
}
