import { NextRequest, NextResponse } from "next/server";
import {
  createOrder,
  createOrderPayment,
  listRecentOrders,
  type CreateOrderLineItem,
} from "@/lib/uniflow";
import { getSession } from "@/lib/session";

export async function GET() {
  const session = await getSession();
  if (!session.uniflowAccountId) {
    return NextResponse.json(
      { error: "Not connected to Square" },
      { status: 401 }
    );
  }

  try {
    const orders = await listRecentOrders(session.uniflowAccountId);
    return NextResponse.json({ orders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list orders";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

interface CreateOrderRequestBody {
  currencyCode?: string;
  lineItems?: CreateOrderLineItem[];
}

function isValidLineItem(item: unknown): item is CreateOrderLineItem {
  if (typeof item !== "object" || item === null) return false;
  const candidate = item as Record<string, unknown>;
  const hasIdentity =
    typeof candidate.variationExternalId === "string" ||
    typeof candidate.name === "string";
  return (
    hasIdentity &&
    typeof candidate.quantity === "number" &&
    typeof candidate.unitPrice === "number"
  );
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session.uniflowAccountId) {
    return NextResponse.json(
      { error: "Not connected to Square" },
      { status: 401 }
    );
  }

  let body: CreateOrderRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.lineItems) || body.lineItems.length === 0) {
    return NextResponse.json(
      { error: "lineItems is required and must be a non-empty array" },
      { status: 400 }
    );
  }

  if (!body.lineItems.every(isValidLineItem)) {
    return NextResponse.json(
      {
        error:
          "Each line item needs a numeric quantity and unitPrice, and either variationExternalId or name",
      },
      { status: 400 }
    );
  }

  try {
    const order = await createOrder(
      session.uniflowAccountId,
      body.lineItems,
      body.currencyCode
    );

    if (order.total > 0) {
      await createOrderPayment(
        session.uniflowAccountId,
        order.id,
        order.total,
        order.currencyCode
      );
    }

    return NextResponse.json(
      { orderId: order.id, total: order.total, currencyCode: order.currencyCode },
      { status: 201 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create order";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
