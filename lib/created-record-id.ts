// Finds the platform's own id for a record in a unified create response.
//
// The response wraps the provider's reply, and its shape follows the provider:
// Square nests the order under `data[0].data.order.id` (confirmed live), other
// systems may return `data[0].data.id`, `data[0].id` or a bare object. The
// known shapes are tried in order; an unknown shape returns undefined so the
// caller can decide what to do rather than guessing an id.

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

function idOf(value: unknown): string | undefined {
  const id = asObject(value)?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function extractCreatedRecordId(response: unknown, entityKey: string): string | undefined {
  const first = Array.isArray(response) ? response[0] : response;
  const entry = asObject(first);
  if (!entry) return undefined;
  const payload = asObject(entry.data);

  return (
    idOf(asObject(payload?.[entityKey])) ??
    idOf(payload) ??
    idOf(asObject(entry[entityKey])) ??
    idOf(entry)
  );
}
