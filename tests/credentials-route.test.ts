import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ValidationError as SdkValidationError } from "@linktoany/sdk";

// Route-level tests for connecting a direct-auth system with the merchant's
// own credentials, with every LinkToAny call mocked.

const state = vi.hoisted(() => ({
  connect: undefined as unknown,
  rateLimitOk: true,
}));

const linktoany = vi.hoisted(() => ({
  connectWithCredentials: vi.fn(),
  verifyConnection: vi.fn(),
  getReturnUrl: () => "https://app.example.com/api/connect/callback",
}));
const storeConnection = vi.hoisted(() => vi.fn());
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock("@/lib/linktoany", () => linktoany);
vi.mock("@/lib/connect-session", () => ({ storeConnection }));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ save: vi.fn() }) }));
vi.mock("@/lib/system-profile", () => ({
  getSystemProfile: async () => ({ connect: state.connect }),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => state.rateLimitOk, clientRateLimitKey: () => "ip:test" }));
vi.mock("@/lib/logger", () => ({ logger }));

const { POST } = await import("@/app/api/connect/credentials/route");

const SECRET = "tok_super_secret_value";
const FORM_PLAN = {
  mode: "form",
  application: "demo-app",
  fields: [
    { name: "merchantId", sourceField: "merchantId", label: "Merchant", secret: false, isUnique: true },
    { name: "token", sourceField: "personalToken", label: "Token", secret: true, isUnique: false },
  ],
};

function submit(fields: Record<string, string>) {
  return POST(
    new NextRequest("http://localhost/api/connect/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    })
  );
}

function location(res: Response): string {
  return new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.connect = FORM_PLAN;
  state.rateLimitOk = true;
  linktoany.connectWithCredentials.mockResolvedValue({ _id: "acct_1" });
  linktoany.verifyConnection.mockResolvedValue({ account: { _id: "acct_1" }, currencyCode: "USD" });
  storeConnection.mockResolvedValue("/items");
});

describe("POST /api/connect/credentials", () => {
  it("connects with only the fields the system asked for, then lands on the stored path", async () => {
    const res = await submit({ merchantId: "M1", personalToken: SECRET, extra: "ignored" });
    expect(res.status).toBe(303);
    expect(location(res)).toBe("/items");
    expect(linktoany.connectWithCredentials).toHaveBeenCalledWith("demo-app", {
      merchantId: "M1",
      personalToken: SECRET,
    });
    // No third-party merchant id to cross-check for an account this call created.
    expect(linktoany.verifyConnection).toHaveBeenCalledWith({ _id: "acct_1" }, undefined, expect.any(Date));
    expect(storeConnection).toHaveBeenCalled();
  });

  it("redirects back with an error when a required field is missing", async () => {
    const res = await submit({ merchantId: "M1" });
    expect(location(res)).toBe("/?error=missing_fields");
    expect(linktoany.connectWithCredentials).not.toHaveBeenCalled();
  });

  it("treats blank values as missing", async () => {
    const res = await submit({ merchantId: "M1", personalToken: "   " });
    expect(location(res)).toBe("/?error=missing_fields");
  });

  it("refuses a system that doesn't connect with credentials", async () => {
    state.connect = { mode: "oauth_redirect", application: "demo-app" };
    const res = await submit({ merchantId: "M1", personalToken: SECRET });
    expect(location(res)).toBe("/?error=connect_failed");
    expect(linktoany.connectWithCredentials).not.toHaveBeenCalled();
  });

  it("maps rejected credentials to their own message without leaking them", async () => {
    linktoany.connectWithCredentials.mockRejectedValueOnce(
      new SdkValidationError(`bad token ${SECRET}`, { status: 422 } as never)
    );
    const res = await submit({ merchantId: "M1", personalToken: SECRET });
    expect(location(res)).toBe("/?error=invalid_credentials");
    expect(res.headers.get("location")).not.toContain(SECRET);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET);
  });

  it("reports any other failure as a generic connect failure", async () => {
    linktoany.connectWithCredentials.mockRejectedValueOnce(new Error("boom"));
    const res = await submit({ merchantId: "M1", personalToken: SECRET });
    expect(location(res)).toBe("/?error=connect_failed");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET);
  });

  it("does not store a connection that fails verification", async () => {
    linktoany.verifyConnection.mockRejectedValueOnce(new Error("not active"));
    const res = await submit({ merchantId: "M1", personalToken: SECRET });
    expect(location(res)).toBe("/?error=connect_failed");
    expect(storeConnection).not.toHaveBeenCalled();
  });

  it("is rate limited", async () => {
    state.rateLimitOk = false;
    const res = await submit({ merchantId: "M1", personalToken: SECRET });
    expect(location(res)).toBe("/?error=too_many_attempts");
    expect(linktoany.connectWithCredentials).not.toHaveBeenCalled();
  });
});
