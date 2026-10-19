# Deploying on Cloudflare (Workers Free plan)

The whole app runs on Cloudflare's **free** tier: one Worker serves the React app from static
assets, runs the existing Express API, and owns the live-update stream. No containers (they require
the paid Workers plan) and no Docker.

```
                      ┌──────────────────────── Worker: cafe-ordering ────────────────────────┐
   browser ────────►  │  /api/v1/events, /api/v1/public/events ─► RealtimeHub (Durable Object) │
   (one origin)       │  /api/*  ─► Express on Workers (cloudflare:node) ─► HYPERDRIVE ───────┼──► Supabase
                      │  /*      ─► static assets (apps/web/dist)                             │    Postgres + Auth
                      └───────────────────────────────────────────────────────────────────────┘
```

**Why one origin:** `apps/web/src/shared/api.ts` calls `/api/v1` on the page's own origin, the API's
`originCheck` only trusts `FRONTEND_URL`/`API_BASE_URL`, and QR codes are built from `FRONTEND_URL`.
Splitting the web app and API across two hostnames would break all three, so the Worker serves both.

## What free means here

| Piece | Service | Free-tier allowance |
| --- | --- | --- |
| React app | Workers static assets | unlimited requests, 20k files |
| Express API | Workers + `cloudflare:node` | 100,000 requests/day |
| Postgres pooling | **Hyperdrive** | 100,000 queries/day |
| Live updates (SSE) | **Durable Object** (SQLite) | 100,000 requests/day, 13,000 GB-s/day |
| Database + staff auth | Supabase | your existing project's free tier |

One Durable Object holds every open SSE stream, so it stays awake while any staff screen or customer
page is connected: about **11,000 GB-s/day** if a screen is open 24/7, inside the 13,000 GB-s/day
free allowance. When the last screen closes the object goes idle.

## Files added

| File | Purpose |
| --- | --- |
| `wrangler.jsonc` | Worker entry, static assets, Hyperdrive, Durable Object, `iconv-lite` alias |
| `worker/index.ts` | Routes SSE to the Durable Object, `/api/*` to Express, everything else to assets |
| `worker/realtime-do.ts` | `RealtimeHub`: holds the SSE connections and fans events out |
| `worker/stream.ts` | Authorizes the two SSE endpoints before handing them to the hub |
| `worker/iconv-lite.ts` | Minimal stand-in for a dependency Express pulls in that cannot run on workerd |
| `worker/env.ts`, `worker/tsconfig.json` | Bindings type and type-check settings |
| `apps/api/src/drivers/node.ts` | Node database driver: `pg`, or built-in PGlite (CLI, `npm run dev`, tests) |
| `apps/api/src/drivers/worker.ts` | Workers database driver: `pg` over Hyperdrive, one client per request |
| `apps/api/src/db.ts` | The `db` / `withTx` surface both drivers plug into |
| `apps/api/src/body.ts` | Hand-rolled JSON body parser (see "Why not `express.json()`") |
| `apps/api/src/migrate.ts` | `npm run migrate` — applies migrations from a machine with a filesystem |
| `.dev.vars.example` | Local secrets for `wrangler dev` (copy to `.dev.vars`) |

## Prerequisites

- A Cloudflare account (the **free** plan is fine) and `npx wrangler login` once.
- A **Supabase** project (already used for staff sign-in) for Postgres + Auth.

## 1. Install and build

```bash
npm install
```

