import { describe, expect, it } from "vitest";
import type { LinkRequirements, UnifiedContract } from "@linktoany/sdk";
import {
  deriveCapabilities,
  entityCapabilities,
  isSecretField,
  planFromRequirements,
} from "@/lib/system-capabilities";

const SYSTEM = "sys-a";
const OTHER = "sys-b";

function contract(
  entityType: string,
  read: Array<{ systemId: string; enabled?: boolean }>,
  write: Array<{ systemId: string; enabled?: boolean }>
): UnifiedContract {
  return {
    entityType,
    unifiedZodSchema: "",
    readMappings: read.map((m) => ({ key: "r", sourceEntityType: entityType, ...m })),
    writeMappings: write.map((m) => ({ key: "w", targetEntityType: entityType, ...m })),
  };
}

describe("entityCapabilities", () => {
  it("reports read/write per system from the enabled mappings", () => {
    const result = entityCapabilities(
      [
        contract("order", [{ systemId: SYSTEM }], [{ systemId: SYSTEM }]),
        contract("location", [{ systemId: SYSTEM }], []),
      ],
      SYSTEM
    );
    expect(result).toEqual([
      { entityType: "location", read: true, write: false },
      { entityType: "order", read: true, write: true },
    ]);
  });

  it("ignores mappings that belong to another system", () => {
    const result = entityCapabilities(
      [contract("order", [{ systemId: OTHER }], [{ systemId: OTHER }])],
      SYSTEM
    );
    expect(result).toEqual([]);
  });

  it("ignores disabled mappings but treats a missing flag as enabled", () => {
    const result = entityCapabilities(
      [
        contract("item", [{ systemId: SYSTEM, enabled: false }], []),
        contract("payment", [], [{ systemId: SYSTEM }]),
      ],
      SYSTEM
    );
    expect(result).toEqual([{ entityType: "payment", read: false, write: true }]);
  });
});

describe("deriveCapabilities", () => {
  it("offers the POS only with a readable catalog and a writable order", () => {
    expect(
      deriveCapabilities([
        { entityType: "item", read: true, write: false },
        { entityType: "order", read: true, write: true },
      ]).pos
    ).toBe(true);
    expect(
      deriveCapabilities([
        { entityType: "item", read: true, write: false },
        { entityType: "order", read: true, write: false },
      ]).pos
    ).toBe(false);
    expect(deriveCapabilities([{ entityType: "order", read: true, write: true }]).pos).toBe(false);
  });

  it("derives order listing and payments independently", () => {
    const caps = deriveCapabilities([
      { entityType: "order", read: true, write: false },
      { entityType: "payment", read: false, write: true },
    ]);
    expect(caps).toEqual({ pos: false, listOrders: true, payments: true });
  });

  it("offers nothing for a system with no unified entities", () => {
    expect(deriveCapabilities([])).toEqual({ pos: false, listOrders: false, payments: false });
  });
});

describe("isSecretField", () => {
  it.each(["personalToken", "apiKey", "clientSecret", "password", "access_token"])(
    "masks %s",
    (name) => expect(isSecretField(name)).toBe(true)
  );
  it.each(["merchantId", "shopDomain", "accountId", "region"])("leaves %s visible", (name) =>
    expect(isSecretField(name)).toBe(false)
  );
});

describe("planFromRequirements", () => {
  const base = {
    systemId: SYSTEM,
    systemName: "Demo",
    authType: "noauth",
    clientCredentialId: "cred",
    application: "demo-app",
    availableApplications: [],
  };

  it("plans a hosted-consent connect for oauth systems", () => {
    const plan = planFromRequirements({
      ...base,
      mode: "oauth_redirect",
      requiredFields: [{ name: "accountId", sourceField: "accountId", isUnique: true }],
    } satisfies LinkRequirements);
    expect(plan).toEqual({ mode: "oauth_redirect", application: "demo-app" });
  });

  it("plans a credential form for direct-auth systems, masking secrets", () => {
    const plan = planFromRequirements({
      ...base,
      mode: "form",
      requiredFields: [
        { name: "merchantId", sourceField: "merchantId", label: "Merchant ID", isUnique: true },
        { name: "token", sourceField: "personalToken" },
      ],
    } satisfies LinkRequirements);
    expect(plan).toMatchObject({ mode: "form", application: "demo-app" });
    if (plan.mode !== "form") throw new Error("expected a form plan");
    expect(plan.fields).toEqual([
      expect.objectContaining({ sourceField: "merchantId", label: "Merchant ID", secret: false, isUnique: true }),
      expect.objectContaining({ sourceField: "personalToken", label: "personalToken", secret: true, isUnique: false }),
    ]);
  });

  it("prefers the configured application over the one LinkToAny resolved", () => {
    const plan = planFromRequirements(
      { ...base, mode: "oauth_redirect", requiredFields: [] },
      "my-app"
    );
    expect(plan).toEqual({ mode: "oauth_redirect", application: "my-app" });
  });
});
