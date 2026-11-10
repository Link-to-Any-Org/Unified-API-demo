import { cacheLife, cacheTag } from "next/cache";
import { LinkToAny, type Account } from "@linktoany/sdk";
import { getConfig } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { roundToCurrencyPrecision, DEFAULT_CURRENCY } from "@/lib/currency";
import { assertConnectionIsFresh } from "@/lib/connection-freshness";
import {
  accountSystemId,
  assertAccountOnSystem,
  pickMostRecentlyAuthorized,
} from "@/lib/account-selection";
import { collectRecentRecords } from "@/lib/recent-records";
import { lineItemExternalIdFor } from "@/lib/idempotency";
import { logger } from "@/lib/logger";
import {
  assertLineItemCount,
  assertValidQuantity,
  computeOrderTotal,
  type RequestedLineItem,
} from "@/lib/order-math";

let client: LinkToAny | undefined;

export function getLinkToAnyClient(): LinkToAny {
  if (!client) {
    const config = getConfig();
    client = new LinkToAny({
      apiKey: config.linkToAnyApiKey,
      environment: config.linkToAnyEnvironment,
      organisationId: config.linkToAnyOrganisationId,
    });
  }
  return client;
}

export function getReturnUrl(): string {
  return getConfig().linkToAnyReturnUrl;
}

export interface ConnectLinkResult {
  accountLinkUrl: string;
}

let squareCredentialId: Promise<string | undefined> | undefined;

// Maps LINKTOANY_SQUARE_APPLICATION (a credential-set name) to its id, once
// per process. Unset means "let LinkToAny choose". A name that doesn't exist
// is a configuration error, not something to silently fall back from - the
// fallback set may be a different (possibly broken) Square app.
function resolveSquareCredentialId(): Promise<string | undefined> {
  const { linkToAnySquareApplication: application, linkToAnySquareSystemId: systemId } = getConfig();
  if (!application) return Promise.resolve(undefined);
  squareCredentialId ??= getLinkToAnyClient()
    .credentials.list({ systemId })
    .then(({ data }) => {
      const match = data.find((set) => set.application === application);
      if (!match) {
        const available = data.map((set) => set.application).join(", ") || "none";
        throw new Error(
          `LINKTOANY_SQUARE_APPLICATION "${application}" is not a Square credential set on this organisation (available: ${available})`
        );
      }
      return match._id;
    })
    .catch((err) => {
      // Don't cache a failure (e.g. a transient network error).
      squareCredentialId = undefined;
      throw err;
    });
  return squareCredentialId;
}

// Square connects through LinkToAny's own OAuth callback (the redirect URI
// registered with Square), not the credential set's callback that
// `auth.connectAccount` would use - the SDK itself recommends
// `createConnectLink` for Square/Clover/Lightspeed/Shopify for this reason.
// `state` is appended to successUrl as a path segment, not a query param:
// LinkToAny appends its own `?accountId=...` to whatever successUrl we give
// it, and a path segment stays intact however that merge is done - see
// docs/square-integration-notes.md.
export async function createSquareConnectLink(
  successUrl: string,
  state: string
): Promise<ConnectLinkResult> {
  const config = getConfig();
  const clientCredentialId = await resolveSquareCredentialId();
  const link = await getLinkToAnyClient().auth.createConnectLink(
    config.linkToAnySquareSystemId,
    {
      successUrl: `${successUrl.replace(/\/$/, "")}/${encodeURIComponent(state)}`,
      ...(clientCredentialId ? { clientCredentialId } : {}),
    }
  );
  if (link.mode !== "oauth_redirect") {
    throw new Error(`Expected an oauth_redirect connect link for Square, got mode "${link.mode}"`);
  }
  return { accountLinkUrl: link.accountLinkUrl };
}

export async function findSquareAccountForMerchant(
  merchantId: string
): Promise<Account | undefined> {
  const config = getConfig();
  const { data } = await getLinkToAnyClient().accounts.listByMerchant(merchantId);
  const matches = data.filter(
    (account) => accountSystemId(account) === config.linkToAnySquareSystemId
  );
  return pickMostRecentlyAuthorized(matches);
}

export interface VerifiedConnection {
  account: Account;
  merchantName?: string;
  currencyCode: string;
}

