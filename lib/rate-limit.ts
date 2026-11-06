// In-memory only - resets on redeploy/restart and isn't shared across
// instances. Good enough to blunt accidental double-submits and basic abuse
// on a single-instance demo; a real deployment needs a shared store.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

const hits = new Map<string, { count: number; windowStart: number }>();

export function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(key, { count: 1, windowStart: now });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_REQUESTS_PER_WINDOW;
}
