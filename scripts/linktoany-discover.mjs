// Discovery script for any system on the Unified API.
//
//   npm run linktoany:discover                 # list the systems on the platform
//   npm run linktoany:discover -- clover       # list systems whose name contains "clover"
//   LINKTOANY_SYSTEM_ID=<id> npm run linktoany:discover
//                                              # describe one system: how it connects,
//                                              # which unified entities it supports and
//                                              # whether this demo's POS flow applies
//
// Read-only: it never creates, changes or deletes anything.

import { LinkToAny } from "@linktoany/sdk";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const client = new LinkToAny({
  apiKey: requireEnv("LINKTOANY_API_KEY"),
  environment: process.env.LINKTOANY_ENVIRONMENT ?? "dev",
  organisationId: process.env.LINKTOANY_ORGANISATION_ID || undefined,
});

console.log(`Base URL: ${client.baseUrl}`);
console.log("Health:", await client.health());

const systemId = process.env.LINKTOANY_SYSTEM_ID || process.env.LINKTOANY_SQUARE_SYSTEM_ID;

if (!systemId) {
  const filter = process.argv[2]?.toLowerCase();
  const systems = (await client.integrations.listAll({ status: "active" })).filter(
    (system) => !filter || system.name?.toLowerCase().includes(filter)
  );
  console.log(`\n${systems.length} active system(s)${filter ? ` matching "${filter}"` : ""}:`);
  for (const system of systems) {
    console.log(
      `- ${system.name} | systemId: ${system._id} | auth: ${(system.supportedAuthTypes ?? []).join(", ") || "?"}`
    );
  }
  console.log("\nSet LINKTOANY_SYSTEM_ID to one of the ids above and re-run to describe it.");
  process.exit(0);
}

const { data: integration } = await client.integrations.get(systemId);
console.log(`\n=== ${integration.name} (${systemId}) ===`);
console.log("Supported auth types:", integration.supportedAuthTypes);

console.log("\n=== How it connects ===");
try {
  const requirements = await client.auth.getLinkRequirements(systemId);
  console.log("mode:", requirements.mode, "| auth type:", requirements.authType, "| application:", requirements.application);
  console.log(
    "fields:",
    requirements.requiredFields.map((field) => `${field.sourceField}${field.isUnique ? " (unique)" : ""}`)
  );
  console.log("credential sets:", requirements.availableApplications.map((app) => app.application));
} catch (err) {
  console.log(
    "Cannot connect yet:",
    err.message,
    "\n(The Unified API has no shared default credential set - register one for this system under Client credentials in the LinkToAny dashboard.)"
  );
}

console.log("\n=== Unified entities (from contracts) ===");
const { data: contracts } = await client.entities.list({ systemIds: [systemId] });
const enabled = (mappings) => (mappings ?? []).some((m) => m.systemId === systemId && m.enabled !== false);
const entities = contracts
  .map((contract) => ({
    entityType: contract.entityType,
    read: enabled(contract.readMappings),
    write: enabled(contract.writeMappings),
  }))
  .filter((entity) => entity.read || entity.write)
  .sort((a, b) => a.entityType.localeCompare(b.entityType));
if (entities.length === 0) {
  console.log("none - this system has no unified contracts yet, so only raw operations exist (see below).");
}
for (const entity of entities) {
  console.log(`- ${entity.entityType}: ${[entity.read && "read", entity.write && "write"].filter(Boolean).join(", ")}`);
}

const find = (entityType) => entities.find((entity) => entity.entityType === entityType);
console.log("\n=== Does this demo's flow apply? ===");
console.log("POS screens (item read + order write):", Boolean(find("item")?.read && find("order")?.write));
console.log("Orders list (order read):", Boolean(find("order")?.read));
console.log("Payments (payment write):", Boolean(find("payment")?.write));

console.log("\n=== docs.describeIntegration: raw entities and filters ===");
const docs = await client.docs.describeIntegration(systemId);
if (docs.warnings.length > 0) console.log("Warnings:", docs.warnings);
for (const entity of docs.entities) {
  console.log(
    `- ${entity.entityType} | readable: ${entity.readable} | writable: ${entity.writable} | filters: ${
      entity.filters.map((f) => `${f.paramName} (${f.type})`).join(", ") || "none"
    }`
  );
}

console.log("\n=== Unified contract schemas for the entities the POS flow uses ===");
for (const entityType of ["item", "order", "payment"]) {
  const contract = contracts.find((c) => c.entityType === entityType);
  console.log(`\n[${entityType}]`, contract ? `\n${contract.unifiedZodSchema}` : "no contract for this system");
}
