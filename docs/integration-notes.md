# Integration design notes

Background for the shortcuts in `lib/linktoany.ts`: what was confirmed by
live testing against a real account, and what is still unconfirmed. The app is
system-agnostic (`LINKTOANY_SYSTEM_ID` selects the system), but **only Square
has been exercised live**, so most sections below record Square's behavior.

## Working across systems

What was checked on Nov 10 2026, against the 32 active systems on the platform:

- Only three systems have unified contracts that cover a POS flow: Square,
  Clover US and Lightspeed K Series. For these, the `item`, `order`, `payment`,
  `location` and `category` unified schemas are **byte-for-byte identical**, so
  the same read/write code applies. Everything else (29 systems) has no
  `item`/`order` contract (Shift4 Dine has only `product`). Such a system can
  still be connected, and the home screen lists the entities it does expose.
- Capabilities come from the contracts' **enabled mappings for the configured
  system**, not from the contract merely existing: a contract can map several
  systems, and a mapping can be disabled. They differ even among the three:
  Lightspeed K's `category` has no write mapping, Clover US's `payment` has no
  read mapping, and Square's `location` has no write mapping. The app needs
  `item` read + `order` write for the POS, `order` read for the orders list,
  and `payment` write to record a payment.
- A system can only be connected if the organisation has registered a
  credential set for it. On Nov 10 2026, `getLinkRequirements` succeeded for
  Square (`oauth_redirect`) and Clover US (`oauth_redirect`, unique field
  `merchantId`, four credential sets on this organisation) and failed with a
  `ValidationError` for the others tried (Clover US Personal Token, Brink POS,
  Stripe). Lightspeed K was not re-checked after returning a 503. The home
  screen reports the missing-credential-set case instead of offering a Connect
  button.
