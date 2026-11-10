import { ValidationError } from "@/lib/errors";

// When a merchant reconnects, LinkToAny re-authorizes one of their existing
// accounts instead of creating a new one (observed live: the account's
// `createdAt` stays put while `updatedAt` / `lastAuthAt` move to the
// reconnect time). A merchant can also have several accounts on the same
// system, so "newest createdAt" can pick an account this flow never touched.
// The account the flow just (re)authorized is the most recently updated one.
interface AccountTimestamps {
  createdAt?: string;
  updatedAt?: string;
}

function lastTouched(account: AccountTimestamps): number {
  const times = [account.updatedAt, account.createdAt]
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((ms) => Number.isFinite(ms));
  return times.length > 0 ? Math.max(...times) : -Infinity;
}

export function pickMostRecentlyAuthorized<T extends AccountTimestamps>(accounts: T[]): T | undefined {
  return [...accounts].sort((a, b) => lastTouched(b) - lastTouched(a))[0];
}

interface AccountSystemRef {
  systemId?: unknown;
}

// `systemId` comes back as a bare id from some endpoints and as the populated
// system document from others.
export function accountSystemId(account: AccountSystemRef): string | undefined {
  const raw = account.systemId;
  if (typeof raw === "string") return raw;
  return (raw as { _id?: string } | undefined)?._id;
}

// The callback can name any account id in the organisation, so before an
// account is trusted it has to be one of this integration's Square accounts,
// however it was looked up.
export function assertAccountOnSystem(account: AccountSystemRef, systemId: string): void {
  const actual = accountSystemId(account);
  if (actual !== systemId) {
    throw new ValidationError(
      `Account belongs to system ${actual ?? "(unknown)"}, not the configured Square system`
    );
  }
}
