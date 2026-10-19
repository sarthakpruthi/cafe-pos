# Cafe QR ordering and table management

One cafe, 10 tables. Customers scan a QR code on their table and order from their phone.
The manager and staff see every table on one screen, get a notification for each new order, and the
manager records payments and closes the bill. No kitchen screen and no separate "Orders" page, as the spec requires (`docs/SPEC.md`).

Every screen uses big buttons with words, plain language and no animations, because the people using it may never have used a laptop.

---

## Quick start (about 10 minutes)

You need **Node.js 20 or newer** (https://nodejs.org) and a **Supabase project** (the free plan is fine).
Supabase provides both the PostgreSQL database and staff sign-in.

1. Create a project at https://supabase.com.
2. **Project Settings → Database → Connection string**: copy the **Session pooler** string (port `5432`).
3. **Project Settings → API**: copy the **Project URL**, the **anon public** key and the **service_role** key.
4. **Authentication → Sign In / Providers → Email**: turn **Confirm email** off. Staff sign in with a
   username (the app turns it into an address such as `sam@cafe.local`) and never see an inbox.

```bash
npm install
cp .env.example .env        # fill in the Supabase values (see "Settings" below)
npm run build
npm run setup               # creates the 10 tables, a sample menu, and the manager login
npm start                   # opens on http://localhost:4000
```

`npm run setup` asks you to choose a manager username and password, and creates that login in Supabase.
It is safe to run again; it only adds what is missing.
To skip the sample menu: `npm run setup -- --no-sample-menu`.
To run without questions: `MANAGER_USERNAME=owner MANAGER_PASSWORD=choose-a-password npm run setup`.
If you give no password, a random one is created and printed **once**.

Open http://localhost:4000 and sign in. Then:

1. **Staff logins**: add your staff (they can see tables, add orders, mark items served).
2. **Menu**: change the sample items to your real menu.
3. **QR codes**: print them and stick one on each table.

### More than one cafe

The app can host several cafes. On the login screen staff first pick their cafe from a search
box, then sign in.

- `npm run setup` creates the first (default) cafe from `CAFE_NAME`.
- Further cafes are set up **by whoever runs the system**, never from inside the app: run
  `npm run cafe`, or use the public **/setup** page (no sign-in) with the setup key from
  `ADMIN_SETUP_KEY` in `.env`. Leave `ADMIN_SETUP_KEY` empty to switch that page off.
- A signed-in manager sees only **their own** cafe, on the **My cafe** page, and can rename it.
  There is no screen that lists other cafes, and managers cannot create cafes.
- Each cafe has its own sign-in domain (`<slug>.<STAFF_EMAIL_DOMAIN>`), so the same username —
  `manager`, say — can be used in more than one cafe.
- Everyone changes their own password from **My account**; a manager can also set one from
  **Staff logins**.

Staff logins, roles, and the audit "who did it" are scoped to one cafe. **Tables, the menu and
customer QR ordering are still shared across all cafes for now** — scoping those per cafe is the
next piece of work — so run a single cafe in production until that lands.

### For developers
```bash
npm run dev         # API on :4000 AND web on :5173 together (one terminal)
npm run dev:api     # API only, on :4000 with auto-restart
npm run dev:web     # web only, on :5173, proxies /api to :4000
npm run cafe        # create another cafe (shop) and its first manager
npm test            # 17 automated tests (API + business rules)
npm run typecheck && npm run build
```

## Settings (`.env`)

| Name | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL address (from Supabase — see "Connect to Supabase"). **Empty = built-in local PostgreSQL** stored in `./data/pgdata`. |
| `SUPABASE_URL` | Supabase project URL. **Staff sign-in does not work without it.** |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key. **Server only — keep it secret.** Creates staff logins and resets passwords. |
| `SUPABASE_JWT_SECRET` | Only for older projects, which sign access tokens with a shared secret (**Project Settings → API → JWT Settings**). Leave empty on newer projects, which publish a JWKS instead. |
| `STAFF_EMAIL_DOMAIN` | Staff type a username; the app turns `sam` into `sam@<this domain>` for Supabase. Default `cafe.local`. |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STAFF_EMAIL_DOMAIN` | The same values for the web app. The **anon** key is public and safe to ship. `npm run build` bakes them in, so rebuild after changing them. |
| `FRONTEND_URL` | The public address customers reach, e.g. `https://order.mycafe.in`. **QR codes are built from this**, so set it before printing. |
| `API_BASE_URL` | Same address in the default one-server setup. |
| `AUTH_SECRET` | Long random text used to sign *customer* table-session tokens. **Required in production.** Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_SETUP_KEY` | Lets the public **/setup** page create a cafe and its first manager without signing in. Leave empty to switch that page off. |
| `CAFE_NAME`, `CAFE_TIMEZONE` | Shown on screens; used for "today" in reports. |
| `TABLE_COUNT` | Used by `npm run setup` (default 10). |
| `MAX_TAX_RATE` | Highest tax % allowed on an item (28). |

## Database and migrations

Migrations live in `database/migrations/` and run automatically when the server starts (tracked in `schema_migrations`).
The schema follows the spec (UUID keys, `NUMERIC(12,2)` money, one-open-session-per-table partial unique index, append-only `audit_logs` enforced by a database trigger).

**Backups.** With PostgreSQL: `pg_dump "$DATABASE_URL" > backup.sql`; restore with `psql "$DATABASE_URL" < backup.sql`.
With the built-in database: stop the server and copy the `data/pgdata` folder; to restore, stop the server and put the folder back.

## Connect to Supabase

Supabase provides the database **and** staff sign-in. Point `DATABASE_URL` at its PostgreSQL, add the
`SUPABASE_*` settings, and sign-in, the "Staff logins" page and password resets all run on Supabase Auth.
Storage and Realtime are not used — live updates are built in with Server-Sent Events.

### The database

1. Create a project at https://supabase.com, then open **Project Settings → Database → Connection string**.
2. Copy the **Session pooler** string (port `5432`). It works over IPv4 and keeps the transactions this app
   relies on. The *Direct connection* string also works, but on many networks it is IPv6-only. Do not use the
   *Transaction pooler* (port `6543`) for setup — it does not support every session feature used while
   creating the schema.
3. Put it in `.env` (URL-encode the password if it contains `@ : / ? # [ ]`):

   ```env
   DATABASE_URL=postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```

### Staff sign-in

4. In **Project Settings → API**, copy the **Project URL**, the **anon public** key and the **service_role**
   key into `.env`, and set the domain used to turn usernames into addresses:

   ```env
   SUPABASE_URL=https://abcdefghijklmnop.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...      # server only, never ship this
   VITE_SUPABASE_URL=https://abcdefghijklmnop.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...         # public, this one goes to the browser
   STAFF_EMAIL_DOMAIN=cafe.local
   VITE_STAFF_EMAIL_DOMAIN=cafe.local
   ```

   Staff type a username, so behind the scenes `sam` becomes `sam@cafe.local`. That address is never emailed:
   pick any domain you like, as long as both settings match. (Older projects also need `SUPABASE_JWT_SECRET`;
   newer ones publish a JWKS and can leave it empty.)

5. In **Authentication → Sign In / Providers → Email**, turn **Confirm email** off.

6. Run setup once — it creates the tables, the sample menu and the first manager login, and runs the migrations:

   ```bash
   npm run setup
   ```

7. Start the app: `npm run dev:api` and `npm run dev:web`, or `npm run build && npm start`.

Notes:

* **TLS** is switched on automatically. Supabase signs with its own certificate authority, which Node does
  not trust, so the certificate is **not** verified by default (this is what Supabase's own examples do).
  For full verification, download the project CA (Supabase → Project Settings → Database → SSL
  Configuration) and set `DATABASE_SSL_CA=/path/to/prod-ca-2021.crt`; `DATABASE_SSL=verify` checks against
  Node's built-in list instead.
* **The `public` schema is locked down.** Supabase serves `public` over its REST API with the `anon` key, so
  migration `002_supabase_rls.sql` turns on row level security with no policies. The app connects as the table
  owner, and a table owner bypasses RLS, so it keeps working while the REST API can read nothing.
* **Access tokens** are verified by the API on every request, so switching a login off stops it immediately.
  Live updates carry the token in the URL (EventSource cannot send headers); tokens are short-lived and are
  refreshed by the browser on their own.
* Migrations run automatically whenever the server starts; `schema_migrations` records what has run.

## Deployment

1. Use a host that runs Node.js and gives you HTTPS (Render, Railway, Fly.io, or a VPS behind Caddy/nginx).
2. Use a **managed PostgreSQL** and set `DATABASE_URL` (recommended). If you use the built-in database instead, the host needs a **persistent disk** for `./data`.
3. Set `NODE_ENV=production`, a real `AUTH_SECRET`, the `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` pair, and `FRONTEND_URL`/`API_BASE_URL` to your public `https://` address.
4. Build command: `npm install && npm run build`. Start command: `npm start`. Run `npm run setup` once.
5. Print the QR codes **after** the public address is final.

The server serves both the API and the web app, so it is a single service. The web app is built with the `VITE_*` settings baked in, so set them before `npm run build`. Staff sign in through Supabase Auth using bearer tokens (there is no session cookie to hijack); every write is still checked against a known Origin.

## How it works (short)

* **Staff sign-in** runs on Supabase Auth. The browser signs in with a username (mapped to `username@cafe.local`), Supabase returns an access token, and the API verifies it and loads that person's profile on every request. Passwords live in Supabase; the app never stores one. Customer QR sessions are separate, signed with `AUTH_SECRET`.
* **Realtime** uses Server-Sent Events (`/api/v1/events` for staff, `/api/v1/public/events` for a customer's own table). Events are only hints; screens refetch from the API, and refetch again after any reconnect. Orders survive refresh because the database is the source of truth.
* **Customer access**: the QR token is only used to open a table session. The server then issues a signed, 12-hour customer token tied to that one session; every customer call needs it. Customers never receive payments, staff names or other sessions.
* **Money**: prices are **tax-exclusive**. Tax is rounded to 2 decimals per line (half up), then summed. Pending, rejected and cancelled items are not billed; accepted and served items are. Everything is recalculated on the server from saved snapshots.
* **Closing a table** is blocked while items are still waiting, or while any balance remains; closing the bill and the session is one transaction. The next QR scan opens a fresh session and a new bill.
* **Roles** are enforced in backend middleware. Staff get totals only (no payments, no amounts on the table grid).

## Tests

`npm test` runs 16 tests on an in-memory PostgreSQL: QR resolution for all 10 tables, atomic first scans, multiple orders per session, idempotent retries, accept/reject/serve rules, staff restrictions (403 on direct API calls), menu changes vs. price snapshots, unavailable items, cash/UPI/split/void payments, overpayment, close rules, fresh session after close, audit trail (and that it cannot be edited), reports, token checks (missing, malformed, tampered, and switched-off staff logins), cross-origin writes, live events reaching manager and staff but not payment events to staff, and notifications persisting for people who were offline.

Not automated: browser end-to-end tests (the screens are type-checked and build cleanly, and the server was smoke-tested end to end, but no browser test suite is included), and the duplicate-event handling in the screens (spec scenarios 32 and 34 are handled in code but only checked by reading it).

## Deliberate differences from the spec

* **Database**: when `DATABASE_URL` is empty the app uses PGlite (real PostgreSQL compiled to WebAssembly, stored on disk) so a non-technical owner can start with zero database setup. Staff sign-in still needs a Supabase project, so a real cafe sets `DATABASE_URL` too. For a busy cafe, use a normal PostgreSQL via `DATABASE_URL`; the code and SQL are identical.
* **Realtime** is SSE rather than WebSocket (allowed by the spec; simpler to host).
* **Staff sign-in** is delegated to Supabase Auth instead of the spec's own `POST /api/v1/auth/login`, and usernames are mapped to `username@cafe.local` addresses. The spec's intent is still met — backend role authorization on every call, passwords hashed (by Supabase), an Origin check on writes, and a profile row that the audit log can point at — but the login/logout/refresh endpoints and the local `password_hash` column are gone.
* **Not built** (v1 optional items): exceptional "force close" of a table (closure is always blocked until settled, as the default rule says), discounts, card payments (the schema allows them, the API and screens do not), image upload (items can store an image URL through the API but the screens do not show images), and drag-and-drop sorting (the menu uses Move up / Move down buttons).
* Bill totals are visible to staff on the table page; payment records and balances are manager-only.
* A QR scan opens the table's session, so a scanned-but-unused table shows as "In use" until the manager closes it (balance 0, so closing is one click).
* **Cafes (shops)** were added beyond the spec's single-cafe v1 scope: staff belong to a cafe, sign in by picking it first, and can change their own password. Tables, the menu and QR ordering are not yet scoped per cafe (see "More than one cafe").

## Project layout

```
apps/api   Express + TypeScript (routes.ts thin; business rules in services/)
apps/web   React + TypeScript (customer/, staff/, shared/)
database/migrations   SQL schema
docs/SPEC.md          the specification
```
