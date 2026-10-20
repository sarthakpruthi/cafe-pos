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

- Node.js 20.12 or newer.
- A Cloudflare account (the **free** plan is fine) and `npx wrangler login` once.
- A **Supabase** project (already used for staff sign-in) for Postgres + Auth.

## 1. Install and check the build inputs

```bash
npm install
npx wrangler login
```

The web bundle is built from the repo-root `.env` (Vite's `envDir`), so set these **before**
deploying — they are baked into the browser bundle at build time:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
VITE_STAFF_EMAIL_DOMAIN=cafe.local
```

`VITE_STAFF_EMAIL_DOMAIN` must equal the Worker's `STAFF_EMAIL_DOMAIN` (both `cafe.local` by
default), and `CAFE_NAME`/`CAFE_TIMEZONE` in `.env` should match the same values in `wrangler.jsonc`.

## 2. Create the Hyperdrive config

Hyperdrive pools the Postgres connection for the Worker. Create it once against your Supabase
connection string (Supabase → Project Settings → Database → **Session pooler**, port 5432):

```bash
npx wrangler hyperdrive create cafe-db --caching-disabled \
  --connection-string "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require"
```

`--caching-disabled` matters: Hyperdrive otherwise caches `SELECT` results for 60 seconds and does
**not** invalidate them on writes, so a customer would see a stale order list or bill right after
ordering. Copy the `id` it prints into `wrangler.jsonc`, replacing `<your-hyperdrive-id>`.

If you already created it without the flag, turn caching off with:

```bash
npx wrangler hyperdrive update <id> --caching-disabled
```

## 3. Fill in the non-secret settings

In `wrangler.jsonc` under `vars`, set `SUPABASE_URL` to your project URL (e.g.
`https://abcdefgh.supabase.co`). Leave `FRONTEND_URL` and `API_BASE_URL` for step 5.

## 4. Deploy once to get the URL

```bash
npm run deploy        # builds the web app, then `wrangler deploy`
```

Wrangler prints the Worker URL, e.g. `https://cafe-ordering.<subdomain>.workers.dev`. This first
deploy can be incomplete (secrets and the final URLs are still missing) — it exists so later
commands and the second deploy have a Worker to target. Copy the URL exactly.

## 5. Add the secrets and point the app at itself

```bash
npx wrangler secret put AUTH_SECRET                    # 32+ random chars; signs customer QR tokens
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY      # server-only key, used to manage staff logins
npx wrangler secret put SUPABASE_JWT_SECRET            # only for older Supabase projects; otherwise skip
npx wrangler secret put ADMIN_SETUP_KEY                # optional; enables /setup for extra cafes
```

Generate `AUTH_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Then put the URL from step 4 into **both** `FRONTEND_URL` and `API_BASE_URL` in `wrangler.jsonc`
(or use a custom domain from step 8), and deploy again:

```bash
npm run deploy
```

They must match the browser origin exactly. Do this **before printing any table QR codes** — the
printed link is baked into the QR image.

## 6. Create the database schema

A Worker has no filesystem, so migrations do **not** run there. Apply them from your machine, which
does have one, using the same migration files:

```bash
DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require" \
  npm run migrate
```

Safe to run repeatedly. Re-run it after deploying any change that adds a file to `database/migrations`.
This also renames the default cafe to `CAFE_NAME` and sets its sign-in domain to `STAFF_EMAIL_DOMAIN`.

## 7. Create the tables, sample menu and first manager

The web `/setup` page creates an **additional** cafe, not its tables. For the first (default) cafe,
run the setup script against the production database:

```bash
DATABASE_URL="postgresql://...supabase..." \
MANAGER_USERNAME=manager MANAGER_PASSWORD='choose-a-strong-one' TABLE_COUNT=10 \
  npm run setup
```

This creates table rows with QR tokens, a sample menu (edit or delete it from the Menu page), and a
manager login. Sign in at `/login` by picking the cafe whose name matches `CAFE_NAME` (default
**The TeaPot Cafe**) and typing that username and password. Additional cafes can be created later at
`/setup` with `ADMIN_SETUP_KEY`, or with `npm run cafe`; note that tables and the menu are currently
shared by all cafes.

## 8. Custom domain (recommended)

A custom domain gives a stable `FRONTEND_URL` that never changes when the Worker is redeployed. Add
it in the dashboard (Workers & Pages → your Worker → Settings → Domains & Routes), set
`FRONTEND_URL` and `API_BASE_URL` to it, redeploy, then (re)print the QR codes.

## Verify

```bash
curl -sS https://<your-url>/api/v1/public/cafes        # {"cafes":[...]} — proves Worker + Hyperdrive + Express
curl -sS https://<your-url>/api/v1/public/menu | head -c 200   # proves the schema was migrated
npx wrangler tail                                      # live logs while you use the app
```

Then open the site, sign in at `/login`, open **QR codes**, and scan one with a phone. A test order
should appear on the staff screen without a refresh. If it does, the SSE path through the Durable
Object is working.

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
- **Migrations are manual.** Run `npm run migrate` (step 6) after changing `database/migrations`.
- **Hyperdrive caching must stay off.** It is disabled with `--caching-disabled` when the config is
  created (step 2). With default caching, reads can be up to 60 seconds stale and are not invalidated
  by writes — orders, bills and staff permissions would look wrong right after a change.
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
| `relation "..." does not exist` | Migrations were never applied — run `npm run migrate` (step 6). |
| `require_streams(...) is not a function` at startup | The `iconv-lite` alias in `wrangler.jsonc` was removed. |
| `AUTH_SECRET must be set to a long random value in production.` | `npx wrangler secret put AUTH_SECRET` (step 5). |
| `SUPABASE_URL must be set in production` | Set `SUPABASE_URL` under `vars` in `wrangler.jsonc` (step 3) and redeploy. |
| Order status or bill looks stale for up to a minute | Hyperdrive query caching is on. Recreate it with `--caching-disabled` (step 2). |
| QR codes page is empty | No `cafe_tables` rows: run `npm run setup` with `TABLE_COUNT` (step 7), or create tables in the database. |
| `This request came from an unknown website.` | `FRONTEND_URL`/`API_BASE_URL` do not match the browser origin. |
| QR links point at the wrong host | `FRONTEND_URL` was not updated before printing. Regenerate the QR codes after fixing it. |
| Live updates stop after a while | Client disconnects: `EventSource` reconnects on its own and the screens resync from the API. No data is lost. |
| Staff sign-in fails | `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` wrong, or `VITE_SUPABASE_*` not set when the web app was built. |
