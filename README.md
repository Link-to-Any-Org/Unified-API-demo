# Square Catalog Viewer

Next.js app that connects to a Square merchant account via OAuth and lists the
items in their catalog.

## 1. Square app setup

1. In the [Square Developer Dashboard](https://developer.squareup.com/apps),
   open your application (or create one) and go to **OAuth** under the
   Production tab.
2. Add a **Redirect URL**. Square requires HTTPS for production redirect
   URLs (the `http://localhost` exception only applies to Sandbox apps), so
   for local development either:
   - run an HTTPS tunnel, e.g. `npx ngrok http 3000`, and register
     `https://<your-ngrok-subdomain>.ngrok-free.app/api/square/callback`, or
   - deploy the app (e.g. to Vercel) and register
     `https://your-domain.example.com/api/square/callback`.
3. Note your **Application ID** and **Application Secret** from the
   Credentials page (Production tab).

The app requests the `ITEMS_READ` and `MERCHANT_PROFILE_READ` OAuth scopes.

## 2. Configure environment variables

```bash
cp .env.example .env.local
```

Fill in `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, and
`SQUARE_REDIRECT_URI` (must exactly match what you registered above).
Generate a `SESSION_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 3. Run

```bash
npm install
npm run dev
```

Visit the app's URL (e.g. via your ngrok tunnel), click **Connect to
Square**, authorize the app as a merchant, and you'll land on `/items` with
the catalog's items listed.

## Notes / limitations

- Session (access token, refresh token, merchant id) is stored in an
  encrypted, httpOnly cookie via `iron-session` - there is no database.
- Square production access tokens expire after 30 days. This app does not
  currently implement the refresh-token flow automatically; after expiry,
  disconnect and reconnect.
