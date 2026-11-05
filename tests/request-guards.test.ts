import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyWithLimit } from "@/lib/read-body";
import { assertConnectionIsFresh, CONNECTION_CLOCK_SKEW_MS } from "@/lib/connection-freshness";
import { formatPrice, resolveLocale } from "@/lib/currency";

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
  it("normalises Square-style locales", () => {
    expect(resolveLocale("fr_CA")).toBe("fr-CA");
  });

  it("falls back for missing or invalid locales", () => {
    expect(resolveLocale(undefined)).toBe("en-US");
    expect(resolveLocale("!!")).toBe("en-US");
  });

  it("formats with the given locale", () => {
    expect(formatPrice(1234.5, "EUR", "de-DE")).toMatch(/1\.234,50/);
  });
});
