import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configState = vi.hoisted(() => ({ systemId: "sys-a" }));

vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config")>()),
  getConfig: () => ({ linkToAnySystemId: configState.systemId }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("next/server", () => ({ connection: async () => {} }));

const { loadConfig } = await import("@/lib/config");
const { connectedAccountId } = await import("@/lib/session");

const REQUIRED = {
  LINKTOANY_API_KEY: "key",
  LINKTOANY_RETURN_URL: "https://app.example.com/api/connect/callback",
  SESSION_SECRET: "x".repeat(32),
};
const MANAGED = [
  ...Object.keys(REQUIRED),
  "LINKTOANY_SYSTEM_ID",
  "LINKTOANY_SQUARE_SYSTEM_ID",
  "LINKTOANY_APPLICATION",
  "LINKTOANY_SQUARE_APPLICATION",
];

describe("loadConfig system selection", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of MANAGED) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    Object.assign(process.env, REQUIRED);
  });

  afterEach(() => {
    for (const name of MANAGED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it("reads the generic system and application variables", () => {
    process.env.LINKTOANY_SYSTEM_ID = "sys-new";
    process.env.LINKTOANY_APPLICATION = "app-new";
    expect(loadConfig()).toMatchObject({ linkToAnySystemId: "sys-new", linkToAnyApplication: "app-new" });
  });

  it("still accepts the old Square-named variables", () => {
    process.env.LINKTOANY_SQUARE_SYSTEM_ID = "sys-old";
    process.env.LINKTOANY_SQUARE_APPLICATION = "app-old";
    expect(loadConfig()).toMatchObject({ linkToAnySystemId: "sys-old", linkToAnyApplication: "app-old" });
  });

  it("prefers the new name when both are set", () => {
    process.env.LINKTOANY_SYSTEM_ID = "sys-new";
    process.env.LINKTOANY_SQUARE_SYSTEM_ID = "sys-old";
    expect(loadConfig().linkToAnySystemId).toBe("sys-new");
  });

  it("names the generic variable when no system is configured", () => {
    expect(() => loadConfig()).toThrow(/LINKTOANY_SYSTEM_ID/);
  });
});

describe("connectedAccountId", () => {
  it("honours the account while the session matches the configured system", () => {
    configState.systemId = "sys-a";
    expect(connectedAccountId({ linkToAnyAccountId: "acct", systemId: "sys-a" })).toBe("acct");
  });

  it("drops a session connected to a different system", () => {
    configState.systemId = "sys-b";
    expect(connectedAccountId({ linkToAnyAccountId: "acct", systemId: "sys-a" })).toBeUndefined();
  });

  it("drops a session that predates system tracking", () => {
    configState.systemId = "sys-a";
    expect(connectedAccountId({ linkToAnyAccountId: "acct" })).toBeUndefined();
  });

  it("is empty for an empty session", () => {
    expect(connectedAccountId({})).toBeUndefined();
  });
});
