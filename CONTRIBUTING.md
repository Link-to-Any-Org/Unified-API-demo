# Contributing

1. Use the Node version in `.nvmrc`.
2. `npm install`, then `cp .env.example .env.local` and fill it in (see the
   README's setup section).
3. Before opening a PR, run:
   ```bash
   npm run lint
   npm run typecheck
   npm test
   npm run build
   ```
4. Keep changes scoped - this is a small demo app, not a framework. Prefer
   the simplest change that fixes the problem over new abstractions.
5. If your change touches the order/payment flow, re-read
   `docs/square-integration-notes.md` first: several of this integration's
   behaviors (payment status, idempotency, totals) were confirmed by live
   testing against Square, not derived from documentation, and are easy to
   silently break.
