import { describe, expect, it, vi } from "vitest";
import { pickMostRecentlyAuthorized } from "@/lib/account-selection";
import { collectRecentRecords, type FetchRecordsPage } from "@/lib/recent-records";
import { assertConnectionIsFresh } from "@/lib/connection-freshness";
import { localeFromAcceptLanguage } from "@/lib/currency";

describe("reconnect account selection", () => {
  // Shapes observed live on Nov 6 2026: a reconnect re-authorized the
  // Nov 5 account (createdAt unchanged, updatedAt / lastAuthAt moved).
  const older = { id: "oct21", createdAt: "2026-10-21T10:11:14.237Z", updatedAt: "2026-10-21T10:17:03.250Z" };
  const reauthorized = { id: "nov5", createdAt: "2026-11-05T16:04:27.079Z", updatedAt: "2026-11-06T06:12:49.591Z" };

  it("picks the account updated most recently, not the newest-created one", () => {
    const newerButUntouched = { id: "nov6-new", createdAt: "2026-11-06T06:00:00.000Z", updatedAt: "2026-11-06T06:00:00.100Z" };
    expect(pickMostRecentlyAuthorized([older, newerButUntouched, reauthorized])?.id).toBe("nov5");
  });

  it("falls back to createdAt when updatedAt is missing", () => {
    expect(pickMostRecentlyAuthorized([{ id: "a", createdAt: "2026-01-01T00:00:00Z" }, { id: "b", createdAt: "2026-02-01T00:00:00Z" }])?.id).toBe("b");
  });

  it("returns undefined for no accounts", () => {
    expect(pickMostRecentlyAuthorized([])).toBeUndefined();
  });

  it("accepts the observed reconnect as fresh", () => {
    const flowStartedAt = new Date("2026-11-06T06:12:20.000Z");
    expect(() =>
      assertConnectionIsFresh(["2026-11-06T06:12:49.370Z", reauthorized.updatedAt, reauthorized.createdAt], flowStartedAt)
    ).not.toThrow();
  });
});

describe("collectRecentRecords", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const options = { limit: 3, windowsInDays: [1, 7, 30], pageSize: 2, maxPagesPerWindow: 5, now };

  function fakeSource(createdAts: string[]): FetchRecordsPage<{ createdAt: string }> & { calls: Array<{ since: string; cursor?: string }> } {
    const calls: Array<{ since: string; cursor?: string }> = [];
    const fetch = (async ({ since, pageSize, cursor }) => {
      calls.push({ since, cursor });
      // Oldest first, like Square.
      const matching = createdAts.filter((c) => c >= since).sort();
      const start = cursor ? Number(cursor) : 0;
      const data = matching.slice(start, start + pageSize).map((createdAt) => ({ createdAt }));
      const hasMore = start + pageSize < matching.length;
      return { data, pagination: { hasMore, cursor: hasMore ? String(start + pageSize) : null } };
    }) as FetchRecordsPage<{ createdAt: string }> & { calls: typeof calls };
    fetch.calls = calls;
    return fetch;
  }

  it("returns the newest records first, following cursors", async () => {
    const source = fakeSource(["2026-11-06T01:00:00Z", "2026-11-06T02:00:00Z", "2026-11-06T03:00:00Z", "2026-11-06T04:00:00Z"]);
    const { records, truncated } = await collectRecentRecords(source, options);
    expect(records.map((r) => r.createdAt)).toEqual(["2026-11-06T04:00:00Z", "2026-11-06T03:00:00Z", "2026-11-06T02:00:00Z"]);
    expect(truncated).toBe(false);
    expect(source.calls.every((c) => c.since === "2026-11-05T12:00:00.000Z")).toBe(true);
  });

  it("widens the window only until the list is full", async () => {
    const source = fakeSource(["2026-10-10T00:00:00Z", "2026-11-03T00:00:00Z", "2026-11-04T00:00:00Z", "2026-11-06T05:00:00Z"]);
    const { records } = await collectRecentRecords(source, options);
    expect(records.map((r) => r.createdAt)).toEqual(["2026-11-06T05:00:00Z", "2026-11-04T00:00:00Z", "2026-11-03T00:00:00Z"]);
    const sinces = [...new Set(source.calls.map((c) => c.since))];
    expect(sinces).toEqual(["2026-11-05T12:00:00.000Z", "2026-10-30T12:00:00.000Z"]);
  });

  it("stops and reports truncation when a window has more pages than allowed", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `2026-11-06T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}:00Z`);
    const source = fakeSource(many);
    const { truncated } = await collectRecentRecords(source, { ...options, maxPagesPerWindow: 2 });
    expect(truncated).toBe(true);
    expect(source.calls).toHaveLength(2);
  });

  it("surfaces read errors", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(collectRecentRecords(failing, options)).rejects.toThrow("boom");
  });
});

describe("localeFromAcceptLanguage", () => {
  it("picks the highest-weighted supported language", () => {
    expect(localeFromAcceptLanguage("fr-CH, fr;q=0.9, en;q=0.8, *;q=0.5")).toBe("fr-CH");
    expect(localeFromAcceptLanguage("en;q=0.5, de-DE;q=0.9")).toBe("de-DE");
  });

  it("skips wildcards, zero weights and malformed tags", () => {
    expect(localeFromAcceptLanguage("*, de;q=0, !!bad, en-GB;q=0.3")).toBe("en-GB");
  });

  it("falls back to en-US", () => {
    expect(localeFromAcceptLanguage(undefined)).toBe("en-US");
    expect(localeFromAcceptLanguage("")).toBe("en-US");
    expect(localeFromAcceptLanguage("*")).toBe("en-US");
  });
});
