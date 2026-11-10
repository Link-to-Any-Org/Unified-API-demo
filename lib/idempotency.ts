// Ids derived from the client's idempotency key, so a retried request (same
// key) reuses the same id for every record it writes. The Unified API treats
// `externalId` as the idempotency key on `records.create`, so a deterministic
// id turns a retry into an upsert of the same record instead of a second
// write - which for a payment would be a second real capture.
export function paymentExternalIdFor(idempotencyKey: string): string {
  return `${idempotencyKey}:payment`;
}

export function lineItemExternalIdFor(orderExternalId: string, index: number): string {
  return `${orderExternalId}:line:${index}`;
}
