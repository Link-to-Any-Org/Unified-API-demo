import { randomUUID } from "crypto";
import { LinkToAny, type Account, type LinkToAnyEnvironment } from "@linktoany/sdk";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

let client: LinkToAny | undefined;

export function getUniflowClient(): LinkToAny {
  if (!client) {
    const environment = (process.env.UNIFLOW_ENVIRONMENT ??
      "dev") as LinkToAnyEnvironment;
    client = new LinkToAny({
      apiKey: requireEnv("UNIFLOW_API_KEY"),
      environment,
      organisationId: process.env.UNIFLOW_ORGANISATION_ID || undefined,
    });
  }
  return client;
}

export function getSquareSystemId(): string {
  return requireEnv("UNIFLOW_SQUARE_SYSTEM_ID");
}

// Name of the registered OAuth client-credential set to connect through
// (not a generic slug - the server resolves actual Square client
// id/secret from this exact name, scoped to the current organisation).
export function getSquareApplicationSlug(): string {
  return requireEnv("UNIFLOW_SQUARE_APPLICATION");
}

export function getReturnUrl(): string {
  return requireEnv("UNIFLOW_RETURN_URL");
}

// Square is a "hosted-consent" platform on the Unified API: do NOT send our
// own merchantId (it would override the platform's real merchant id on the
// account); the callback instead carries Square's own merchant id as
// `external_id`, looked up afterwards via listByMerchant.
export async function connectSquareAccount() {
  return getUniflowClient().auth.connectAccount(
    getSquareSystemId(),
    getSquareApplicationSlug(),
    { successUrl: getReturnUrl(), failureUrl: getReturnUrl() }
  );
}

function accountSystemId(account: Account): string | undefined {
  const raw = account.systemId as unknown;
  if (typeof raw === "string") return raw;
  return (raw as { _id?: string } | undefined)?._id;
}

export async function findSquareAccountForMerchant(
  merchantId: string
): Promise<Account | undefined> {
  const systemId = getSquareSystemId();
  const { data } = await getUniflowClient().accounts.listByMerchant(
    merchantId
  );
  const matches = data.filter((account) => accountSystemId(account) === systemId);
  matches.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  return matches[0];
}

export async function disconnectAccount(accountId: string): Promise<void> {
  await getUniflowClient().accounts.delete(accountId);
}

// Confirmed live against this Square integration's current contracts
// (platform-side schema was updated under us during development - re-verify
// with `npm run uniflow:discover` / a direct records.* probe if things
// start 404ing with UNIFIED_CONTRACT_NOT_FOUND again).
const ITEM_ENTITY_TYPE = "item";
const ORDER_ENTITY_TYPE = "order";
const PAYMENT_ENTITY_TYPE = "payment";

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
  // Raw, unresolved category links from Square - an item is commonly linked
  // into more than one of these at once (see CategoryUsage below). Use
  // resolveItemCategory() to pick the right one for a given purpose rather
  // than reading this array positionally.
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

function normalizeCatalogItem(raw: RawItem): CatalogItem {
  return {
    id: raw.externalId ?? randomUUID(),
    name: raw.name ?? "Untitled item",
    description: raw.description,
    categoryExternalIds: raw.categoryExternalIds ?? [],
    variations: (raw.variations ?? []).map((v, index) => ({
      id: v.externalId ?? `variation-${index}`,
      name: v.name,
      sku: v.sku,
      price: typeof v.price === "number" ? v.price : undefined,
    })),
  };
}

export async function listCatalogItems(accountId: string): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  for await (const raw of getUniflowClient().records.iterate<RawItem>(
    accountId,
    ITEM_ENTITY_TYPE,
    { pageSize: 100 }
  )) {
    items.push(normalizeCatalogItem(raw));
  }
  return items;
}

const CATEGORY_ENTITY_TYPE = "category";

// Confirmed live against Square's own model (developer.squareup.com/docs/
// catalog-api/manage-menus): a merchant's catalog holds two independent
// category taxonomies, not one. REGULAR categories are created through the
// Catalog API and drive POS grouping and sales reporting. MENU categories
// are created by Square's menu builder (Dashboard / Online Ordering) and
// drive how items are organized on a public-facing menu; they can be nested
// under a parent/root menu category (`parentExternalId`) that has no
// REGULAR-category equivalent. KITCHEN exists in this unified schema for
// other POS integrations' kitchen-routing categories; Square itself has no
// such category type (kitchen routing there is the item-level `kitchenName`
// field instead), so it's included for type completeness only.
//
// An item commonly belongs to one REGULAR category *and* one MENU category
// at the same time (confirmed live: "Ice Cream" items here carry both a
// REGULAR "Ice Cream" and a MENU "Ice Cream" id). That's the real cause of
// "the same item maps to a different category depending on usage": there
// isn't one category to read, there are two parallel ones, and which one is
// "correct" depends on whether you're building a reporting/POS view or a
// menu/online-ordering view.
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

export async function listCategories(
  accountId: string
): Promise<Map<string, CategoryInfo>> {
  const categories = new Map<string, CategoryInfo>();
  for await (const raw of getUniflowClient().records.iterate<RawCategory>(
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

// Deterministically picks the category id matching the requested usage,
// instead of reading `categoryExternalIds[0]` (undefined behavior - Square
// does not guarantee or document an order for that array, so which usage
// "wins" there is incidental to API response order, not a real signal).
// Falls back to whatever id is present if none match the requested usage,
// so single-category items (or items whose category record has no
// `categoryType`, e.g. from an older/partial sync) still resolve to
// something rather than silently disappearing.
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

export interface CreateOrderLineItem {
  variationExternalId?: string;
  name?: string;
  quantity: number;
  unitPrice: number;
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

// Confirmed live required shape for the 'order' write contract: externalId,
// a status, each line item needs its own externalId, and a totals.total we
// compute ourselves (Square may still add its own tax on top).

export async function createOrder(
  accountId: string,
  lineItems: CreateOrderLineItem[],
  currencyCode = "USD"
): Promise<CreatedOrder> {
  const total = lineItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);

  const result = await getUniflowClient().records.create(accountId, ORDER_ENTITY_TYPE, {
    externalId: randomUUID(),
    currencyCode,
    status: "OPEN",
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

// Confirmed live required shape for the 'payment' write contract.

export async function createOrderPayment(
  accountId: string,
  orderExternalId: string,
  amount: number,
  currency: string
): Promise<void> {
  await getUniflowClient().records.create(accountId, PAYMENT_ENTITY_TYPE, {
    externalId: randomUUID(),
    orderExternalId,
    status: "CAPTURED",
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
  const page = await getUniflowClient().records.list<RawOrder>(accountId, ORDER_ENTITY_TYPE, {
    pageSize: 20,
  });
  return page.data.map((order) => ({
    id: order.externalId ?? "",
    status: order.status,
    createdAt: order.createdAt,
    total: order.totals?.total,
    currencyCode: order.totals?.currency,
    lineItems: (order.lineItems ?? []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
    })),
  }));
}
