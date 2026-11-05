// One-off discovery script: finds Square's systemId/application slug on the
// Unified API and prints the exact unified schema for the 'item' and
// 'order' entities, so the app's field mapping can be confirmed instead of
// guessed.
//
// Usage: npm run uniflow:discover

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
  apiKey: requireEnv("UNIFLOW_API_KEY"),
  environment: process.env.UNIFLOW_ENVIRONMENT ?? "dev",
  organisationId: process.env.UNIFLOW_ORGANISATION_ID || undefined,
});

console.log(`Base URL: ${client.baseUrl}`);
const health = await client.health();
console.log("Health:", health);

console.log("\n=== Paging through all integrations, looking for 'square' ===");
const allIntegrations = [];
for (let page = 1; page <= 50; page++) {
  const { data } = await client.integrations.list({ page, limit: 100 });
  if (data.length === 0) break;
  allIntegrations.push(...data);
  if (data.length < 100) break;
}
console.log(`Fetched ${allIntegrations.length} integrations total.`);

const matches = allIntegrations.filter((i) => i.name?.toLowerCase().includes("square"));
if (matches.length === 0) {
  console.log("No integration name contains 'square'. All names:");
  for (const integ of allIntegrations) {
    console.log(`- ${integ.name} | systemId: ${integ._id} | applicationSlug: ${integ.applicationSlug}`);
  }
} else {
  for (const integ of matches) {
    console.log(JSON.stringify(integ, null, 2));
  }
}

const systemId = process.env.UNIFLOW_SQUARE_SYSTEM_ID || matches[0]?._id;
if (!systemId) {
  console.log("\nSet UNIFLOW_SQUARE_SYSTEM_ID (from the list above) and re-run to see entity docs.");
  process.exit(0);
}

console.log(`\n=== docs.describeIntegration(${systemId}) ===`);
const docs = await client.docs.describeIntegration(systemId);
console.log("Integration:", docs.integration?.name, docs.integration?.supportedAuthTypes);
if (docs.warnings.length > 0) {
  console.log("Warnings:", docs.warnings);
}
for (const entity of docs.entities) {
  console.log(
    `\n- entityType: ${entity.entityType} | readable: ${entity.readable} | writable: ${entity.writable}`
  );
  console.log("  filters:", entity.filters.map((f) => `${f.paramName} (${f.type})`));
}

console.log("\n=== Unified entity contracts (schemas) for 'item' and 'order' ===");
const { data: contracts } = await client.entities.list({ systemIds: [systemId] });
for (const entityType of ["item", "order"]) {
  const contract = contracts.find((c) => c.entityType === entityType);
  if (!contract) {
    console.log(`\n[${entityType}] No contract found for this systemId.`);
    continue;
  }
  console.log(`\n[${entityType}] unifiedZodSchema:\n${contract.unifiedZodSchema}`);
  console.log(`[${entityType}] readMappings:`, contract.readMappings);
  console.log(`[${entityType}] writeMappings:`, contract.writeMappings);
}

console.log("\n=== Raw read operations for this systemId ===");
const { data: readOps } = await client.integrations.listReadOperations({ systemId });
for (const op of readOps) {
  console.log(`- entityType: ${op.entityType} | name: ${op.name} | ${op.description ?? ""}`);
}

console.log("\n=== Raw write operations for this systemId ===");
const { data: writeOps } = await client.integrations.listWriteOperations({ systemId });
for (const op of writeOps) {
  console.log(`- entityType: ${op.entityType} | action: ${op.action} | name: ${op.name} | ${op.description ?? ""}`);
}

console.log("\n=== Full detail for catalog_item / order / payment write operations ===");
for (const entityType of ["catalog_item", "order", "payment"]) {
  const op = writeOps.find((o) => o.entityType === entityType);
  if (!op) {
    console.log(`\n[${entityType}] no write operation found.`);
    continue;
  }
  const { data: detail } = await client.integrations.getWriteOperation(op._id);
  console.log(`\n[${entityType}]`, JSON.stringify(detail, null, 2));
}

console.log("\n=== Schema templates / Zod schemas for catalog_item, order, payment ===");
for (const entityType of ["catalog_item", "order", "payment"]) {
  const { data: template } = await client.integrations.getSchemaTemplates({ entityType });
  console.log(`\n[${entityType}] schema template:`, JSON.stringify(template, null, 2));
  const { data: zod } = await client.integrations.getZodSchemas({ entityType });
  console.log(`[${entityType}] zod schema:`, JSON.stringify(zod, null, 2));
}
