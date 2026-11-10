import { cacheLife, cacheTag } from "next/cache";
import { LinkToAny, ValidationError as SdkValidationError, type Account } from "@linktoany/sdk";
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
import { extractCreatedRecordId } from "@/lib/created-record-id";
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

let credentialId: Promise<string | undefined> | undefined;

// Maps LINKTOANY_APPLICATION (a credential-set name) to its id, once per
// process. Unset means "let LinkToAny choose". A name that doesn't exist is a
// configuration error, not something to silently fall back from - the
// fallback set may be a different (possibly broken) app.
function resolveCredentialId(): Promise<string | undefined> {
  const { linkToAnyApplication: application, linkToAnySystemId: systemId } = getConfig();
  if (!application) return Promise.resolve(undefined);
  credentialId ??= getLinkToAnyClient()
    .credentials.list({ systemId })
    .then(({ data }) => {
      const match = data.find((set) => set.application === application);
      if (!match) {
        const available = data.map((set) => set.application).join(", ") || "none";
        throw new Error(
          `LINKTOANY_APPLICATION "${application}" is not a credential set for this system on this organisation (available: ${available})`
        );
      }
      return match._id;
    })
    .catch((err) => {
      // Don't cache a failure (e.g. a transient network error).
      credentialId = undefined;
      throw err;
    });
  return credentialId;
}

// Hosted-consent systems connect through LinkToAny's own OAuth callback (the
// redirect URI registered with the provider), not the credential set's
// callback that `auth.connectAccount` would use - the SDK itself recommends
// `createConnectLink` for Square/Clover/Lightspeed/Shopify for this reason.
// `state` is appended to successUrl as a path segment, not a query param:
// LinkToAny appends its own `?accountId=...` to whatever successUrl we give
// it, and a path segment stays intact however that merge is done - see
// docs/integration-notes.md.
export async function createConnectLink(
  successUrl: string,
  state: string
): Promise<ConnectLinkResult> {
  const config = getConfig();
  const clientCredentialId = await resolveCredentialId();
  const link = await getLinkToAnyClient().auth.createConnectLink(config.linkToAnySystemId, {
    successUrl: `${successUrl.replace(/\/$/, "")}/${encodeURIComponent(state)}`,
    ...(clientCredentialId ? { clientCredentialId } : {}),
  });
  if (link.mode !== "oauth_redirect") {
    throw new Error(`Expected an oauth_redirect connect link, got mode "${link.mode}"`);
  }
  return { accountLinkUrl: link.accountLinkUrl };
}

// Direct-auth systems (API token, basic auth, ...) have no consent screen:
// the merchant's own credentials are sent and the account exists as soon as
// the call returns. The field names come from the system's link requirements
// (`getLinkRequirements().requiredFields[].sourceField`), not from this app.
// The payload is passed straight through and never logged.
export async function connectWithCredentials(
  application: string,
  fields: Record<string, string>
): Promise<Account> {
  const config = getConfig();
  const clientCredentialId = await resolveCredentialId();
  const client = getLinkToAnyClient();
  const result = await client.auth.connectAccount(config.linkToAnySystemId, application, {
    ...fields,
    ...(clientCredentialId ? { clientCredentialId } : {}),
  });
  const accountId = result.data.accountId;
  if (!accountId) {
    throw new Error("Connecting with credentials returned no account id");
  }
  const { data } = await client.accounts.get(accountId);
  return data;
}

// Only accounts on the configured system count: a merchant id can exist on
// several systems at once.
export async function findAccountForMerchant(merchantId: string): Promise<Account | undefined> {
  const config = getConfig();
  const { data } = await getLinkToAnyClient().accounts.listByMerchant(merchantId);
  const matches = data.filter((account) => accountSystemId(account) === config.linkToAnySystemId);
  return pickMostRecentlyAuthorized(matches);
}

export interface VerifiedConnection {
  account: Account;
  merchantName?: string;
  currencyCode: string;
}

