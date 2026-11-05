# Square integration design notes

Background for the shortcuts in `lib/linktoany.ts`: what was confirmed by
live testing against a real Square account, and what is still unconfirmed.

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
capture against whatever Square account is connected, payment writes are
behind a hard server-side gate: `ENABLE_PAYMENT_WRITES` must be exactly
`"true"`, otherwise the orders route creates the order only and
`createOrderPayment` refuses to run. The app can't tell a Square sandbox
merchant from a production one, so this is an explicit operator opt-in
rather than inferred from the LinkToAny environment. Every order's `note` is
also tagged as a simulated-tender demo order.

If the order succeeds but the payment write fails, the amount, currency and
a fixed payment `externalId` are kept in the sealed session, and
`POST /api/square/orders/[orderId]/payment` retries just the payment from
those values - so a retry can't change the amount or create a second
capture.

## OAuth callback: status

**Confirmed end to end (Nov 5 2026, production Square merchant):** state
check, account lookup by `external_id`, freshness and `auth.getStatus`
verification all passed and the merchant landed on `/items`.

Failures hit along the way, for anyone debugging a repeat:

- `CONNECTION_FAILED` from LinkToAny after Square consent, before our
  callback logic runs. Cause: with no credential set specified, connect links
  used whichever Square credential set LinkToAny resolved for the API key (a
  newer set whose stored secret didn't complete the token exchange), not the
  one that had worked before. Fixed by passing `LINKTOANY_SQUARE_APPLICATION`'s
  set as `clientCredentialId`. All the organisation's sets share one Square
  app id, so the consent screen looks identical either way.
- `stale_link` / `no_state_in_session`: sign-in finished in an older Square
  tab whose link had already been used, or Connect was clicked on a different
  host than `LINKTOANY_RETURN_URL` (the home page now only offers Connect on
  that host).
- `invalid_state` in a private browsing window, where the session cookie
  didn't survive the round trip.

### State nonce as a path segment

The SDK's docs say `createConnectLink`'s hosted flow "sends the merchant to
successUrl with ?accountId=…", which suggests it appends its own query
string. A `?state=...` in `successUrl` could then come back garbled
(`state=XXXX?accountId=YYYY`). Rather than depend on how LinkToAny merges
query strings, the nonce travels as a path segment
(`/api/square/callback/[state]`), which survives either way.

### Reconnects and the freshness check

The callback rejects an account that wasn't (re)authorized during this flow,
to avoid trusting a stale connection. A merchant reconnecting may have their
existing LinkToAny account re-authorized instead of a new one created, so the
check uses the latest of `auth.getStatus().lastAuthAt`, `updatedAt` and
`createdAt` rather than `createdAt` alone (which would reject every
reconnect). Observed live: connecting again after a disconnect creates a new
account (`createdAt`, `updatedAt` and `lastAuthAt` all set during the flow).
Re-authorizing an account that was never disconnected hasn't been observed
yet; `lastAuthAt` is the field expected to move in that case.
