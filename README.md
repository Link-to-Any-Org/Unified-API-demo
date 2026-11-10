# Unified API POS Demo

A small Next.js point-of-sale app that connects to a merchant's account on any
system supported by the [LinkToAny Unified API](https://docs.linktoany.com)
and, where the system supports it, lets you browse the catalog and place
orders against it. Which system it talks to is one setting,
`LINKTOANY_SYSTEM_ID`: the app discovers the system's name, how it connects
and which screens apply from the Unified API instead of hard-coding them. It
exists to demonstrate the Unified API's connect and order/payment write flows
end to end, not to be a reference POS implementation.

> [!WARNING]
> **Payment writes are off by default.** With `ENABLE_PAYMENT_WRITES` unset
> (or anything other than `true`), placing an order creates the order only -
> no payment record is written. When you set it to `true`, every order also
> writes a `payment` record (tagged as a simulated cash tender) that the
> provider treats as a genuine, irreversible completed payment against
> whichever account is connected. No card is charged, but the capture is
> real and this integration has no refund capability. **Only enable it
> against a disposable sandbox or test account.** The app can't tell a
> sandbox merchant from a production one, so this flag is the only gate.

## Choosing a system

Set `LINKTOANY_SYSTEM_ID` and restart. Everything else follows from what the
Unified API reports for that system:

- **How it connects.** Systems with a hosted consent screen (Square, Clover US
  OAuth, Lightspeed, Shopify, ...) get a **Connect** button and the OAuth
  flow. Systems that authenticate with the merchant's own credentials (API
  token, basic auth, ...) get a form with exactly the fields the system asks
  for.
- **Which screens appear.** The POS screen needs a readable `item` and a
  writable `order`; the orders list needs a readable `order`; recording a
  payment needs a writable `payment`. A system without them still connects,
  and the home screen lists the unified entities it does expose.

Run `npm run linktoany:discover` to list the systems on your organisation and
`LINKTOANY_SYSTEM_ID=<id> npm run linktoany:discover` to see how one connects
and what it supports.

What that means for the 32 active systems on the platform as of Nov 10 2026
(this changes as contracts are added):

| System | Unified contracts | Status |
| --- | --- | --- |
| Square | `item`, `order`, `payment`, `location`, `category`, ... | **Verified live**: connect, reconnect, order and payment. |
| Clover US, Lightspeed K Series | Same `item`/`order`/`payment`/`location`/`category` schemas as Square (compared byte for byte) | POS screens appear. **Not tested live**: see [`docs/integration-notes.md`](docs/integration-notes.md) for what is unverified. |
| The other 29 (Shopify, Stripe, QBO, HubSpot, Brink POS, Revel, ...) | No `item`/`order` contracts (Shift4 Dine has only `product`) | Connect only; the home screen shows what the system exposes. |

A system can only be connected if your organisation has registered a
credential set for it (Client credentials in the LinkToAny dashboard). The
Unified API has no shared default. Without one the home screen says so
instead of offering a Connect button.

## Request flow

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Connect/disconnect screen, built from the system's profile. |
| `/api/connect/authorize` | POST | Starts a hosted-consent connect: mints a CSRF state nonce and redirects to LinkToAny's connect link. |
| `/api/connect/callback/[state]` | GET | OAuth return target (`LINKTOANY_RETURN_URL` + the CSRF state nonce, appended as a path segment). Verifies the state nonce, resolves the connected account, checks its merchant id, (re)authorization time and auth status, and stores it in the session. `/api/square/callback/[state]` still answers with the same handler for return URLs registered before the rename. |
| `/api/connect/credentials` | POST | Connects a direct-auth system from the merchant's own credentials (the fields the system's link requirements name). |
| `/api/connect/disconnect` | POST | Deletes the account from LinkToAny and clears the session. |
| `/items` | GET | POS screen: catalog grid + cart (systems with `item` read and `order` write). |
| `/api/orders` | POST | Validates a cart, re-prices it from the server's own catalog read, and creates an order - plus a simulated payment only when `ENABLE_PAYMENT_WRITES=true` and the system can record one. |
| `/api/orders/[orderId]/payment` | POST | Retries just the payment for an order whose payment write failed, using the amount and payment id kept in the session. |
| `/orders` | GET | The 20 newest orders from the last 30 days (systems with `order` read). |

