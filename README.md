# Square POS Demo

A small Next.js point-of-sale app that connects to a merchant's Square
account through the [LinkToAny Unified API](https://docs.linktoany.com) and
lets you browse the catalog and place orders against it. It exists to
demonstrate the Unified API's OAuth-connect and order/payment write flows end
to end against a real integration (Square), not to be a reference POS
implementation.

> [!WARNING]
> **Payment writes are off by default.** With `ENABLE_PAYMENT_WRITES` unset
> (or anything other than `true`), placing an order creates the Square order
> only - no payment record is written. When you set it to `true`, every order
> also writes a `payment` record (tagged as a simulated cash tender) that
> Square treats as a genuine, irreversible completed payment against
> whichever account is connected. No card is charged, but the capture is
> real and this integration has no refund capability. **Only enable it
> against a disposable Square sandbox or test account.** The app can't tell
> a sandbox merchant from a production one, so this flag is the only gate.

## Request flow

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Connect/disconnect screen. |
| `/api/square/authorize` | POST | Starts the OAuth connect flow: mints a CSRF state nonce and redirects to LinkToAny's hosted Square connect link. |
| `/api/square/callback/[state]` | GET | OAuth return target (`LINKTOANY_RETURN_URL` + the CSRF state nonce, appended as a path segment). Verifies the state nonce, resolves the connected account, checks its merchant id, (re)authorization time and auth status, and stores it in the session. |
| `/api/square/disconnect` | POST | Deletes the account from LinkToAny and clears the session. |
| `/items` | GET | POS screen: catalog grid + cart. |
| `/api/square/orders` | POST | Validates a cart, re-prices it from the server's own catalog read, and creates an order - plus a simulated payment only when `ENABLE_PAYMENT_WRITES=true`. |
| `/api/square/orders/[orderId]/payment` | POST | Retries just the payment for an order whose payment write failed, using the amount and payment id kept in the session. |
| `/orders` | GET | Recent orders list. |

## Prerequisites

- Node.js version in [`.nvmrc`](.nvmrc) (>= 22.12, required by Vitest 5).
- A [LinkToAny](https://platform.linktoany.com) API key and organisation.
- A Square credential set registered with LinkToAny under that organisation
  (Client credentials in the LinkToAny dashboard) - **a sandbox/test Square
  account, not a production one** (see the warning above).

## Setup

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

- `LINKTOANY_API_KEY`, `LINKTOANY_ORGANISATION_ID`, `LINKTOANY_ENVIRONMENT` - your
  LinkToAny credentials (`dev` → `api.staging.linktoany.com`, `prod` →
  `api.linktoany.com`).
- `LINKTOANY_SQUARE_SYSTEM_ID` - leave blank at first and run:
  ```bash
  npm install
  npm run linktoany:discover
  ```
  to find Square's `systemId` on your organisation (and inspect the live
  `item`/`order`/`payment` contracts), then paste it in.
- `LINKTOANY_SQUARE_APPLICATION` - optional; the name of the Square
  credential set to connect through. Set it if your organisation has more
  than one, otherwise LinkToAny picks one for your API key (which may not be
  the one you configured). A name that doesn't exist fails the connect with
  the list of available sets in the server log.
- `LINKTOANY_RETURN_URL` - where LinkToAny sends the merchant back after OAuth;
  must match what's registered for your Square credential set
  (`<your-origin>/api/square/callback`).
- `SESSION_SECRET` - generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `ENABLE_PAYMENT_WRITES` - `false` by default; see the warning above before
  setting it to `true`.
- `DEV_TUNNEL_ORIGIN` - optional, see below.

## Running locally

```bash
npm run dev
```

Square requires an HTTPS redirect URL (the `localhost` exception only applies
to Square's own sandbox apps, not to how LinkToAny registers its callback),
so local development needs an HTTPS tunnel in front of `localhost:3000`, e.g.:

```bash
npx ngrok http 3000
```

Register the tunnel's HTTPS URL + `/api/square/callback` as `LINKTOANY_RETURN_URL`,
and set `DEV_TUNNEL_ORIGIN` to the tunnel's bare hostname so Next's dev server
accepts requests through it. Then open the tunnel URL, click **Connect to
Square**, and you'll land on `/items` once the connection is verified.

## How it works

- **Merchant-id lookup**: Square is a hosted-consent integration - LinkToAny
  resolves the merchant identity itself during OAuth and reports it back as
  `external_id` on the callback, rather than us ever seeing Square
  credentials. The callback looks the account up by that merchant id,
  confirms it was created or re-authorized after this flow started (so a
  merchant reconnecting an existing account isn't rejected), and confirms
  `auth.getStatus` reports it active, before trusting it.
- **Two category taxonomies**: a Square catalog has independent `REGULAR`
  (POS/reporting) and `MENU` (online ordering) categories, and an item often
  belongs to one of each. See
  [`docs/square-integration-notes.md`](docs/square-integration-notes.md) for
  why the POS view has to pick one deliberately instead of reading whichever
  category id comes first.
- **Order-then-payment**: placing an order re-prices the cart from the
  account's own catalog on the server (the client only ever sends a
  variation id and a quantity) and creates an `order` record. Only if
  `ENABLE_PAYMENT_WRITES=true` does it then write an immediate `payment`
  record against it, tagged as a simulated cash tender. The merchant name and
  currency come from the account's unified `location` record (read once at
  connect time); the unified location has no language field, so prices are
  formatted in `en-US`. See
  [`docs/square-integration-notes.md`](docs/square-integration-notes.md) for
  what's actually confirmed to work in that write path (idempotency keys,
  totals, why payment status is ignored, why there's no refund path).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Redirected to `/?error=invalid_state` | The OAuth state nonce was missing, didn't match, or the attempt took longer than 15 minutes. Try connecting again. |
| Redirected to `/?error=stale_link` | The callback arrived with no state nonce in the session: sign-in was finished in an older Square tab (whose link was already used), or Connect was clicked on a different host than `LINKTOANY_RETURN_URL` (e.g. `localhost` instead of the tunnel). Close other Square sign-in tabs and connect again from the registered host. |
| Redirected to `/?error=connect_failed` | LinkToAny reported an OAuth failure (server log `square.callback.provider_error`, e.g. `CONNECTION_FAILED` after Square consent), or `createConnectLink` didn't return an `oauth_redirect` link - check `LINKTOANY_SQUARE_SYSTEM_ID`, which credential set is used (`LINKTOANY_SQUARE_APPLICATION`), and that set's Square client secret in the LinkToAny dashboard. |
| Redirected to `/?error=not_verified` | The account was found but failed verification (merchant id mismatch, not re-authorized during this flow, or isn't active) - check the server logs for `square.callback.failed`. |
| Placing an order returns `400` | The cart failed server-side validation (unknown/unpriced variation, bad quantity, too many line items) - the error message names which. |
| Placing an order returns `207` | The order was created but the payment write failed; the order id in the response is real and visible in `/orders`. The POS screen offers **Retry payment**, which re-sends only the payment with the same amount and payment id. |
| Orders are created but no payment appears in Square | Expected unless `ENABLE_PAYMENT_WRITES=true`. |
| Placing an order returns `429` | More than 30 order requests from this account within a minute (in-memory limiter, resets on redeploy). |
| Client-side hydration/interactivity silently breaks in dev | You're accessing the app through a tunnel but didn't set `DEV_TUNNEL_ORIGIN`. |

## Known limitations

- No database - the session (an encrypted, httpOnly cookie via
  `iron-session`) is the only state. Nothing survives clearing cookies,
  including a pending payment retry.
- No OAuth token refresh handling beyond what LinkToAny does automatically;
  if a connection goes stale, disconnect and reconnect.
- No refund capability - the Unified API has no `refund` entity for Square
  at all (see `docs/square-integration-notes.md`).
- The in-memory rate limiter and catalog cache are per-instance and don't
  survive a restart or scale across multiple instances.
- This is a demo, not a production POS: no multi-user accounts, no
  inventory sync, no receipt printing.

## License

[MIT](LICENSE). See [SECURITY.md](SECURITY.md) for reporting a vulnerability
and [CONTRIBUTING.md](CONTRIBUTING.md) for contributing.
