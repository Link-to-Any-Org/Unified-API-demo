import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Route-level tests for the OAuth callback's own branching: the state nonce
// (missing, mismatched, expired), a provider error, and the bind on success.
// The verification itself lives in lib/ and is tested there; here it is mocked.

interface FakeSession {
  linkToAnyAccountId?: string;
  systemId?: string;
  merchantName?: string;
  currencyCode?: string;
  pendingPayment?: unknown;
  oauthState?: string;
  oauthStateCreatedAt?: string;
  save: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({ session: undefined as unknown as FakeSession }));

const linktoany = vi.hoisted(() => ({
  getReturnUrl: () => "https://app.example.com/api/connect/callback",
  getLinkToAnyClient: vi.fn(),
  findAccountForMerchant: vi.fn(),
  verifyConnection: vi.fn(),
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/session", () => ({ getSession: async () => state.session }));
vi.mock("@/lib/logger", () => ({ logger }));
vi.mock("@/lib/linktoany", () => linktoany);
vi.mock("@/lib/config", () => ({ getConfig: () => ({ linkToAnySystemId: "sys-a" }) }));
vi.mock("@/lib/system-profile", () => ({
  getSystemProfile: async () => ({ capabilities: { pos: true, listOrders: true, payments: true } }),
}));

const { GET } = await import("@/app/api/connect/callback/[state]/route");

const NONCE = "nonce-0123456789";
const ACCOUNT = { _id: "acct_1", merchantId: "M1", createdAt: "2026-11-05T16:04:27.079Z" };

function callback(stateParam: string, query = "") {
  return GET(new NextRequest(`http://localhost/api/connect/callback/${stateParam}${query}`), {
    params: Promise.resolve({ state: stateParam }),
  });
}

function landedOn(res: Response): string | null {
  return res.headers.get("location");
}

beforeEach(() => {
  vi.clearAllMocks();
  state.session = {
    oauthState: NONCE,
    oauthStateCreatedAt: new Date().toISOString(),
    pendingPayment: { orderId: "stale" },
    save: vi.fn(),
  };
  linktoany.findAccountForMerchant.mockResolvedValue(ACCOUNT);
  linktoany.verifyConnection.mockResolvedValue({
    account: ACCOUNT,
    merchantName: "Corner Shop",
    currencyCode: "CAD",
  });
});

describe("GET /api/connect/callback/[state]", () => {
  it("treats a callback with no nonce in the session as a stale link", async () => {
    state.session.oauthState = undefined;
    const res = await callback(NONCE, "?external_id=M1");
    expect(landedOn(res)).toBe("https://app.example.com/?error=stale_link");
    expect(logger.warn).toHaveBeenCalledWith("connect.callback.invalid_state", expect.objectContaining({ reason: "no_state_in_session" }));
    expect(linktoany.findAccountForMerchant).not.toHaveBeenCalled();
  });

  it("rejects a nonce that does not match the session", async () => {
    const res = await callback("some-other-nonce", "?external_id=M1");
    expect(landedOn(res)).toBe("https://app.example.com/?error=invalid_state");
    expect(logger.warn).toHaveBeenCalledWith("connect.callback.invalid_state", expect.objectContaining({ reason: "state_mismatch" }));
    expect(linktoany.verifyConnection).not.toHaveBeenCalled();
  });

  it("rejects a nonce older than the TTL", async () => {
    state.session.oauthStateCreatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const res = await callback(NONCE, "?external_id=M1");
    expect(landedOn(res)).toBe("https://app.example.com/?error=invalid_state");
    expect(logger.warn).toHaveBeenCalledWith("connect.callback.invalid_state", expect.objectContaining({ reason: "state_expired" }));
  });

  it("consumes the nonce even when the callback is rejected", async () => {
    await callback("some-other-nonce", "?external_id=M1");
    expect(state.session.oauthState).toBeUndefined();
    expect(state.session.oauthStateCreatedAt).toBeUndefined();
    expect(state.session.save).toHaveBeenCalled();
  });

  it("maps a provider-side failure to connect_failed without looking anything up", async () => {
    const res = await callback(NONCE, "?error=CONNECTION_FAILED&details=secret-ish");
    expect(landedOn(res)).toBe("https://app.example.com/?error=connect_failed");
    expect(logger.warn).toHaveBeenCalledWith("connect.callback.provider_error", { requestId: expect.any(String), error: "CONNECTION_FAILED" });
    expect(linktoany.findAccountForMerchant).not.toHaveBeenCalled();
  });

  it("binds the verified account to the session and lands on /items", async () => {
    const res = await callback(NONCE, "?provider=square&external_id=M1");
    expect(landedOn(res)).toBe("https://app.example.com/items");
    expect(linktoany.findAccountForMerchant).toHaveBeenCalledWith("M1");
    expect(linktoany.verifyConnection).toHaveBeenCalledWith(ACCOUNT, "M1", expect.any(Date));
    expect(state.session).toMatchObject({
      linkToAnyAccountId: "acct_1",
      systemId: "sys-a",
      merchantName: "Corner Shop",
      currencyCode: "CAD",
      pendingPayment: undefined,
      oauthState: undefined,
    });
    expect(state.session.save).toHaveBeenCalled();
  });

  it("looks the account up by accountId when the callback carries one", async () => {
    const get = vi.fn().mockResolvedValue({ data: ACCOUNT });
    linktoany.getLinkToAnyClient.mockReturnValue({ accounts: { get } });
    const res = await callback(NONCE, "?accountId=acct_1&external_id=M1");
    expect(landedOn(res)).toBe("https://app.example.com/items");
    expect(get).toHaveBeenCalledWith("acct_1");
    expect(linktoany.findAccountForMerchant).not.toHaveBeenCalled();
    expect(linktoany.verifyConnection).toHaveBeenCalledWith(ACCOUNT, "M1", expect.any(Date));
  });

  it("does not bind the session when verification fails", async () => {
    linktoany.verifyConnection.mockRejectedValueOnce(new Error("Account predates this flow"));
    const res = await callback(NONCE, "?external_id=M1");
    expect(landedOn(res)).toBe("https://app.example.com/?error=not_verified");
    expect(state.session.linkToAnyAccountId).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("connect.callback.failed", expect.objectContaining({ err: expect.any(Error) }));
  });

  it("fails closed when the callback names no account at all", async () => {
    const res = await callback(NONCE, "?provider=square");
    expect(landedOn(res)).toBe("https://app.example.com/?error=not_verified");
    expect(linktoany.verifyConnection).not.toHaveBeenCalled();
  });
});

describe("legacy /api/square/callback path", () => {
  it("answers with the same handler, so return URLs registered before the rename keep working", async () => {
    const alias = await import("@/app/api/square/callback/[state]/route");
    expect(alias.GET).toBe(GET);
  });
});