## Prerequisites

- Node.js version in [`.nvmrc`](.nvmrc) (>= 22.12, required by Vitest 5).
- A [LinkToAny](https://platform.linktoany.com) API key and organisation.
- A credential set for your chosen system registered with LinkToAny under
  that organisation (Client credentials in the LinkToAny dashboard) - **a
  sandbox/test account, not a production one** (see the warning above).

## Setup

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

- `LINKTOANY_API_KEY`, `LINKTOANY_ORGANISATION_ID`, `LINKTOANY_ENVIRONMENT` - your
  LinkToAny credentials (`dev` → `api.staging.linktoany.com`, `prod` →
  `api.linktoany.com`).
- `LINKTOANY_SYSTEM_ID` - the system to connect to. Leave blank at first and run:
  ```bash
  npm install
  npm run linktoany:discover
  ```
  to list the systems and find the id, then paste it in. The older
  `LINKTOANY_SQUARE_SYSTEM_ID` name is still read as a fallback.
- `LINKTOANY_APPLICATION` - optional; the name of the credential set to
  connect through. Set it if your organisation has more than one for the
  system, otherwise LinkToAny picks one for your API key (which may not be
  the one you configured). A name that doesn't exist fails the connect with
  the list of available sets in the server log. The older
  `LINKTOANY_SQUARE_APPLICATION` name is still read as a fallback.
- `LINKTOANY_RETURN_URL` - where LinkToAny sends the merchant back after OAuth;
  must match what's registered for your credential set
  (`<your-origin>/api/connect/callback`). Only used by hosted-consent systems.
- `SESSION_SECRET` - generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `ENABLE_PAYMENT_WRITES` - `false` by default; see the warning above before
  setting it to `true`.
- `DEV_TUNNEL_ORIGIN` - optional, see below.

Switching to another system is a change to `LINKTOANY_SYSTEM_ID` (and
`LINKTOANY_APPLICATION`, if you set one) plus a restart. A session connected to
the previous system is not honoured by the new one, so you reconnect.

## Running locally

```bash
npm run dev
```

Hosted-consent providers need an HTTPS redirect URL, so local development
with one of them needs an HTTPS tunnel in front of `localhost:3000`, e.g.:

```bash
npx ngrok http 3000
```

Register the tunnel's HTTPS URL + `/api/connect/callback` as `LINKTOANY_RETURN_URL`.
Its host is automatically allowed as a Next dev origin, so the dev server's
HMR and client chunks work through the tunnel (set `DEV_TUNNEL_ORIGIN` only to
allow an additional host). Restart `npm run dev` after changing the tunnel
URL. Then open the tunnel URL, click **Connect**, and you'll land on `/items`
(or `/`, for a system without POS support) once the connection is verified.
Systems that connect with credentials don't need the tunnel.

## How it works

- **System profile**: `lib/system-profile.ts` reads the system (name), its
  link requirements (hosted consent or credential form, and which fields) and
  its unified contracts (which entities are readable/writable, judged from the
  enabled mappings for that system) once per few minutes. The pure rules live
  in `lib/system-capabilities.ts`.
- **Merchant-id lookup** (hosted consent): LinkToAny resolves the merchant
  identity itself during OAuth and reports it back as `external_id` on the
  callback, rather than us ever seeing provider credentials. The callback looks
  the account up by that merchant id on the configured system (taking the most
  recently updated one, since reconnecting re-authorizes an existing account
  rather than creating a new one), confirms it was created or re-authorized
  after this flow started, and confirms `auth.getStatus` reports it active,
  before trusting it.
- **Credential connect** (direct auth): the fields the system's link
  requirements name are posted, passed straight to `auth.connectAccount`, and
  never logged or echoed back. Fields that look like secrets are masked.
- **Two category taxonomies**: a catalog can have independent `REGULAR`
  (POS/reporting) and `MENU` (online ordering) categories, and an item often
  belongs to one of each. See
  [`docs/integration-notes.md`](docs/integration-notes.md) for why the POS view
  has to pick one deliberately instead of reading whichever category id comes
  first.
- **Order-then-payment**: placing an order re-prices the cart from the
  account's own catalog on the server (the client only ever sends a
  variation id and a quantity) and creates an `order` record. Only if
  `ENABLE_PAYMENT_WRITES=true` and the system can record payments does it then
  write an immediate `payment` record against it, tagged as a simulated cash
  tender. The merchant name and currency come from the account's unified
  `location` record (read once at connect time, falling back to defaults). The
  location has no language field, so prices are formatted in the merchant's
  currency and the viewer's browser language (`Accept-Language`, falling back
  to `en-US`). See [`docs/integration-notes.md`](docs/integration-notes.md)
  for what's actually confirmed to work in that write path (idempotency keys,
  totals, why payment status is ignored, why there's no refund path).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Home screen says no credential set is registered | Your organisation has no credential set for the configured system. Add one under Client credentials in the LinkToAny dashboard. |