The web bundle is built from the repo-root `.env` (Vite's `envDir`), so set these **before**
deploying — they are baked into the browser bundle at build time:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_STAFF_EMAIL_DOMAIN=cafe.local
```

## 2. Create the Hyperdrive config

Hyperdrive pools the Postgres connection for the Worker. Create it once against your Supabase
connection string (Supabase → Project Settings → Database → **Session pooler**, port 5432):

```bash
npx wrangler hyperdrive create cafe-db --connection-string "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"
```

Copy the `id` it prints into `wrangler.jsonc`, replacing `<your-hyperdrive-id>`.

## 3. Fill in the non-secret settings

In `wrangler.jsonc` under `vars`, set `SUPABASE_URL` to your project URL. Leave `FRONTEND_URL` and
`API_BASE_URL` for step 6.

## 4. Add the secrets

```bash
npx wrangler secret put AUTH_SECRET                   # long random value; signs customer QR tokens
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY     # server-only key, used to manage staff logins
npx wrangler secret put SUPABASE_JWT_SECRET           # only for older projects; otherwise skip
npx wrangler secret put ADMIN_SETUP_KEY               # optional; lets /setup create the first manager
```

## 5. Create the database schema

A Worker has no filesystem, so migrations do **not** run there. Apply them from your machine, which
does have one, using the same migration files:

```bash
DATABASE_URL="postgresql://...supabase..." npm run migrate
```

Safe to run repeatedly. Re-run it after deploying any change that adds a file to `database/migrations`.

## 6. Deploy, then point the app at itself

```bash
npm run deploy        # builds the web app, then `wrangler deploy`
```

Now copy the `*.workers.dev` URL that Wrangler prints into **both** `FRONTEND_URL` and `API_BASE_URL`
in `wrangler.jsonc` (or use a custom domain from step 8), and deploy again:

```bash
npm run deploy
```

Do this **before printing any table QR codes** — the printed link is baked into the QR image.

## 7. First manager

Open `https://<your-url>/setup` and enter the `ADMIN_SETUP_KEY`. Once a manager exists you can clear
`ADMIN_SETUP_KEY` if you want the setup page switched off.

## 8. Custom domain (recommended)

A custom domain gives a stable `FRONTEND_URL` that never changes when the Worker is redeployed. Add
it in the dashboard (Workers & Pages → your Worker → Settings → Domains & Routes), set
`FRONTEND_URL` and `API_BASE_URL` to it, redeploy, then (re)print the QR codes.

## Local preview

`npm run dev` (tsx + Vite) is unchanged and needs nothing from Cloudflare.

To exercise the real Worker locally, `wrangler dev` needs a Postgres it can reach, because Hyperdrive
is emulated:

```bash
cp .dev.vars.example .dev.vars     # fill in AUTH_SECRET, SUPABASE_URL, ...
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="postgresql://..." npm run cf:preview
```

## Notes and limitations

- **Realtime stays SSE**, now fanned out by a Durable Object instead of an in-process `Set`. That is
  what makes it correct across Worker isolates: a stream opened on one isolate still sees events
  published from another.
- **Migrations are manual.** Run `npm run migrate` (step 5) after changing `database/migrations`.
- **Rate limiting is per isolate.** `apps/api/src/auth.ts` keeps counters in memory, so the limits
  are best-effort once Cloudflare runs more than one isolate. Fine for a single cafe.
- **SSE bypasses the Express middleware.** The two `*/events` routes are answered by the Worker, so
  requests there skip `cors`/`originCheck`/rate limiting — they still require a valid signed token.
- **The `iconv-lite` alias is load-bearing.** Express imports body-parser (→ raw-body → iconv-lite)
  the moment it loads, and iconv-lite's browser build throws on workerd. `worker/iconv-lite.ts`
  replaces it. Removing the `alias` from `wrangler.jsonc` will stop the Worker from starting.
- **Why not `express.json()`:** it pulls in the same chain. `apps/api/src/body.ts` parses JSON
  directly, which also keeps the bundle smaller.
- **Free limits.** 100,000 Worker requests/day and 100,000 Hyperdrive queries/day are far above a
  single cafe's traffic, but they are daily and reset at 00:00 UTC.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `Worker has access to ... env.HYPERDRIVE (<your-hyperdrive-id>)` | You have not replaced the placeholder id (step 2). |
| Local `wrangler dev` refuses to start, mentioning `localConnectionString` | Set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`. |
| `relation "..." does not exist` | Migrations were never applied — run `npm run migrate` (step 5). |
| `require_streams(...) is not a function` at startup | The `iconv-lite` alias in `wrangler.jsonc` was removed. |
| `AUTH_SECRET must be set to a long random value in production.` | `npx wrangler secret put AUTH_SECRET` (step 4). |
| `This request came from an unknown website.` | `FRONTEND_URL`/`API_BASE_URL` do not match the browser origin. |
| QR links point at the wrong host | `FRONTEND_URL` was not updated before printing. Regenerate the QR codes after fixing it. |
| Live updates stop after a while | Client disconnects: `EventSource` reconnects on its own and the screens resync from the API. No data is lost. |
| Staff sign-in fails | `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` wrong, or `VITE_SUPABASE_*` not set when the web app was built. |
