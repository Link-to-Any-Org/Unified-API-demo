# Square integration design notes

Background for the shortcuts in `lib/uniflow.ts`. See the capability-matrix
and category/item-creation memory for the full live-testing record this was
derived from; this file is the durable, in-repo summary.

## Two category taxonomies

A Square catalog has two independent category systems, not one:
`REGULAR` categories (Catalog API, drive POS grouping/reporting) and `MENU`
categories (Square's menu builder, drive online-ordering display); `KITCHEN`
exists in the unified schema for other POS integrations and has no Square
equivalent. An item commonly belongs to one of each at the same time, so
reading `categoryExternalIds[0]` is undefined behavior - the array's order
isn't documented or guaranteed. `resolveItemCategory()` instead picks the id
whose `categoryType` matches the requested usage, falling back to whatever is
present so older/partial syncs don't disappear from the UI.

## Order-then-payment sequence

The `order` and `payment` unified write contracts for this Square
integration were confirmed live (production merchant, Oct 2026):

- `order` write needs `externalId`, `status`, per-line `externalId`, and a
  server-computed `totals.total` - Square may still add its own tax on top.
- `payment` write's `orderExternalId` must be Square's **native** order id
  (the `id` a successful order-create response returns), never the
  `externalId` UUID this app invents.
- `payment.status` is accepted but ignored - the write op hardcodes
  `autocomplete: true`, so every payment this integration creates becomes
  Square `COMPLETED` immediately, for any tender. There is no partial/split
  payment, no refund entity, and no update op for either entity once
  created - every choice has to be right at creation time.
- Prices are decimal currency units (e.g. `9.97`), not integer minor units;
  Square rounds sub-cent amounts to the nearest cent on write.

Because every payment this app writes is a real, immediate, irreversible
capture against whatever Square account is connected, the POS UI always
shows a persistent warning, and every order's `note` field is tagged as a
simulated-tender demo order.

## `createConnectLink`'s successUrl query string

Diagnosed, not directly confirmed (Nov 2026 - every real attempt hit
`invalid_state`): the SDK's own docs say `createConnectLink`'s hosted flow
"sends the merchant to successUrl with ?accountId=…", wording that suggests
it appends its own query string without checking whether `successUrl`
already has a `?`. If so, a `successUrl` carrying our own `?state=...` CSRF
nonce would come back as one garbled query param
(`state=XXXX?accountId=YYYY`) instead of two separate ones, failing the
state comparison every time. Rather than depend on how LinkToAny merges
query strings, the OAuth state nonce now travels as a path segment
(`/api/square/callback/[state]`) instead of a query param, which is correct
regardless of how the rest of the URL is built.
