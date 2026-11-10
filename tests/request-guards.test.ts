import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyWithLimit } from "@/lib/read-body";
import { assertConnectionIsFresh, CONNECTION_CLOCK_SKEW_MS } from "@/lib/connection-freshness";
import { formatPrice } from "@/lib/currency";
import { accountSystemId, assertAccountOnSystem } from "@/lib/account-selection";
import { lineItemExternalIdFor, paymentExternalIdFor } from "@/lib/idempotency";
import { clientRateLimitKey } from "@/lib/rate-limit";
import { ValidationError } from "@/lib/errors";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("readBodyWithLimit", () => {
  it("returns the body when under the limit", async () => {
    await expect(readBodyWithLimit(streamOf('{"a":', "1}"), 64)).resolves.toBe('{"a":1}');
  });

  it("returns an empty string for a missing body", async () => {
    await expect(readBodyWithLimit(null, 64)).resolves.toBe("");
  });

  it("rejects a chunked body that exceeds the limit with no Content-Length", async () => {
    await expect(readBodyWithLimit(streamOf("x".repeat(40), "x".repeat(40)), 64)).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
  });
});

describe("assertConnectionIsFresh", () => {
  const flowStartedAt = new Date("2026-11-05T12:00:00Z");

  it("accepts a reconnect whose account predates the flow but was re-authorized during it", () => {
    expect(() =>
      assertConnectionIsFresh(["2026-11-05T12:00:30Z", undefined, "2025-01-01T00:00:00Z"], flowStartedAt)
    ).not.toThrow();
  });

  it("rejects an account with no activity since the flow started", () => {
    expect(() =>
      assertConnectionIsFresh(["2026-11-04T12:00:00Z", "2026-11-04T12:00:00Z"], flowStartedAt)
    ).toThrow(/not \(re\)authorized/);
  });

  it("allows clock skew", () => {
    const justInside = new Date(flowStartedAt.getTime() - CONNECTION_CLOCK_SKEW_MS + 1000).toISOString();
    expect(() => assertConnectionIsFresh([justInside], flowStartedAt)).not.toThrow();
  });

  it("fails closed when no timestamp is usable", () => {
    expect(() => assertConnectionIsFresh([undefined, "not-a-date"], flowStartedAt)).toThrow();
  });
});

describe("locale handling", () => {
  it("formats with the given locale", () => {
    expect(formatPrice(1234.5, "EUR", "de-DE")).toMatch(/1\.234,50/);
  });
});

describe("assertAccountOnSystem", () => {
  const SQUARE = "6500000000000000000000aa";

  it("reads a bare or populated systemId", () => {
    expect(accountSystemId({ systemId: SQUARE })).toBe(SQUARE);
    expect(accountSystemId({ systemId: { _id: SQUARE, name: "Square" } })).toBe(SQUARE);
    expect(accountSystemId({})).toBeUndefined();
  });

  it("accepts an account on the configured system", () => {
    expect(() => assertAccountOnSystem({ systemId: SQUARE }, SQUARE)).not.toThrow();
    expect(() => assertAccountOnSystem({ systemId: { _id: SQUARE } }, SQUARE)).not.toThrow();
  });

  it("rejects an account on another system or with no system", () => {
    expect(() => assertAccountOnSystem({ systemId: "6500000000000000000000bb" }, SQUARE)).toThrow(ValidationError);
    expect(() => assertAccountOnSystem({}, SQUARE)).toThrow(ValidationError);
  });
});

describe("idempotency-derived ids", () => {
  it("derives the payment and line ids from the order's key, deterministically", () => {
    expect(paymentExternalIdFor("abc-123")).toBe(paymentExternalIdFor("abc-123"));
    expect(paymentExternalIdFor("abc-123")).not.toBe(paymentExternalIdFor("abc-124"));
    expect(lineItemExternalIdFor("abc-123", 0)).not.toBe(lineItemExternalIdFor("abc-123", 1));
    expect(lineItemExternalIdFor("abc-123", 2)).toBe(lineItemExternalIdFor("abc-123", 2));
  });
});

describe("clientRateLimitKey", () => {
  it("uses the first forwarded address behind a proxy", () => {
    const request = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.2" },
    });
    expect(clientRateLimitKey(request)).toBe("ip:203.0.113.9");
  });

  it("falls back to X-Real-IP, then to a shared bucket", () => {
    expect(clientRateLimitKey(new Request("http://localhost/x", { headers: { "x-real-ip": "198.51.100.4" } }))).toBe(
      "ip:198.51.100.4"
    );
    expect(clientRateLimitKey(new Request("http://localhost/x"))).toBe("ip:unknown");
  });
});
