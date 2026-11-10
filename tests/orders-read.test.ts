import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError as SdkValidationError } from "@linktoany/sdk";

// listRecentOrders against a mocked client: the windowed `since` read, and the
// fallback for systems whose order read doesn't accept `since`.

const list = vi.hoisted(() => vi.fn());

vi.mock("next/cache", () => ({ cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    linkToAnyApiKey: "key",
    linkToAnyEnvironment: "dev",
    linkToAnySystemId: "sys-a",
  }),
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@linktoany/sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@linktoany/sdk")>()),
  LinkToAny: class {
    records = { list };
  },
}));

const { listRecentOrders } = await import("@/lib/linktoany");
const { logger } = await import("@/lib/logger");

const order = (id: string, createdAt: string) => ({
  externalId: id,
  status: "COMPLETED",
  createdAt,
  totals: { total: 10, currency: "USD" },
  lineItems: [{ name: "Tea", quantity: 1 }],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listRecentOrders", () => {
  it("reads by `since` and returns the newest orders first", async () => {
    list.mockResolvedValue({
      data: [order("old", "2026-11-01T00:00:00Z"), order("new", "2026-11-05T00:00:00Z")],
      pagination: { hasMore: false },
    });
    const orders = await listRecentOrders("acct");
    expect(orders.map((o) => o.id)).toEqual(["new", "old"]);
    expect(list).toHaveBeenCalledWith("acct", "order", expect.objectContaining({ since: expect.any(String), pageSize: 100 }));
  });

  it("falls back to one plain page when the system rejects `since`", async () => {
    list
      .mockRejectedValueOnce(new SdkValidationError("UNKNOWN_FILTER", { status: 422 } as never))
      .mockResolvedValueOnce({
        data: [order("a", "2026-10-01T00:00:00Z"), order("b", "2026-10-02T00:00:00Z")],
      });
    const orders = await listRecentOrders("acct");
    expect(orders.map((o) => o.id)).toEqual(["b", "a"]);
    expect(list).toHaveBeenLastCalledWith("acct", "order", { pageSize: 100 });
    expect(logger.warn).toHaveBeenCalledWith("orders.since_unsupported", { accountId: "acct" });
  });

  it("does not hide other failures behind the fallback", async () => {
    list.mockRejectedValueOnce(new Error("network down"));
    await expect(listRecentOrders("acct")).rejects.toThrow("network down");
    expect(list).toHaveBeenCalledTimes(1);
  });
});
