import { randomUUID } from "crypto";
import { cacheLife, cacheTag } from "next/cache";
import { LinkToAny, type Account } from "@linktoany/sdk";
import { getConfig } from "@/lib/config";
import { ValidationError } from "@/lib/errors";
import { roundToCurrencyPrecision, resolveLocale, DEFAULT_CURRENCY } from "@/lib/currency";
import { assertConnectionIsFresh } from "@/lib/connection-freshness";
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
  const link = await getLinkToAnyClient().auth.createConnectLink(
    config.linkToAnySquareSystemId,
    {
      successUrl: `${successUrl.replace(/\/$/, "")}/${encodeURIComponent(state)}`,
    }
  );
  if (link.mode !== "oauth_redirect") {
    throw new Error(`Expected an oauth_redirect connect link for Square, got mode "${link.mode}"`);
  }
  return { accountLinkUrl: link.accountLinkUrl };
}

function accountSystemId(account: Account): string | undefined {
  const raw = account.systemId as unknown;
  if (typeof raw === "string") return raw;
  return (raw as { _id?: string } | undefined)?._id;
}

export async function findSquareAccountForMerchant(
  merchantId: string
): Promise<Account | undefined> {
  const config = getConfig();
  const { data } = await getLinkToAnyClient().accounts.listByMerchant(merchantId);
  const matches = data.filter(
    (account) => accountSystemId(account) === config.linkToAnySquareSystemId
  );
  matches.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return matches[0];
}

export interface VerifiedConnection {
  account: Account;
  merchantName?: string;
  currencyCode: string;
  locale: string;
}

// Confirms the account the callback resolved is genuinely the one this flow
// started: its platform merchant id matches what the callback reported, it
// was (re)authorized after the flow began (not a stale connection), and
// LinkToAny itself reports the connection active.
export async function verifySquareConnection(
  account: Account,
  expectedMerchantId: string | undefined,
  flowStartedAt: Date
): Promise<VerifiedConnection> {
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
  // reject every reconnect. Freshness is judged on the latest of
  // lastAuthAt / updatedAt / createdAt instead.
  assertConnectionIsFresh(
    [status.data.lastAuthAt, account.updatedAt, account.createdAt],
    flowStartedAt
  );

  const info = account.externalAccountInfo as
    | {
        accounts?: {
          locations?: { business_name?: string; currency?: string; language_code?: string }[];
        };
      }
    | undefined;
  const location = info?.accounts?.locations?.[0];

  return {
    account,
    merchantName: account.name ?? location?.business_name,
    currencyCode: location?.currency ?? DEFAULT_CURRENCY,
    locale: resolveLocale(location?.language_code),
  };
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
  for await (const raw of getLinkToAnyClient().records.iterate<RawItem>(
    accountId,
    ITEM_ENTITY_TYPE,
    { pageSize: 100 }
  )) {
    const item = normalizeCatalogItem(raw);
    if (item) items.push(item);
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
    note: "Demo POS order - simulated tender, see README",
    lineItems: lineItems.map((item) => ({
      externalId: randomUUID(),
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

export async function listRecentOrders(accountId: string): Promise<OrderSummary[]> {
  const page = await getLinkToAnyClient().records.list<RawOrder>(accountId, ORDER_ENTITY_TYPE, {
    pageSize: 20,
  });
  return page.data
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
