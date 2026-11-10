// Some systems (Square, confirmed live) return unified order reads oldest
// first, and a busy (or heavily tested) merchant can have hundreds of orders
// in a month - so "the first page" is the oldest orders, not the newest. The read is bounded with
// `since` instead, starting with a narrow window and widening only until
// there are enough records to fill the list.

export interface RecordsPage<T> {
  data: T[];
  pagination?: { cursor?: string | null; hasMore?: boolean };
}

export type FetchRecordsPage<T> = (query: {
  since: string;
  pageSize: number;
  cursor?: string;
}) => Promise<RecordsPage<T>>;

export interface RecentRecordsOptions {
  limit: number;
  windowsInDays: number[];
  pageSize: number;
  maxPagesPerWindow: number;
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function collectRecentRecords<T extends { createdAt?: string }>(
  fetchPage: FetchRecordsPage<T>,
  options: RecentRecordsOptions
): Promise<{ records: T[]; truncated: boolean }> {
  const now = (options.now ?? new Date()).getTime();
  let records: T[] = [];
  let truncated = false;

  for (const days of options.windowsInDays) {
    const since = new Date(now - days * DAY_MS).toISOString();
    records = [];
    truncated = false;
    let cursor: string | undefined;
    for (let page = 0; page < options.maxPagesPerWindow; page++) {
      const result = await fetchPage({ since, pageSize: options.pageSize, cursor });
      records.push(...result.data);
      cursor = result.pagination?.hasMore ? (result.pagination.cursor ?? undefined) : undefined;
      if (!cursor) break;
    }
    // Still more pages: this window alone holds more than we're willing to
    // read, so widening further can only make that worse.
    if (cursor) {
      truncated = true;
      break;
    }
    if (records.length >= options.limit) break;
  }

  records.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return { records: records.slice(0, options.limit), truncated };
}