// Confirms the account the callback resolved is genuinely the one this flow
// started: it is a Square account on the configured system, its platform
// merchant id matches what the callback reported, it was (re)authorized
// after the flow began (not a stale connection), and LinkToAny itself
// reports the connection active. The callback's query string is under the
// merchant's control, so every check here applies whichever parameter the
// account was found by.
export async function verifySquareConnection(
  account: Account,
  expectedMerchantId: string | undefined,
  flowStartedAt: Date
): Promise<VerifiedConnection> {
  assertAccountOnSystem(account, getConfig().linkToAnySquareSystemId);

  if (expectedMerchantId && account.merchantId !== expectedMerchantId) {
    throw new ValidationError(
      `Account merchant id (${account.merchantId}) does not match the callback's merchant id (${expectedMerchantId})`
    );
  }

  const status = await getLinkToAnyClient().auth.getStatus(account._id);
  if (!status.data.isAuthenticated) {
    throw new ValidationError(`Account is not active (status: ${status.data.status})`);
  }

  // A merchant reconnecting may get their existing LinkToAny account
  // re-authorized rather than a new one created, so `createdAt` alone would
  // reject every reconnect. `lastAuthAt` is LinkToAny's own record of the
  // authorization this flow just completed, so when it is present it is the
  // only timestamp that counts; `updatedAt` also moves on unrelated changes
  // (a background token refresh, for one), so it and `createdAt` are only a
  // fallback for an account that reports no lastAuthAt at all.
  assertConnectionIsFresh(
    status.data.lastAuthAt ? [status.data.lastAuthAt] : [account.updatedAt, account.createdAt],
    flowStartedAt
  );

  // `externalAccountInfo` only holds the OAuth token response for Square, so
  // display name and currency come from the unified `location` entity.
  const location = await getPrimaryLocation(account._id);
  if (!location?.currency) {
    logger.warn("square.connect.currency_defaulted", {
      accountId: account._id,
      currencyCode: DEFAULT_CURRENCY,
    });
  }

  return {
    account,
    merchantName: location?.name ?? account.name,
    currencyCode: location?.currency ?? DEFAULT_CURRENCY,
  };
}

interface RawLocation {
  name?: string;
  currency?: string;
  status?: string;
}

// Best effort: a failed lookup falls back to defaults rather than failing an
// otherwise verified connection - but it is logged, because the fallback
// currency is wrong for every non-USD merchant.
async function getPrimaryLocation(accountId: string): Promise<RawLocation | undefined> {
  try {
    const { data } = await getLinkToAnyClient().records.list<RawLocation>(accountId, "location", {
      pageSize: 10,
    });
    return data.find((location) => location.status === "ACTIVE") ?? data[0];
  } catch (err) {
    logger.warn("square.location.lookup_failed", { accountId, err });
    return undefined;
  }
}

export async function disconnectAccount(accountId: string): Promise<void> {
  await getLinkToAnyClient().accounts.delete(accountId);
}

// Confirmed live against this Square integration's current contracts - see
// docs/square-integration-notes.md for the full record.
const ITEM_ENTITY_TYPE = "item";
const ORDER_ENTITY_TYPE = "order";
const PAYMENT_ENTITY_TYPE = "payment";
const CATEGORY_ENTITY_TYPE = "category";

export interface CatalogItemVariation {
  id: string;
  name?: string;
  sku?: string;
  price?: number;
}

export interface CatalogItem {
  id: string;
  name: string;
  description?: string;
  // Raw, unresolved category links - see resolveItemCategory() for why this
  // isn't safe to index into positionally.
  categoryExternalIds: string[];
  variations: CatalogItemVariation[];
}

interface RawVariation {
  externalId?: string;
  name?: string;
  sku?: string;
  price?: number;
}

interface RawItem {
  externalId?: string;
  name?: string;
  description?: string;
  categoryExternalIds?: string[];
  variations?: RawVariation[];
  [key: string]: unknown;
}

// An item or variation with no externalId is bad upstream data, not
// something to paper over with a generated id - a made-up id can never be
// referenced again on a later read, so it's silently dropped instead.
function normalizeCatalogItem(raw: RawItem): CatalogItem | undefined {
  if (!raw.externalId) return undefined;
  const variations = (raw.variations ?? []).flatMap((v): CatalogItemVariation[] =>
    v.externalId
      ? [{ id: v.externalId, name: v.name, sku: v.sku, price: typeof v.price === "number" ? v.price : undefined }]
      : []
  );
  return {
    id: raw.externalId,
    name: raw.name ?? "Untitled item",
    description: raw.description,
    categoryExternalIds: raw.categoryExternalIds ?? [],
    variations,
  };
}