// Confirms the account the callback resolved is genuinely the one this flow
// started: it is an account on the configured system, its platform merchant
// id matches what the callback reported, it was (re)authorized after the
// flow began (not a stale connection), and LinkToAny itself reports the
// connection active. The callback's query string is under the merchant's
// control, so every check here applies whichever parameter the account was
// found by.
export async function verifyConnection(
  account: Account,
  expectedMerchantId: string | undefined,
  flowStartedAt: Date
): Promise<VerifiedConnection> {
  assertAccountOnSystem(account, getConfig().linkToAnySystemId);

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

  // `externalAccountInfo` only holds the OAuth token response for some
  // systems (Square), so display name and currency come from the unified
  // `location` entity where the system has one.
  const location = await getPrimaryLocation(account._id);
  if (!location?.currency) {
    logger.warn("connect.currency_defaulted", {
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
    // Most systems have no `location` entity at all; the Unified API answers
    // that with a validation error, which is expected and not worth a stack.
    if (err instanceof SdkValidationError) {
      logger.info("connect.location_unsupported", { accountId });
    } else {
      logger.warn("connect.location_lookup_failed", { accountId, err });
    }
    return undefined;
  }
}

export async function disconnectAccount(accountId: string): Promise<void> {
  await getLinkToAnyClient().accounts.delete(accountId);
}

// The unified entity names below are shared by every system that has unified
// contracts (the item/order/payment/location/category schemas were compared
// byte for byte across Square, Clover US and Lightspeed K Series). Only
// Square's behaviour has been confirmed live - see docs/integration-notes.md.
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
    logger.warn("catalog.items_without_external_id", { accountId, dropped, kept: items.length });
  }
  return items;
}

// Menu categories (see docs/integration-notes.md) can nest
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
// categoryExternalIds[0] - see docs/integration-notes.md.
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
  // True when `id` is the platform's own order id, read from the create
  // response. False when it is the app's externalId used as a stand-in,
  // which a payment write may not accept.
  idIsNative: boolean;
  total: number;
  currencyCode: string;
}

export interface CreateOrderOptions {
  // Whether the caller will record a payment for this order. Only affects the
  // note the merchant sees on the order.
  recordsPayment: boolean;
}

// `externalId` is the client-supplied idempotency key, reused as-is so a
// retried request (e.g. after a dropped response) doesn't create a second
// order for the same checkout attempt.
export async function createOrder(
  accountId: string,
  externalId: string,
  lineItems: ResolvedLineItem[],
  currencyCode: string,
  { recordsPayment }: CreateOrderOptions
): Promise<CreatedOrder> {
  const total = computeOrderTotal(lineItems, currencyCode);

  const result = await getLinkToAnyClient().records.create(accountId, ORDER_ENTITY_TYPE, {
    externalId,
    currencyCode,
    status: "OPEN",
    // The note lands in the merchant's POS dashboard, so it must say what
    // actually happened: without a payment write there is no tender at all.
    note: recordsPayment
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

  // The payment must reference the platform's own order id (Square rejects
  // the externalId we invented). If a system's response has a shape we don't
  // recognise, fall back to our externalId rather than failing an order that
  // already exists - a wrong id then surfaces as a retryable payment failure,
  // not a duplicate order - and say so in the log.
  const nativeId = extractCreatedRecordId(result.data, "order");
  if (!nativeId) {
    logger.warn("orders.native_id_missing", { accountId });
  }
  return { id: nativeId ?? externalId, idIsNative: Boolean(nativeId), total, currencyCode };
}

// Always a simulated cash tender - see docs/integration-notes.md for
// why every payment this integration writes is an immediate, irreversible
// real capture against the connected account.
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

// Some systems (Square) return orders oldest first, so a plain first page
// shows the merchant's oldest orders. Read by `since` instead - see
// lib/recent-records.ts. A system whose order read doesn't accept `since`
// answers with a validation error; fall back to a single plain page then,
// which is the best that read can offer.
async function fetchRecentOrderRecords(accountId: string): Promise<RawOrder[]> {
  const client = getLinkToAnyClient();
  try {
    const { records, truncated } = await collectRecentRecords<RawOrder>(
      ({ since, pageSize, cursor }) =>
        client.records.list<RawOrder>(accountId, ORDER_ENTITY_TYPE, {
          since,
          pageSize,
          ...(cursor ? { cursor } : {}),
        }),
      {
        limit: RECENT_ORDERS_LIMIT,
        windowsInDays: [1, 7, RECENT_ORDERS_MAX_DAYS],
        // Within every system's page-size limit we have seen (Square's
        // order contract allows up to 200).
        pageSize: 100,
        maxPagesPerWindow: 10,
      }
    );
    if (truncated) {
      logger.warn("orders.list_truncated", { accountId });
    }
    return records;
  } catch (err) {
    if (!(err instanceof SdkValidationError)) throw err;
    logger.warn("orders.since_unsupported", { accountId });
    const { data } = await client.records.list<RawOrder>(accountId, ORDER_ENTITY_TYPE, {
      pageSize: 100,
    });
    return data;
  }
}

export async function listRecentOrders(accountId: string): Promise<OrderSummary[]> {
  const records = await fetchRecentOrderRecords(accountId);
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
