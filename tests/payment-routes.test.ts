import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { paymentExternalIdFor } from "@/lib/idempotency";

// Route-level tests for the order -> payment -> retry path, with the Square
// calls mocked so a payment failure can be simulated without real captures.

interface FakeSession {
  linkToAnyAccountId?: string;
  currencyCode?: string;
  pendingPayment?: { orderId: string; paymentExternalId: string; amount: number; currencyCode: string };
  save: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  session: undefined as unknown as FakeSession,
  paymentWritesEnabled: true,
}));

const linktoany = vi.hoisted(() => ({
  resolveOrderLineItems: vi.fn(),
  createOrder: vi.fn(),
  createOrderPayment: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({ paymentWritesEnabled: state.paymentWritesEnabled }),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => true }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/linktoany", () => ({ ...linktoany, MAX_LINE_ITEMS: 50 }));

const { POST: createOrderRoute } = await import("@/app/api/square/orders/route");
const { POST: retryPaymentRoute } = await import("@/app/api/square/orders/[orderId]/payment/route");

function orderRequest() {
  return new NextRequest("http://localhost/api/square/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idempotencyKey: "idem-key-12345678",
      lineItems: [{ variationExternalId: "VAR1", quantity: 2 }],
    }),
  });
}

function retry(orderId: string) {
  return retryPaymentRoute(
    new NextRequest(`http://localhost/api/square/orders/${orderId}/payment`, { method: "POST" }),
    { params: Promise.resolve({ orderId }) }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.paymentWritesEnabled = true;
  state.session = { linkToAnyAccountId: "acct_1", currencyCode: "USD", save: vi.fn() };
  linktoany.resolveOrderLineItems.mockResolvedValue([
    { variationExternalId: "VAR1", name: "Tea", quantity: 2, unitPrice: 60 },
  ]);
  linktoany.createOrder.mockResolvedValue({ id: "ORDER_1", total: 120, currencyCode: "USD" });
  linktoany.createOrderPayment.mockResolvedValue(undefined);
});

describe("POST /api/square/orders", () => {
  it("writes no payment when payment writes are disabled", async () => {
    state.paymentWritesEnabled = false;
    const res = await createOrderRoute(orderRequest());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ orderId: "ORDER_1", paymentRecorded: false });
    expect(linktoany.createOrderPayment).not.toHaveBeenCalled();
  });

  it("records the payment when enabled", async () => {
    const res = await createOrderRoute(orderRequest());
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ orderId: "ORDER_1", total: 120, paymentRecorded: true });
    expect(linktoany.createOrderPayment).toHaveBeenCalledWith("acct_1", "ORDER_1", expect.any(String), 120, "USD");
    expect(state.session.pendingPayment).toBeUndefined();
  });

  it("uses the same payment id for a retried request with the same idempotency key", async () => {
    await createOrderRoute(orderRequest());
    await createOrderRoute(orderRequest());
    const [first, second] = linktoany.createOrderPayment.mock.calls.map((call) => call[2]);
    expect(first).toBe(second);
    expect(first).toBe(paymentExternalIdFor("idem-key-12345678"));
  });

  it("rejects a JSON body that is not an object", async () => {
    for (const raw of ["null", "42", '"text"', "[]"]) {
      const res = await createOrderRoute(
        new NextRequest("http://localhost/api/square/orders", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: raw,
        })
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    }
    expect(linktoany.createOrder).not.toHaveBeenCalled();
  });

  it("returns 207 and keeps a retryable pending payment when the payment fails", async () => {
    linktoany.createOrderPayment.mockRejectedValueOnce(new Error("square down"));
    const res = await createOrderRoute(orderRequest());
    expect(res.status).toBe(207);
    expect(await res.json()).toMatchObject({ orderId: "ORDER_1", paymentRecorded: false, retryable: true });
    const paymentId = linktoany.createOrderPayment.mock.calls[0][2];
    expect(state.session.pendingPayment).toEqual({
      orderId: "ORDER_1",
      paymentExternalId: paymentId,
      amount: 120,
      currencyCode: "USD",
    });
    expect(state.session.save).toHaveBeenCalled();
  });
});

describe("POST /api/square/orders/[orderId]/payment (retry)", () => {
  const pending = { orderId: "ORDER_1", paymentExternalId: "pay-fixed-id", amount: 120, currencyCode: "USD" };

  it("full flow: failed payment, then a retry that reuses the same payment id and amount", async () => {
    linktoany.createOrderPayment.mockRejectedValueOnce(new Error("square down"));
    await createOrderRoute(orderRequest());
    const firstPaymentId = linktoany.createOrderPayment.mock.calls[0][2];

    const res = await retry("ORDER_1");
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ orderId: "ORDER_1", total: 120, paymentRecorded: true });
    expect(linktoany.createOrderPayment).toHaveBeenLastCalledWith("acct_1", "ORDER_1", firstPaymentId, 120, "USD");
    expect(state.session.pendingPayment).toBeUndefined();
  });

  it("keeps the pending payment when the retry fails again", async () => {
    state.session.pendingPayment = { ...pending };
    linktoany.createOrderPayment.mockRejectedValueOnce(new Error("still down"));
    const res = await retry("ORDER_1");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ retryable: true });
    expect(state.session.pendingPayment).toEqual(pending);
  });

  it("refuses a retry for a different order", async () => {
    state.session.pendingPayment = { ...pending };
    const res = await retry("ORDER_2");
    expect(res.status).toBe(404);
    expect(linktoany.createOrderPayment).not.toHaveBeenCalled();
  });

  it("refuses when payment writes are disabled", async () => {
    state.session.pendingPayment = { ...pending };
    state.paymentWritesEnabled = false;
    const res = await retry("ORDER_1");
    expect(res.status).toBe(403);
    expect(linktoany.createOrderPayment).not.toHaveBeenCalled();
  });

  it("refuses when not connected", async () => {
    state.session = { save: vi.fn() };
    const res = await retry("ORDER_1");
    expect(res.status).toBe(401);
  });
});
