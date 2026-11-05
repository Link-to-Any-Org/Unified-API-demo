import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  createOrder,
  createOrderPayment,
  resolveOrderLineItems,
  MAX_LINE_ITEMS,
  type RequestedLineItem,
} from "@/lib/uniflow";
import { getSession } from "@/lib/session";
import { ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { DEFAULT_CURRENCY } from "@/lib/currency";

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
  const accountId = session.uniflowAccountId;

  if (!accountId) {
    return NextResponse.json({ error: "Not connected to Square" }, { status: 401 });
  }

  if (!checkRateLimit(accountId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let body: CreateOrderRequestBody;
  try {
    body = await request.json();
  } catch {
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
    const lineItems = await resolveOrderLineItems(accountId, currencyCode, body.lineItems);
    const order = await createOrder(accountId, body.idempotencyKey, lineItems, currencyCode);

    try {
      if (order.total > 0) {
        await createOrderPayment(accountId, order.id, order.total, order.currencyCode);
      }
    } catch (err) {
      logger.error("square.orders.payment_failed", { requestId, accountId, orderId: order.id, err });
      // Order exists but the payment write failed - a distinct status so the
      // client can tell "nothing happened" apart from "order placed, payment
      // did not go through".
      return NextResponse.json(
        {
          orderId: order.id,
          total: order.total,
          currencyCode: order.currencyCode,
          error: "Order was created but recording the payment failed",
        },
        { status: 207 }
      );
    }

    return NextResponse.json(
      { orderId: order.id, total: order.total, currencyCode: order.currencyCode },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof ValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    logger.error("square.orders.create_failed", { requestId, accountId, err });
    return NextResponse.json({ error: "Failed to create order" }, { status: 502 });
  }
}
