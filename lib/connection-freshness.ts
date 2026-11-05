import { ValidationError } from "@/lib/errors";

// Allowance for clock skew between this server and LinkToAny's.
export const CONNECTION_CLOCK_SKEW_MS = 2 * 60 * 1000;

// Throws unless the most recent of the given timestamps is at or after the
// moment this OAuth flow started (minus clock skew). Unparseable or missing
// timestamps are ignored; if none are usable the check fails closed.
export function assertConnectionIsFresh(
  timestamps: Array<string | undefined>,
  flowStartedAt: Date
): void {
  const latest = Math.max(
    ...timestamps
      .map((value) => (value ? new Date(value).getTime() : NaN))
      .filter((ms) => Number.isFinite(ms)),
    -Infinity
  );
  if (!Number.isFinite(latest)) {
    throw new ValidationError("Account has no authorization timestamp to verify against");
  }
  if (latest < flowStartedAt.getTime() - CONNECTION_CLOCK_SKEW_MS) {
    throw new ValidationError("Account was not (re)authorized during this connection attempt");
  }
}