| Redirected to `/?error=invalid_state` | The OAuth state nonce was missing, didn't match, or the attempt took longer than 15 minutes. Try connecting again. |
| Redirected to `/?error=stale_link` | The callback arrived with no state nonce in the session: sign-in was finished in an older tab (whose link was already used), or Connect was clicked on a different host than `LINKTOANY_RETURN_URL` (e.g. `localhost` instead of the tunnel). Close other sign-in tabs and connect again from the registered host. |
| Redirected to `/?error=connect_failed` | LinkToAny reported an OAuth failure (server log `connect.callback.provider_error`, e.g. `CONNECTION_FAILED` after consent), or no `oauth_redirect` link could be created - check `LINKTOANY_SYSTEM_ID`, which credential set is used (`LINKTOANY_APPLICATION`), and that set's client secret in the LinkToAny dashboard. |
| Redirected to `/?error=not_verified` | The account was found but failed verification (merchant id mismatch, not re-authorized during this flow, or isn't active) - check the server logs for `connect.callback.failed`. |
| Redirected to `/?error=invalid_credentials` | The system rejected the credentials entered in the connect form. |
| Redirected to `/?error=missing_fields` | A field of the connect form was empty. |
| Placing an order returns `400` | The cart failed server-side validation (unknown/unpriced variation, bad quantity, too many line items) - the error message names which. |
| Placing an order returns `207` | The order was created but the payment write failed; the order id in the response is real and visible in `/orders`. The POS screen offers **Retry payment**, which re-sends only the payment with the same amount and payment id. |
| Orders are created but no payment appears | Expected unless `ENABLE_PAYMENT_WRITES=true`, and never for a system with no payment write. |
| Placing an order returns `429` | More than 30 order requests from this account within a minute (in-memory limiter, resets on redeploy). |
| Buttons render but do nothing in dev (e.g. items can't be added to the cart); browser console shows `/_next/hmr` websocket failures | You're opening the app on a host Next doesn't allow as a dev origin, so the page never hydrates. Open it on `LINKTOANY_RETURN_URL`'s host (allowed automatically) or add the host to `DEV_TUNNEL_ORIGIN`, then restart `npm run dev`. |

## Known limitations

- No database - the session (an encrypted, httpOnly cookie via
  `iron-session`) is the only state. Nothing survives clearing cookies,
  including a pending payment retry.
- Only Square has been exercised live. For other systems the unified schemas
  match, but connect behaviour, the shape of the order-create response (used
  to find the platform's own order id for the payment), paging and `since`
  support are unverified - see [`docs/integration-notes.md`](docs/integration-notes.md).
- No OAuth token refresh handling beyond what LinkToAny does automatically;
  if a connection goes stale, disconnect and reconnect.
- No refund capability - none of the systems with unified contracts
  (Square, Clover US, Lightspeed K Series) has a `refund` entity in the
  Unified API (see `docs/integration-notes.md`).
- The in-memory rate limiter and catalog cache are per-instance and don't
  survive a restart or scale across multiple instances.
- This is a demo, not a production POS: no multi-user accounts, no
  inventory sync, no receipt printing.

## License

[MIT](LICENSE). See [SECURITY.md](SECURITY.md) for reporting a vulnerability
and [CONTRIBUTING.md](CONTRIBUTING.md) for contributing.
