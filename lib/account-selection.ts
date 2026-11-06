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
