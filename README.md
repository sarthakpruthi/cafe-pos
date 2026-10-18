# Cafe QR ordering and table management

One cafe, 10 tables. Customers scan a QR code on their table and order from their phone.
The manager and staff see every table on one screen, get a notification for each new order, and the
manager records payments and closes the bill. No kitchen screen and no separate "Orders" page, as the spec requires (`docs/SPEC.md`).

Every screen uses big buttons with words, plain language and no animations, because the people using it may never have used a laptop.

---

## Quick start (about 5 minutes)

You need **Node.js 20 or newer** (https://nodejs.org).

```bash
npm install
cp .env.example .env        # then edit the values (see "Settings" below)
npm run build
npm run setup               # creates the 10 tables, a sample menu, and the manager login
npm start                   # opens on http://localhost:4000
```

`npm run setup` asks you to choose a manager username and password. It is safe to run again; it only adds what is missing.
To skip the sample menu: `npm run setup -- --no-sample-menu`.
To run without questions: `MANAGER_USERNAME=owner MANAGER_PASSWORD=choose-a-password npm run setup`.
If you give no password, a random one is created and printed **once**.

Open http://localhost:4000 and sign in. Then:

1. **Staff logins**: add your staff (they can see tables, add orders, mark items served).
2. **Menu**: change the sample items to your real menu.
3. **QR codes**: print them and stick one on each table.

### For developers
```bash
npm run dev:api     # API on :4000 with auto-restart
npm run dev:web     # web app on :5173, proxies /api to :4000
npm test            # 16 automated tests (API + business rules)
npm run typecheck && npm run build
```

## Settings (`.env`)

| Name | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL address. **Empty = built-in local PostgreSQL** stored in `./data/pgdata` (see "Database"). |
| `FRONTEND_URL` | The public address customers reach, e.g. `https://order.mycafe.in`. **QR codes are built from this**, so set it before printing. |
| `API_BASE_URL` | Same address in the default one-server setup. |
| `AUTH_SECRET` | Long random text used to sign logins. **Required in production.** Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `CAFE_NAME`, `CAFE_TIMEZONE` | Shown on screens; used for "today" in reports. |
| `TABLE_COUNT` | Used by `npm run setup` (default 10). |
| `MAX_TAX_RATE`, `LOGIN_HOURS` | Highest tax % allowed on an item (28); how long a sign-in lasts (12 hours). |

## Database and migrations

Migrations live in `database/migrations/` and run automatically when the server starts (tracked in `schema_migrations`).
The schema follows the spec (UUID keys, `NUMERIC(12,2)` money, one-open-session-per-table partial unique index, append-only `audit_logs` enforced by a database trigger).

**Backups.** With PostgreSQL: `pg_dump "$DATABASE_URL" > backup.sql`; restore with `psql "$DATABASE_URL" < backup.sql`.
With the built-in database: stop the server and copy the `data/pgdata` folder; to restore, stop the server and put the folder back.

## Connect to Supabase

Supabase is managed PostgreSQL, so no code changes are needed — you just point `DATABASE_URL` at it. The API
creates its own tables on first start and does **not** use Supabase Auth, Storage or Realtime (logins and
live updates are built in).

1. Create a project at https://supabase.com, then open **Project Settings → Database → Connection string**.
2. Copy the **Session pooler** string (port `5432`). It works over IPv4 and keeps the transactions this app
   relies on. The *Direct connection* string also works, but on many networks it is IPv6-only. Do not use the
   *Transaction pooler* (port `6543`) for setup — it does not support every session feature used while
   creating the schema.
3. Put it in `.env` (URL-encode the password if it contains `@ : / ? # [ ]`):

   ```env
   DATABASE_URL=postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```

4. Run setup once — it creates the tables, the sample menu and the manager login, and runs the migrations:

   ```bash
   npm run setup
   ```

5. Start the app: `npm run dev:api`, or `npm run build && npm start`.

Notes:

* **TLS** is turned on automatically for any non-local host. If certificate checks fail on your network,
  append `?sslmode=no-verify` to `DATABASE_URL` (or set `DATABASE_SSL=no-verify`).
* **The `public` schema is locked down.** Supabase serves `public` over its REST API with the `anon` key, so
  migration `002_supabase_rls.sql` turns on row level security with no policies. The app connects as the table
  owner, and a table owner bypasses RLS, so it keeps working while the REST API can read nothing.
* Migrations run automatically whenever the server starts; `schema_migrations` records what has run.

## Deployment

1. Use a host that runs Node.js and gives you HTTPS (Render, Railway, Fly.io, or a VPS behind Caddy/nginx).
2. Use a **managed PostgreSQL** and set `DATABASE_URL` (recommended). If you use the built-in database instead, the host needs a **persistent disk** for `./data`.
3. Set `NODE_ENV=production`, a real `AUTH_SECRET`, and `FRONTEND_URL`/`API_BASE_URL` to your public `https://` address.
4. Build command: `npm install && npm run build`. Start command: `npm start`. Run `npm run setup` once.
5. Print the QR codes **after** the public address is final.

The server serves both the API and the web app, so it is a single service. Logins are cookie-based (`HttpOnly`, `SameSite=Lax`, `Secure` in production) with an Origin check on every write.

## How it works (short)

* **Realtime** uses Server-Sent Events (`/api/v1/events` for staff, `/api/v1/public/events` for a customer's own table). Events are only hints; screens refetch from the API, and refetch again after any reconnect. Orders survive refresh because the database is the source of truth.
* **Customer access**: the QR token is only used to open a table session. The server then issues a signed, 12-hour customer token tied to that one session; every customer call needs it. Customers never receive payments, staff names or other sessions.
* **Money**: prices are **tax-exclusive**. Tax is rounded to 2 decimals per line (half up), then summed. Pending, rejected and cancelled items are not billed; accepted and served items are. Everything is recalculated on the server from saved snapshots.
* **Closing a table** is blocked while items are still waiting, or while any balance remains; closing the bill and the session is one transaction. The next QR scan opens a fresh session and a new bill.
* **Roles** are enforced in backend middleware. Staff get totals only (no payments, no amounts on the table grid).

## Tests

`npm test` runs 16 tests on an in-memory PostgreSQL: QR resolution for all 10 tables, atomic first scans, multiple orders per session, idempotent retries, accept/reject/serve rules, staff restrictions (403 on direct API calls), menu changes vs. price snapshots, unavailable items, cash/UPI/split/void payments, overpayment, close rules, fresh session after close, audit trail (and that it cannot be edited), reports, login throttling, cross-origin writes, live events reaching manager and staff but not payment events to staff, and notifications persisting for people who were offline.

Not automated: browser end-to-end tests (the screens are type-checked and build cleanly, and the server was smoke-tested end to end, but no browser test suite is included), and the duplicate-event handling in the screens (spec scenarios 32 and 34 are handled in code but only checked by reading it).

## Deliberate differences from the spec

* **Database**: when `DATABASE_URL` is empty the app uses PGlite (real PostgreSQL compiled to WebAssembly, stored on disk) so a non-technical owner can start with zero database setup. For a busy cafe, use a normal PostgreSQL via `DATABASE_URL`; the code and SQL are identical.
* **Realtime** is SSE rather than WebSocket (allowed by the spec; simpler to host).
* **Not built** (v1 optional items): exceptional "force close" of a table (closure is always blocked until settled, as the default rule says), discounts, card payments (the schema allows them, the API and screens do not), image upload (items can store an image URL through the API but the screens do not show images), and drag-and-drop sorting (the menu uses Move up / Move down buttons).
* Bill totals are visible to staff on the table page; payment records and balances are manager-only.
* A QR scan opens the table's session, so a scanned-but-unused table shows as "In use" until the manager closes it (balance 0, so closing is one click).

## Project layout

```
apps/api   Express + TypeScript (routes.ts thin; business rules in services/)
apps/web   React + TypeScript (customer/, staff/, shared/)
database/migrations   SQL schema
docs/SPEC.md          the specification
```
