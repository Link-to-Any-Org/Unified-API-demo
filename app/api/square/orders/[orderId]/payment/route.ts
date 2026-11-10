import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createOrderPayment } from "@/lib/linktoany";
import { getSession } from "@/lib/session";
import { getConfig } from "@/lib/config";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";

// Retries only the payment write for an order whose payment failed (the 207
// case of POST /api/square/orders). Amount, currency and the payment's own
// externalId all come from the sealed session, never from the request, so
// this can't be used to charge a different amount or capture twice.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ orderId: string }> }
) {
  const requestId = randomUUID();
  const session = await getSession();
  const accountId = session.linkToAnyAccountId;

  if (!accountId) {
    return NextResponse.json({ error: "Not connected to Square" }, { status: 401 });
  }

  if (!checkRateLimit(accountId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!getConfig().paymentWritesEnabled) {
    return NextResponse.json({ error: "Payment writes are disabled" }, { status: 403 });
  }

  const { orderId } = await params;
  const pending = session.pendingPayment;
  if (!pending || pending.orderId !== orderId) {
    return NextResponse.json({ error: "No pending payment for this order" }, { status: 404 });
  }

  try {
    await createOrderPayment(
      accountId,
      pending.orderId,
      pending.paymentExternalId,
      pending.amount,
      pending.currencyCode
    );
  } catch (err) {
    logger.error("square.orders.payment_retry_failed", { requestId, accountId, orderId, err });
    return NextResponse.json(
      { orderId, retryable: true, error: "Recording the payment failed again" },
      { status: 502 }
    );
  }

  session.pendingPayment = undefined;
  await session.save();
  return NextResponse.json(
    { orderId, total: pending.amount, currencyCode: pending.currencyCode, paymentRecorded: true },
    { status: 201 }
  );
}