- A system connects in one of two modes (`getLinkRequirements().mode`):
  `oauth_redirect` (hosted consent; the callback flow below) or `form` (the
  merchant's own credentials, posted to `/api/connect/credentials`).

**Unverified for any system other than Square** - treat as assumptions until
exercised live:

- The shape of the order-create response. Square nests the order id under
  `data[0].data.order.id`. `extractCreatedRecordId` also accepts a few other
  common shapes, and if none match the order id falls back to the app's own
  `externalId` (with an `orders.native_id_missing` warning), which a provider
  that needs its native id will reject as a retryable payment failure.
- Whether the order read accepts `since` and a page size of 100. If a system
  answers with a validation error, `/orders` falls back to a single plain
  page (`orders.since_unsupported` warning), which may not be the newest
  orders.
- The callback's merchant identifier (`external_id` for Square) and how a
  reconnect behaves.
- The `form` connect mode has been tested only with mocks: no direct-auth
  system has a credential set on this organisation.
- Tender and status values (`CASH`, `CAPTURED`, `OPEN`) come from the shared
  schema but were only accepted by Square so far.

## Two category taxonomies

The unified `category` schema carries a `categoryType` of `REGULAR`, `MENU`
or `KITCHEN`. In Square, the system confirmed live, a catalog has two
independent category systems: `REGULAR` categories (Catalog API, drive POS
grouping/reporting) and `MENU` categories (Square's menu builder, drive
online-ordering display); `KITCHEN` has no Square equivalent. An item
commonly belongs to one of each at the same time, so
reading `categoryExternalIds[0]` is undefined behavior - the array's order
isn't documented or guaranteed. `resolveItemCategory()` instead picks the id
whose `categoryType` matches the requested usage, falling back to whatever is
present so older/partial syncs don't disappear from the UI.

## Order-then-payment sequence

The `order` and `payment` unified write contracts were confirmed live for
Square (production merchant, Oct 2026). The schemas are shared with the other
systems that have contracts, but the behaviors below are Square's until
confirmed elsewhere:

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
capture against whatever account is connected, payment writes are behind a
hard server-side gate: `ENABLE_PAYMENT_WRITES` must be exactly `"true"`,
otherwise the orders route creates the order only and `createOrderPayment`
refuses to run. A system with no payment write skips the payment too. The app
can't tell a sandbox merchant from a production one, so this is an explicit
operator opt-in rather than inferred from the LinkToAny environment. Every order's `note` is
also tagged as a simulated-tender demo order.

If the order succeeds but the payment write fails, the amount, currency and
a fixed payment `externalId` are kept in the sealed session, and
`POST /api/orders/[orderId]/payment` retries just the payment from
those values - so a retry can't change the amount or create a second
capture.

## Hosted-consent connect (OAuth callback): status

**Confirmed end to end for Square (Nov 5 2026, production merchant):** state
check, account lookup by `external_id`, freshness and `auth.getStatus`
verification all passed and the merchant landed on `/items`. An order with
its payment was then placed through the app on Nov 6 (see "Reading recent
orders" below).

Failures hit along the way (with Square), for anyone debugging a repeat:

- `CONNECTION_FAILED` from LinkToAny after Square consent, before our
  callback logic runs. Cause: with no credential set specified, connect links
  used whichever Square credential set LinkToAny resolved for the API key (a
  newer set whose stored secret didn't complete the token exchange), not the
  one that had worked before. Fixed by passing `LINKTOANY_APPLICATION`'s set
  (formerly `LINKTOANY_SQUARE_APPLICATION`) as `clientCredentialId`. All the organisation's sets share one Square
  app id, so the consent screen looks identical either way.
- `stale_link` / `no_state_in_session`: sign-in finished in an older Square
  tab whose link had already been used, or Connect was clicked on a different
  host than `LINKTOANY_RETURN_URL` (e.g. `localhost` while the return URL is
  the tunnel - the state cookie is per host).
- `invalid_state` in a private browsing window, where the session cookie
  didn't survive the round trip.

### State nonce as a path segment

The SDK's docs say `createConnectLink`'s hosted flow "sends the merchant to
successUrl with ?accountId=…", which suggests it appends its own query
string. A `?state=...` in `successUrl` could then come back garbled
(`state=XXXX?accountId=YYYY`). Rather than depend on how LinkToAny merges
query strings, the nonce travels as a path segment
(`/api/connect/callback/[state]`), which survives either way.

### Reconnects and the freshness check

The callback rejects an account that wasn't (re)authorized during this flow,
to avoid trusting a stale connection. A merchant reconnecting may have their
existing LinkToAny account re-authorized instead of a new one created, so the
check uses the latest of `auth.getStatus().lastAuthAt`, `updatedAt` and
`createdAt` rather than `createdAt` alone (which would reject every
reconnect).

Observed live on LinkToAny:

- Connecting again after a disconnect creates a new account (`createdAt`,
  `updatedAt` and `lastAuthAt` all set during the flow).
- Connecting again **without** disconnecting re-authorizes the existing
  account (Nov 6 2026): its `createdAt` stayed at Nov 5 16:04 UTC while
  `lastAuthAt` and `updatedAt` both moved to the reconnect time (06:12:49
  UTC, 0.2s apart). So a `createdAt`-only check would have rejected it; the
  `lastAuthAt` / `updatedAt` check accepts it (covered by a test using those
  exact timestamps).
- The callback only receives `provider` and `external_id` (the merchant id),
  so the account is looked up by merchant. One merchant can have several
  accounts on the same system (this test merchant has five), so the lookup
  picks the most recently **updated** one - the one the flow just
  (re)authorized - not the newest-created one, which could be an account the
  flow never touched.

A successful callback logs `connect.callback.connected` with `reconnect:
true|false`, so a reconnect can be confirmed from the server log.

**Confirmed end to end (Nov 6 2026, 12:41 UTC):** a reconnect started from
the registered host, without disconnecting first, went through our callback
and landed on `/items`. The log showed `connect.callback.connected` (then named `square.callback.connected`) with
`reconnect: true` for the existing account, whose `createdAt` stayed at
Nov 5 16:04 UTC while `lastAuthAt` and `updatedAt` moved to 12:41:49 UTC. No
new account was created.

## Reading recent orders

Unified `order` reads for Square come back **oldest first** (a plain first
page for the test merchant started in March), and `pageSize` is capped at 200
for this contract (the app uses 100, which fits any cap seen so far).
`/orders` therefore reads with `since`, starting with the
last day and widening to 7 and then 30 days only until there are 20 orders,
following `pagination.cursor` within each window, and shows the newest 20.
The only supported order filters are `externalId`, `status`,
`orderTypeExternalId`, `customerExternalId`, `locationExternalId` and
`since` - `createdAfter` is rejected with `UNKNOWN_FILTER`. `since` means
"changed since", so an old order updated recently can also appear.

Confirmed live (Nov 6 2026): an order placed from the POS with
`ENABLE_PAYMENT_WRITES=true` came back `CLOSED` with `total` 120, `paidTotal`
120 and `balanceDue` 0, carrying the demo note, and is the first row of
`/orders`.

## Price formatting

The unified `location` record has `name`, `currency`, `timezone`, `phone`,
`status` and service hours, but no language. Prices are therefore formatted
in the merchant's currency and the **viewer's** language, taken from the
request's `Accept-Language` header on the server (so server render and
hydration match), falling back to `en-US`.