export async function listCatalogItems(accountId: string): Promise<CatalogItem[]> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`catalog-items:${accountId}`);

  const items: CatalogItem[] = [];
  let dropped = 0;
  for await (const raw of getLinkToAnyClient().records.iterate<RawItem>(
    accountId,
    ITEM_ENTITY_TYPE,
    { pageSize: 100 }
  )) {
    const item = normalizeCatalogItem(raw);
    if (item) items.push(item);
    else dropped += 1;
  }
  if (dropped > 0) {
    // Otherwise a catalog that comes back without ids looks like an empty
    // merchant, with nothing in the logs to say why.
    logger.warn("square.catalog.items_without_external_id", { accountId, dropped, kept: items.length });
  }
  return items;
}

// Square's menu categories (see docs/square-integration-notes.md) can nest
// under a parent that has no REGULAR-category equivalent.
export type CategoryUsage = "REGULAR" | "MENU" | "KITCHEN";

export interface CategoryInfo {
  name: string;
  categoryType?: CategoryUsage;
  parentExternalId?: string;
}

interface RawCategory {
  externalId?: string;
  name?: string;
  categoryType?: CategoryUsage;
  parentExternalId?: string;
}

export async function listCategories(accountId: string): Promise<Map<string, CategoryInfo>> {
  "use cache";
  cacheLife("minutes");
  cacheTag(`catalog-categories:${accountId}`);

  const categories = new Map<string, CategoryInfo>();
  for await (const raw of getLinkToAnyClient().records.iterate<RawCategory>(
    accountId,
    CATEGORY_ENTITY_TYPE,
    { pageSize: 100 }
  )) {
    if (raw.externalId && raw.name) {
      categories.set(raw.externalId, {
        name: raw.name,
        categoryType: raw.categoryType,
        parentExternalId: raw.parentExternalId,
      });
    }
  }
  return categories;
}

// Picks the category id matching the requested usage instead of reading
// categoryExternalIds[0] - see docs/square-integration-notes.md.
export function resolveItemCategory(
  categoryExternalIds: string[],
  categories: Map<string, CategoryInfo>,
  usage: CategoryUsage = "REGULAR"
): string | undefined {
  const preferred = categoryExternalIds.find(
    (id) => categories.get(id)?.categoryType === usage
  );
  return preferred ?? categoryExternalIds[0];
}

export { MAX_LINE_ITEMS, MAX_QUANTITY_PER_LINE, type RequestedLineItem } from "@/lib/order-math";

export interface ResolvedLineItem {
  variationExternalId: string;
  name: string;
  quantity: number;
  unitPrice: number;
}

// Server-side pricing: the client names a variation and a quantity, nothing
// else. Name and price always come from the account's own catalog, never
// from the request body, so a tampered client payload can't change what's
// charged.
export async function resolveOrderLineItems(
  accountId: string,
  currencyCode: string,
  requested: RequestedLineItem[]
): Promise<ResolvedLineItem[]> {
  assertLineItemCount(requested);

  const items = await listCatalogItems(accountId);
  const variationIndex = new Map<string, { name: string; price: number }>();
  for (const item of items) {
    for (const variation of item.variations) {
      if (typeof variation.price !== "number") continue;
      const name = variation.name ? `${item.name} (${variation.name})` : item.name;
      variationIndex.set(variation.id, { name, price: variation.price });
    }
  }

  return requested.map((line) => {
    assertValidQuantity(line.quantity, line.variationExternalId);
    const match = variationIndex.get(line.variationExternalId);
    if (!match) {
      throw new ValidationError(`Unknown or unpriced variation: ${line.variationExternalId}`);
    }
    return {
      variationExternalId: line.variationExternalId,
      name: match.name,
      quantity: line.quantity,
      unitPrice: roundToCurrencyPrecision(match.price, currencyCode),
    };
  });
}

export interface CreatedOrder {
  id: string;
  total: number;
  currencyCode: string;
}

interface RawSquareOrderWriteResult {
  data?: {
    order?: { id?: string };
  };
}

// `externalId` is the client-supplied idempotency key, reused as-is so a
// retried request (e.g. after a dropped response) doesn't create a second
// order for the same checkout attempt.
export async function createOrder(
  accountId: string,
  externalId: string,
  lineItems: ResolvedLineItem[],
  currencyCode: string
): Promise<CreatedOrder> {
  const total = computeOrderTotal(lineItems, currencyCode);

  const result = await getLinkToAnyClient().records.create(accountId, ORDER_ENTITY_TYPE, {
    externalId,
    currencyCode,
    status: "OPEN",
    // The note lands in the merchant's Square dashboard, so it must say what
    // actually happened: with payment writes off there is no tender at all.
    note: getConfig().paymentWritesEnabled
      ? "Demo POS order - simulated cash tender, see README"
      : "Demo POS order - no payment recorded, see README",
    // Line ids derive from the order's idempotency key too, so a retried
    // request upserts the same lines instead of adding a second set.
    lineItems: lineItems.map((item, index) => ({
      externalId: lineItemExternalIdFor(externalId, index),
      variationExternalId: item.variationExternalId,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      currencyCode,
    })),
    totals: { total },
  });

  const entries = result.data as RawSquareOrderWriteResult[] | undefined;
  const orderId = entries?.[0]?.data?.order?.id;
  if (!orderId) {
    throw new Error("Order create succeeded but no order id was returned");
  }
  return { id: orderId, total, currencyCode };
}

// Always a simulated cash tender - see docs/square-integration-notes.md for
// why every payment this integration writes is an immediate, irreversible
// real capture against the connected Square account.
// `paymentExternalId` is fixed by the caller (and reused on retry) so a retry
// after an ambiguous failure can't create a second capture for the same order.
// Only called when ENABLE_PAYMENT_WRITES is on - see lib/config.ts.
export async function createOrderPayment(
  accountId: string,
  orderExternalId: string,
  paymentExternalId: string,
  amount: number,
  currency: string
): Promise<void> {
  if (!getConfig().paymentWritesEnabled) {
    throw new Error("Payment writes are disabled (ENABLE_PAYMENT_WRITES is not \"true\")");
  }
  await getLinkToAnyClient().records.create(accountId, PAYMENT_ENTITY_TYPE, {
    externalId: paymentExternalId,
    orderExternalId,
    status: "CAPTURED",
    tenderCategory: "CASH",
    amount,
    currency,
  });
}

export interface OrderLineItemSummary {
  name?: string;
  quantity?: number;
}

export interface OrderSummary {
  id: string;
  status?: string;
  createdAt?: string;
  total?: number;
  currencyCode?: string;
  lineItems: OrderLineItemSummary[];
}

interface RawOrder {
  externalId?: string;
  status?: string;
  createdAt?: string;
  totals?: { total?: number; currency?: string };
  lineItems?: Array<{ name?: string; quantity?: number }>;
}

export const RECENT_ORDERS_LIMIT = 20;
export const RECENT_ORDERS_MAX_DAYS = 30;

// Square returns orders oldest first, so a plain first page shows the
// merchant's oldest orders. Read by `since` instead - see lib/recent-records.ts.
export async function listRecentOrders(accountId: string): Promise<OrderSummary[]> {
  const { records, truncated } = await collectRecentRecords<RawOrder>(
    ({ since, pageSize, cursor }) =>
      getLinkToAnyClient().records.list<RawOrder>(accountId, ORDER_ENTITY_TYPE, {
        since,
        pageSize,
        ...(cursor ? { cursor } : {}),
      }),
    {
      limit: RECENT_ORDERS_LIMIT,
      windowsInDays: [1, 7, RECENT_ORDERS_MAX_DAYS],
      // The unified order contract's maximum page size for Square.
      pageSize: 200,
      maxPagesPerWindow: 5,
    }
  );
  if (truncated) {
    logger.warn("square.orders.list_truncated", { accountId });
  }
  return records
    .filter((order): order is RawOrder & { externalId: string } => Boolean(order.externalId))
    .map(
      (order): OrderSummary => ({
        id: order.externalId,
        status: order.status,
        createdAt: order.createdAt,
        total: order.totals?.total,
        currencyCode: order.totals?.currency,
        lineItems: (order.lineItems ?? []).map((item) => ({
          name: item.name,
          quantity: item.quantity,
        })),
      })
    )
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}
