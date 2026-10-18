# Cafe QR Ordering & Table Management System

## Product Requirements, User Journeys, Data Model, API Contract, and Build Instructions

**Document version:** 1.0\
**Purpose:** This is the implementation specification for an AI coding
agent or engineering team. Build the application to this specification;
do not substitute a kitchen-display workflow or a separate global orders
dashboard.

------------------------------------------------------------------------

# 1. Product Overview

Build a lightweight cafe ordering and table-management web application
for one cafe with 10 tables.

There are three user experiences:

1.  **Customer:** Scans a table-specific QR code, views the current
    menu, adds items to a cart, and submits one or more orders during
    the same active table session.
2.  **Manager:** Sees all tables, opens a table to see its combined
    queue and running bill, accepts or rejects orders/items, marks
    items/orders served, manages the menu, records payments, and closes
    bills/sessions.
3.  **Staff:** Sees all tables, opens a table to see its queue, creates
    additional orders on behalf of customers, updates permitted item
    details, and marks accepted items/orders served. Staff cannot
    reject/delete orders, manage the menu, record payments, or close
    sessions.

There is **no kitchen screen**, **no preparing status**, and **no
separate global Orders page**. New orders appear within the relevant
table's existing queue. A notification must alert manager and staff when
a customer submits an order.

Recommended implementation stack (unless the coding agent has a strong
reason to change it): - Frontend: React + TypeScript - Backend:
Node.js + TypeScript + Express - Database: PostgreSQL - Realtime:
WebSocket or a managed realtime service, such as Supabase Realtime -
Authentication: secure manager/staff login with role-based
authorization - Deployment: frontend and API hosted on production-grade
services; PostgreSQL managed or self-hosted - QR code: each table has a
distinct, unguessable public QR token; all tables use the same menu

The database is the source of truth. Realtime messages notify connected
clients, but clients must be able to recover by refetching the API.

# 2. Scope

## In scope

-   One cafe/outlet and 10 configurable tables
-   Table-specific QR codes
-   Public customer menu, section browsing, search, cart, and order
    submission
-   Multiple submissions during one active table session
-   Table-centric manager and staff dashboards
-   Realtime order notifications and queue updates
-   Whole-order and individual-item acceptance/rejection
-   Whole-order and individual-item served status
-   Manager menu management: create/update/deactivate sections and items
-   Live menu updates for customers opening/scanning the QR
-   One running bill per table session
-   Cash, UPI, and split payments
-   Bill closure and table-session closure
-   Fresh session for the next group after closure
-   Audit history for privileged actions
-   Validation, error handling, and basic reporting

## Out of scope for version 1

-   Kitchen display or kitchen workflow
-   `PREPARING` status
-   Online payment gateway integration or automatic UPI payment
    verification
-   Customer account creation
-   Delivery/takeaway marketplace integrations
-   Inventory, recipes, purchase orders, loyalty, reservations
-   Multi-outlet support (design IDs so it can be added later, but do
    not build it now)
-   Fiscal/accounting integrations beyond recording applicable taxes and
    payment methods

# 3. Core Domain Rules

These rules are mandatory.

1.  **Table, session, order, bill, and cart are separate concepts.**
2.  A table has one active session at most.
3.  A session represents one group/visit at one table.
4.  A session may contain many order submissions.
5.  Each customer submission creates a new order record. Do not merge
    separate submissions into one order record.
6.  The UI groups every order for the active session into one table
    queue.
7.  All orders in the same session contribute to the same running bill,
    subject to rejected/cancelled items being excluded.
8.  A customer may submit multiple orders during an active session.
9.  When a table session is closed, new submissions using its old
    session ID must be rejected. The next valid QR visit must use a new
    session.
10. The customer QR is table-specific but the menu is shared across
    tables.
11. Customers must receive the latest active menu from the server when
    they open/reopen the QR page. Do not bundle a static menu into the
    frontend.
12. Menu edits affect future submissions only. Existing order items and
    bills retain snapshots of the item name, unit price, and tax rate at
    the time of submission.
13. Manager and staff receive a notification when a new customer order
    is submitted. The notification opens the affected table, not a
    global orders dashboard.
14. Only manager can accept/reject an order or item. Staff can mark
    accepted items as served and create orders on behalf of customers.
15. No `PREPARING` state exists.
16. Payment is manually recorded. For UPI, the manager verifies payment
    in the merchant's UPI app before recording it as successful.
17. Normal session closure requires all payable balances to be zero and
    no unresolved pending items/orders. Provide a manager-only
    exceptional closure path only if deliberately implemented with a
    required reason and audit record; default behavior should block
    closure.
18. Never physically delete historical orders, order items, payments,
    closed sessions, or audit logs. Use statuses/soft-deactivation and
    audit trails.
19. Backend authorization is mandatory. Hiding a button in the UI is not
    security.
20. Totals, taxes, balances, and aggregate statuses are computed or
    validated server-side; do not trust client-provided totals.

# 4. Roles and Permissions

## Customer (public QR session)

-   View active menu sections/items
-   Search and filter menu
-   Create/update a local cart before submission
-   Submit an order to the active session
-   See their submitted orders and item statuses for that session
-   Submit another order while the session remains open
-   Cannot accept/reject items, mark served, change menu, view
    staff-only payment records, or close the session
-   No permanent account required

Important guest privacy rule: the QR token identifies a table, not a
secret for accessing all historical guest information. The
customer-facing session endpoint should expose only the active session's
limited customer-visible data. Do not expose payments, staff identities,
internal audit logs, or historical sessions.

## Manager

-   Everything staff can do, plus:
-   View all tables and their active/available state
-   View all orders and items grouped under each table's active session
-   Accept or reject an entire order
-   Accept or reject individual items
-   Mark an accepted item served or mark an order served when all
    eligible items are served
-   Edit/correct order items according to the rules below
-   View the running bill and payment history
-   Record cash, UPI, or split payments
-   Close a fully settled bill and table session
-   Create/update/deactivate menu sections and items
-   View audit logs and daily payment summaries
-   Optionally regenerate a table QR token if compromised

## Staff

-   Login
-   View table overview and active table queues
-   Open a table and view current session orders/items and bill summary
-   Add items / submit an additional order on behalf of a customer
-   Update permitted item details before acceptance, subject to audit
    logging
-   Mark accepted items served
-   Use "Mark order served" only when all eligible items have been
    served
-   Cannot accept/reject orders/items
-   Cannot delete/cancel submitted orders
-   Cannot change menu sections/items
-   Cannot record payments or apply discounts
-   Cannot close bills or sessions

## Authentication

-   Customer: no login; public QR token + active session.
-   Manager/staff: authenticated session/JWT with server-side role
    checks.
-   Store password hashes using a standard password-hashing algorithm
    (e.g. Argon2id or bcrypt with suitable work factor). Never store
    plaintext passwords.
-   Add login throttling and secure cookie/token handling.
-   A manager may create/deactivate staff users. If user administration
    is included in v1, provide endpoints for it; otherwise seed
    manager/staff users securely through a documented setup command.

# 5. User Journeys

## 5.1 Customer journey

1.  Customer scans the QR code on Table N.
2.  Frontend resolves the QR token through the API.
3.  API finds or creates the active session for that table, subject to
    the session rules.
4.  Frontend fetches the current active menu from the server.
5.  Customer browses sections, searches, filters by veg/non-veg/egg if
    configured, and opens item details.
6.  Customer chooses quantity and optional item notes/customizations.
7.  Customer reviews the cart and submits.
8.  Backend validates the session is still open, item availability,
    quantities, and current prices/taxes. Backend recalculates totals
    and saves order/items transactionally.
9.  API returns the created order and item statuses.
10. Manager and staff receive a realtime `order.created` notification
    and the table queue updates without a manual refresh.
11. Customer sees submission confirmation and order/item status.
12. Customer can return to the menu and submit another order. Each
    submission creates a separate order linked to the same session.
13. After the manager closes the session, old session submission
    requests fail with a clear `SESSION_CLOSED` response. The customer
    must reload/reopen the table QR flow to resolve the current session.
    Do not silently append to a closed session.

## 5.2 Manager journey

1.  Login.
2.  View a clean table grid: available/occupied, pending-order
    indicator, number of pending items, and running bill amount.
3.  Click a table.
4.  See one table page with all submissions grouped chronologically
    (Order #1, Order #2, etc.), item rows, notes, status, and running
    total. No separate global Orders page.
5.  Receive notification when a new order arrives. Clicking notification
    opens that table.
6.  Accept/reject a whole order or individual items.
7.  Rejected items require a reason and are excluded from the bill.
    Preserve them in history.
8.  Mark accepted items served; may use a whole-order shortcut when
    eligible.
9.  Open menu management to create/update/deactivate sections/items.
    Changes become available to customers on the next menu fetch and can
    be pushed to already-open customer pages using realtime menu-change
    events.
10. Review bill and record cash/UPI/split payment.
11. Close bill/session only when closure rules are met.
12. Table returns to available. The next customer starts a new session
    and receives a fresh running bill.

## 5.3 Staff journey

1.  Login.
2.  View table grid with available/occupied and pending indicators.
3.  Open an occupied table and view the combined queue.
4.  Add an order for the table if requested by a customer. This creates
    a new order submission in the same session.
5.  Update allowed details only while permitted (e.g. before manager
    acceptance); changes are logged.
6.  Mark accepted items served. The system rejects attempts to serve
    pending or rejected items.
7.  Staff cannot accept/reject, record payment, edit menu, or close
    session.

## 5.4 Manager menu-management journey

1.  Open "Menu" from manager navigation.
2.  View sections and their items, with active/unavailable state.
3.  Create a section with name and optional description/sort order.
4.  Edit section name, description, order, or active state.
5.  Create an item within a section with name, description, food type,
    price, tax rate/category, availability, image (optional), and sort
    order.
6.  Edit item details and save.
7.  Mark an item unavailable or deactivate it rather than deleting it if
    it appears in historical orders.
8.  Customers opening the QR menu after the change see the new data.
    Existing submitted order snapshots do not change.
9.  Validate that price is non-negative, tax rate is within configured
    limits, and section/item names are not blank.

# 6. UI Requirements

## 6.1 Customer pages

-   `/t/:qrToken` or equivalent public QR route.
-   Responsive mobile-first layout.
-   Header shows cafe name and table number; do not show internal
    database IDs.
-   Menu sections, search field, optional food-type filters.
-   Item card: name, description, food-type label, price, availability,
    quantity controls, optional notes.
-   Cart drawer/page with item quantities, notes, subtotal/tax/estimated
    total, and submit button.
-   Disable adding unavailable items.
-   Submission progress, success confirmation, and duplicate-submit
    prevention.
-   Current session order history with order number, item
    names/quantities, statuses, and rejection reason if appropriate.
-   Live status updates.
-   If session is closed, explain that ordering is no longer available
    and prompt the customer to refresh/reopen QR flow.
-   Avoid showing manager-only data, payment details, or internal audit
    fields.

## 6.2 Manager pages

Navigation: - **Tables** (default landing page) - **Menu** - **Payments
/ Reports** - **Audit Log** (optional but recommended)

Tables grid: - All configured tables. - Status: Available / Occupied. -
Pending indicator and pending-item count. - Running bill amount. - Last
activity / age of active session where useful. - Clicking a table opens
its queue.

Table detail: - Table number, session start time, table/session state. -
Combined order queue grouped by order submission, newest or oldest first
(choose one consistently; default oldest first). - Per-item status,
quantity, notes, unit price, tax and line total. - Buttons: Accept item,
Reject item, Mark served. - Order-level shortcuts: Accept all eligible
items, Reject all eligible items, Mark all eligible items served. -
Reject action requires reason and confirmation. - Running bill:
subtotal, tax, discounts (discounts optional; omit if not implemented),
total, paid, balance. - Payment controls and close-session control for
manager only. - Show realtime update indicators without blocking the UI.

Menu management: - Sections list with add/edit/reorder/deactivate. -
Items within section with add/edit/mark unavailable/deactivate. - Price,
food type, tax, availability clearly visible. - Confirm
destructive-looking actions, but prefer deactivation to deletion. -
Search/filter items.

## 6.3 Staff pages

-   Tables as landing page.
-   Table detail with combined order queue.
-   Add order/add items flow.
-   Allowed item updates.
-   Mark accepted items served.
-   No manager-only controls should appear, and backend must reject
    unauthorized API calls.

## 6.4 Notification behavior

-   On successful customer order creation, send realtime event to all
    currently authenticated manager/staff clients.
-   Toast/banner: "New order for Table N" plus order number and item
    count.
-   Notification click opens that table detail.
-   Table card gets a pending badge/count.
-   Optional sound can be enabled by the user; respect browser autoplay
    restrictions.
-   If manager/staff is disconnected, show a reconnect state and refetch
    table summaries/queues on reconnect.
-   Realtime is an enhancement, not the persistence layer. Orders must
    remain visible after refresh.
-   Avoid duplicate notifications when the client receives a realtime
    event and also refetches; deduplicate by event/order ID.

# 7. Status and Transition Rules

## 7.1 Item statuses

Use: - `PENDING` - `ACCEPTED` - `SERVED` - `REJECTED` - `CANCELLED`
(manager-only, if cancellation is implemented)

No `PREPARING` or `READY` status.

Allowed transitions: - `PENDING -> ACCEPTED` (manager) -
`PENDING -> REJECTED` (manager, reason required) - `ACCEPTED -> SERVED`
(staff or manager) - `PENDING -> CANCELLED` only if implemented under
manager policy - `ACCEPTED -> CANCELLED` only through manager correction
flow with reason and audit; do not silently delete it - `SERVED`,
`REJECTED`, and `CANCELLED` are terminal for normal users. Corrections
require a separate audited manager action if supported.

Staff may not change `PENDING` to `ACCEPTED` or `REJECTED`.

## 7.2 Order status

Order status should be computed from item statuses, or updated
atomically from them. Do not allow the order status to contradict its
items.

Suggested aggregate statuses: - `PENDING`: all items are pending -
`PARTIALLY_ACCEPTED`: at least one accepted/served item and at least one
pending item - `ACCEPTED`: all non-rejected/non-cancelled items are
accepted or served, and at least one is accepted but not all are
served - `PARTIALLY_SERVED`: at least one served item and at least one
eligible item not served - `SERVED`: all payable/eligible items are
served - `REJECTED`: all items rejected - `PARTIALLY_REJECTED`: at least
one rejected item and at least one non-rejected item - `CANCELLED`: all
items cancelled/rejected or the order is explicitly cancelled by manager

Implement a single backend aggregation function and cover it with tests.
If the order is mixed (e.g. one pending and one rejected), show a
meaningful aggregate state and use item statuses as the authoritative
details.

## 7.3 Bill and session statuses

Bill: - `OPEN` - `PARTIALLY_PAID` - `PAID` - `CLOSED` - `VOID`
(manager-only, if implemented with reason)

Session: - `OPEN` - `CLOSED`

Table availability is derived from whether the table has an OPEN
session; do not store a separately editable availability state that can
conflict with session state.

# 8. Data Model / Database Schema

Use UUID primary keys where appropriate, timestamps in UTC, and database
constraints. Money should use `NUMERIC(12,2)` or integer minor units; do
not use floating-point numbers for currency. Store tax as a decimal
percentage or a reference to a tax category. Define rounding rules and
use them consistently.

## 8.1 `cafe_tables`

-   `id` UUID PK
-   `table_number` VARCHAR, unique (e.g. `1`, `2`, `A1`)
-   `display_name` nullable
-   `qr_token` VARCHAR, unique, random and unguessable
-   `is_active` BOOLEAN default true
-   `created_at`, `updated_at`

## 8.2 `menu_sections`

-   `id` UUID PK
-   `name` VARCHAR not null
-   `description` TEXT nullable
-   `sort_order` INTEGER default 0
-   `is_active` BOOLEAN default true
-   `created_at`, `updated_at`
-   Unique active section names recommended (case-insensitive if
    practical).

## 8.3 `menu_items`

-   `id` UUID PK
-   `section_id` UUID FK -\> menu_sections
-   `name` VARCHAR not null
-   `description` TEXT nullable
-   `food_type` ENUM: `VEG`, `NON_VEG`, `EGG` (allow configurable values
    if desired)
-   `price` NUMERIC(12,2) not null, \>= 0
-   `tax_rate` NUMERIC(5,2) not null, \>= 0 (set a sensible
    maximum/configuration limit)
-   `is_available` BOOLEAN default true
-   `image_url` TEXT nullable
-   `sort_order` INTEGER default 0
-   `created_at`, `updated_at`
-   Prefer soft deactivation/unavailability over deletion.

## 8.4 `users`

-   `id` UUID PK
-   `name` VARCHAR not null
-   `email` or `username` unique not null
-   `password_hash` not null
-   `role` ENUM: `MANAGER`, `STAFF`
-   `is_active` BOOLEAN default true
-   `last_login_at` nullable
-   `created_at`, `updated_at`
-   If multiple roles per person are needed later, normalize to
    roles/user_roles; one role field is adequate for v1.

## 8.5 `table_sessions`

-   `id` UUID PK
-   `table_id` UUID FK -\> cafe_tables
-   `session_number` INTEGER not null, increments per table
-   `status` ENUM `OPEN`, `CLOSED`
-   `opened_at` timestamp not null
-   `opened_by_user_id` UUID nullable (null for customer QR-created
    session)
-   `closed_at` timestamp nullable
-   `closed_by_user_id` UUID nullable
-   `close_reason` TEXT nullable
-   `created_at`, `updated_at`
-   Unique (`table_id`, `session_number`)
-   Database partial unique constraint: at most one row with
    `status='OPEN'` per `table_id`.

## 8.6 `orders`

-   `id` UUID PK
-   `session_id` UUID FK -\> table_sessions
-   `order_number` INTEGER, unique within session
-   `source` ENUM `CUSTOMER_QR`, `STAFF`
-   `status` ENUM or validated string based on aggregate item status
-   `customer_note` TEXT nullable
-   `created_by_user_id` UUID nullable (null for customer QR)
-   `idempotency_key` VARCHAR nullable; unique per appropriate scope
-   `created_at`, `updated_at`
-   Unique (`session_id`, `order_number`)

## 8.7 `order_items`

-   `id` UUID PK
-   `order_id` UUID FK -\> orders
-   `menu_item_id` UUID nullable FK -\> menu_items (nullable to preserve
    history if catalog item is retired)
-   `item_name_snapshot` VARCHAR not null
-   `food_type_snapshot` VARCHAR not null
-   `unit_price_snapshot` NUMERIC(12,2) not null
-   `tax_rate_snapshot` NUMERIC(5,2) not null
-   `quantity` INTEGER not null, \> 0
-   `notes` TEXT nullable
-   `status` ENUM `PENDING`, `ACCEPTED`, `SERVED`, `REJECTED`,
    optionally `CANCELLED`
-   `rejection_reason` TEXT nullable
-   `status_updated_by_user_id` UUID nullable
-   `status_updated_at` timestamp nullable
-   `created_at`, `updated_at`
-   If editing quantities is permitted, retain an audit event and
    recalculate the bill; lock or restrict edits after
    acceptance/serving according to the business rules.

## 8.8 `bills`

-   `id` UUID PK
-   `session_id` UUID FK -\> table_sessions, unique (one bill per
    session)
-   `bill_number` VARCHAR unique, human-readable
-   `subtotal` NUMERIC(12,2) not null default 0
-   `tax_total` NUMERIC(12,2) not null default 0
-   `discount_total` NUMERIC(12,2) not null default 0
-   `total` NUMERIC(12,2) not null default 0
-   `amount_paid` NUMERIC(12,2) not null default 0
-   `balance_due` NUMERIC(12,2) not null default 0
-   `status` ENUM `OPEN`, `PARTIALLY_PAID`, `PAID`, `CLOSED`, optionally
    `VOID`
-   `created_at`, `updated_at`, `closed_at`, `closed_by_user_id`
-   Server recalculates totals from order item snapshots. Define whether
    accepted and served items are billable; default: accepted and served
    items are billable, pending items are not yet included in the
    payable total, rejected/cancelled items are never billable. Show
    pending value separately if useful. Once a bill is closed, no new
    items can be added to that session.

## 8.9 `payments`

-   `id` UUID PK
-   `bill_id` UUID FK -\> bills
-   `method` ENUM `CASH`, `UPI`, optionally `CARD`
-   `amount` NUMERIC(12,2) \> 0
-   `status` ENUM `RECORDED`, `VOIDED` (or `PENDING_VERIFICATION` if a
    workflow is intentionally added)
-   `reference_number` TEXT nullable (UPI transaction/reference ID)
-   `notes` TEXT nullable
-   `recorded_by_user_id` UUID FK -\> users
-   `created_at`, `voided_at`, `voided_by_user_id`, `void_reason`
-   Payment voiding is manager-only, requires reason and audit; do not
    delete payment rows.

## 8.10 `audit_logs`

-   `id` UUID PK
-   `actor_user_id` UUID nullable (null for customer system actions)
-   `action` VARCHAR not null
-   `entity_type` VARCHAR not null
-   `entity_id` UUID/string not null
-   `old_value` JSONB nullable
-   `new_value` JSONB nullable
-   `reason` TEXT nullable
-   `request_id` VARCHAR nullable
-   `created_at` timestamp not null
-   Append-only for application users.

## 8.11 Optional `notifications`

For persistent notifications, add: - `id`, `recipient_user_id` nullable
or role-targeted, `type`, `table_id`, `session_id`, `order_id`,
`message`, `read_at`, `created_at` - Alternatively, use realtime events
only and rely on pending badges/refetching. Recommended: persist
notifications so a staff member who was offline still sees an unread
new-order notification after reconnect.

## 8.12 Relationships

-   One table -\> many sessions over time.
-   One table -\> at most one open session.
-   One session -\> many orders.
-   One session -\> one bill.
-   One order -\> many order items.
-   One bill -\> many payments.
-   One menu section -\> many menu items.
-   One user -\> many audit actions.
-   One order submission creates one order and multiple order items
    transactionally.

# 9. API Conventions

Base path: `/api/v1`

Use JSON requests/responses. Use consistent error format:

``` json
{
  "error": {
    "code": "SESSION_CLOSED",
    "message": "This table session is closed. Refresh the QR menu to continue.",
    "details": {}
  }
}
```

Use HTTP status codes appropriately: - `200` successful read/update -
`201` created - `204` successful no-content action - `400` malformed
request - `401` unauthenticated - `403` authenticated but unauthorized -
`404` not found - `409` conflict, stale session, duplicate submission,
or invalid state transition - `422` validation error - `429` rate
limit - `500` unexpected server error

Use pagination for audit/history endpoints. Validate all inputs
server-side. Add request IDs for tracing. For money, serialize decimal
values as strings or a safe numeric representation consistently.

# 10. Required API Endpoints

## 10.1 Authentication

### `POST /api/v1/auth/login`

Manager/staff login. Request:

``` json
{ "username": "manager", "password": "..." }
```

Response: authenticated cookie or access token and safe user object
`{id, name, role}`.

### `POST /api/v1/auth/logout`

Invalidate session/refresh token if applicable.

### `GET /api/v1/auth/me`

Return current authenticated user and role.

### `POST /api/v1/auth/refresh`

Optional, if using refresh tokens.

### `GET /api/v1/users`

Manager-only list staff/users, if user management is implemented.

### `POST /api/v1/users`

Manager-only create staff user.

### `PATCH /api/v1/users/:userId`

Manager-only update user name, role or active state. Never return
password hashes.

## 10.2 Public table QR and sessions

### `GET /api/v1/public/tables/:qrToken`

Resolve QR token. Return table display number, active session summary,
and whether ordering is available. Do not return internal sensitive
fields.

### `POST /api/v1/public/tables/:qrToken/session`

Find the active session for the table or create one atomically if none
exists. Must handle concurrent QR scans without creating two active
sessions. Return session ID and a short-lived opaque customer-session
token if used. Do not create a new session if an active one already
exists.

### `GET /api/v1/public/sessions/:sessionId`

Return limited customer-visible active-session order/item status. Verify
the session is accessible through the QR/customer-session token. Do not
expose payment records, staff identities, or audit logs.

### `GET /api/v1/public/sessions/:sessionId/menu`

Return current active sections/items, sorted by configured sort order,
with current prices/tax/availability and a menu version or `updatedAt`.
Prefer a shared `GET /api/v1/public/menu` if simpler, but the QR page
must still identify the table/session separately.

### `POST /api/v1/public/sessions/:sessionId/orders`

Create a customer order. Required behavior: - Accept item IDs,
quantities, notes, and an idempotency key. - Validate session is open
and belongs to the QR context. - Validate every menu item is active and
available. - Read prices/taxes from the database; ignore client-supplied
price/total. - Create order and order items with snapshots in one
transaction. - Allocate a sequential order number within the session
safely. - Create/update the bill if the app initializes it on first
order. - Commit before broadcasting `order.created`. - Return the order
with item statuses, server-calculated totals, and current session
state. - Return `409 SESSION_CLOSED` if closed. - Deduplicate retries by
idempotency key and return the original result when appropriate.

Example request:

``` json
{
  "idempotencyKey": "client-generated-unique-value",
  "items": [
    { "menuItemId": "uuid", "quantity": 2, "notes": "Less spicy" },
    { "menuItemId": "uuid", "quantity": 1, "notes": "" }
  ],
  "customerNote": ""
}
```

## 10.3 Menu APIs (manager only for writes)

### `GET /api/v1/menu`

Authenticated manager/staff menu listing, including inactive items if
requested.

### `POST /api/v1/menu/sections`

Manager-only create section.

### `PATCH /api/v1/menu/sections/:sectionId`

Manager-only update name, description, sort order, or active state.

### `GET /api/v1/menu/sections/:sectionId/items`

List items in a section.

### `POST /api/v1/menu/items`

Manager-only create menu item.

### `PATCH /api/v1/menu/items/:itemId`

Manager-only update name, section, description, food type, price, tax
rate, availability, image, sort order.

### `POST /api/v1/menu/items/:itemId/deactivate`

Manager-only soft-deactivate item. Alternative: PATCH `isActive=false`.

### `POST /api/v1/menu/sections/:sectionId/deactivate`

Manager-only soft-deactivate section, with a rule to hide or deactivate
its items consistently.

### `PUT /api/v1/menu/sort`

Manager-only reorder sections/items if drag-and-drop sorting is
supported.

### `GET /api/v1/public/menu`

Public active menu for customer QR pages. Never return inactive
sections/items. Use `ETag` or `menuVersion` caching where appropriate,
but ensure changes invalidate cache or clients refresh.

After any successful menu mutation, broadcast `menu.updated` with a
version/timestamp. Open customer pages should refresh the menu or show a
"Menu updated" prompt. Every new QR open must fetch the latest server
menu.

## 10.4 Tables and active queues (manager/staff)

### `GET /api/v1/tables`

Authenticated manager/staff. Return all active tables with: - table
ID/number - active session ID and opened time, if any -
availability/occupancy derived from session - pending order/item
counts - running bill total, paid amount, balance due - latest activity
timestamp

### `GET /api/v1/tables/:tableId`

Return table details and active session summary.

### `GET /api/v1/tables/:tableId/session`

Return active session, combined order queue, item details/statuses, and
bill summary. This is the primary table-detail endpoint. Do not require
a separate global orders screen.

### `GET /api/v1/sessions/:sessionId`

Authenticated manager/staff detailed session, all orders and items, bill
summary, with role-specific fields.

### `GET /api/v1/sessions/:sessionId/orders`

List orders for a session, ordered chronologically. Optional if included
in session endpoint.

### `POST /api/v1/tables/:tableId/session`

Manager/staff may start a session manually only if no active session
exists. QR flow can start it automatically. Must be transactional and
enforce one open session per table.

### `GET /api/v1/sessions/:sessionId/events`

Optional SSE endpoint if WebSockets are not used. Otherwise use the
documented realtime channel/event model.

## 10.5 Staff order creation

### `POST /api/v1/staff/sessions/:sessionId/orders`

Staff creates an additional order on behalf of a customer. Same
validation/snapshot/idempotency rules as customer order submission, but
`source=STAFF` and `created_by_user_id` is the authenticated staff user.
This new order appears in the same session queue and triggers
notifications. It should not require manager acceptance on behalf of
staff; it should still be created as `PENDING` and require manager
acceptance unless the product owner explicitly decides otherwise.

## 10.6 Order/item actions (manager/staff)

### `GET /api/v1/orders/:orderId`

Authenticated manager/staff fetch order and items.

### `POST /api/v1/orders/:orderId/accept`

Manager-only accept all eligible pending items in the order. Must be
idempotent or return a clear conflict if no eligible items remain.
Recalculate order aggregate status and bill.

### `POST /api/v1/orders/:orderId/reject`

Manager-only reject eligible pending items in the order. Require a
rejection reason. If some items were already accepted/served, do not
silently reject them; use item-level action or explicit manager
cancellation flow. Recalculate status/bill.

### `POST /api/v1/orders/:orderId/served`

Staff or manager mark order served only if every
non-rejected/non-cancelled item is accepted and eligible to be served.
Atomic item updates and audit event. If some items are pending, reject
the action and tell the user which items prevent it.

### `POST /api/v1/orders/:orderId/items/:itemId/accept`

Manager-only accept a pending item. Recalculate order status and bill.

### `POST /api/v1/orders/:orderId/items/:itemId/reject`

Manager-only reject a pending item. Require reason. Recalculate order
status and bill.

### `POST /api/v1/orders/:orderId/items/:itemId/served`

Staff or manager mark an accepted item served. Reject
pending/rejected/cancelled items.

### `PATCH /api/v1/orders/:orderId/items/:itemId`

Manager can update allowed fields. Staff may update only explicitly
permitted fields (e.g. notes/quantity before manager acceptance). Do not
allow client to patch status directly. Enforce quantity \> 0 and
price/tax snapshots must not be edited casually. If changing quantity
affects an accepted item, require manager action and audit reason.

### `POST /api/v1/orders/:orderId/cancel`

Manager-only optional cancellation endpoint; require reason. Never
physically delete the order.

### `POST /api/v1/orders/:orderId/items/:itemId/cancel`

Manager-only optional cancellation endpoint; require reason and audit.

After state-changing actions, broadcast events so table dashboards
update.

## 10.7 Billing and payments (manager only)

### `GET /api/v1/sessions/:sessionId/bill`

Return bill totals and line-item breakdown, payments, amount paid,
balance due, and bill status.

### `POST /api/v1/sessions/:sessionId/bill`

Create bill if not already created. Enforce one bill per session. Prefer
creating it automatically when the session/order is first created.

### `POST /api/v1/bills/:billId/payments`

Manager-only record payment. Request:

``` json
{
  "method": "CASH",
  "amount": "500.00",
  "referenceNumber": null,
  "notes": ""
}
```

Rules: - Amount must be positive. - Do not allow payment to exceed
outstanding balance unless overpayment/change is explicitly supported. -
UPI reference is optional but encouraged; manager must manually verify
successful payment before recording it. - Support multiple payment
records per bill for split payment. - Update amount paid, balance, and
bill status in one DB transaction. - Do not trust client-supplied
balance. - Prevent duplicate submissions using idempotency key. -
Payments can be voided only by manager with reason and audit.

### `POST /api/v1/payments/:paymentId/void`

Manager-only; require reason, recalculate bill paid/balance/status.

### `POST /api/v1/bills/:billId/close`

Manager-only. Check: - bill balance is zero - no unresolved pending
items/orders - no pending or unverified payment - session is open - all
required items are accepted/rejected/served according to policy - bill
has not already been closed Then atomically mark bill `CLOSED` and
session `CLOSED`, set closure metadata, and emit events. On failure,
return a useful `409` error explaining the blocker.

### `GET /api/v1/reports/daily-payments?date=YYYY-MM-DD`

Manager-only daily totals grouped by cash/UPI/card (if supported),
payment count, voided amount, net amount, and bill count. Use cafe-local
timezone configured in environment.

### `GET /api/v1/reports/daily-sales?date=YYYY-MM-DD`

Manager-only totals for closed/open bills, item sales, tax, discounts if
implemented, and payment method summary.

## 10.8 Notifications

### `GET /api/v1/notifications`

Manager/staff fetch notifications, optionally filtered by unread.

### `POST /api/v1/notifications/:notificationId/read`

Mark notification as read for the authenticated user.

### `POST /api/v1/notifications/read-all`

Mark all notifications read for the authenticated user.

When an order is submitted: - Persist a notification or create an event
that can be recovered by refetching. - Broadcast `order.created` to
authenticated manager/staff clients. - Payload includes `eventId`,
`tableId`, `tableNumber`, `sessionId`, `orderId`, `orderNumber`,
`itemCount`, `createdAt`. - Do not include customer secrets. -
Deduplicate events by `eventId`/`orderId`.

## 10.9 QR administration

### `GET /api/v1/tables/:tableId/qr`

Manager-only return QR URL/data for printing or rendering.

### `POST /api/v1/tables/:tableId/regenerate-qr`

Manager-only rotate token and invalidate the old token. Require
confirmation and audit.

# 11. Realtime Event Contract

Use WebSockets, Supabase Realtime, or SSE. Choose one approach and
document it in the README. All events should include `eventId` and
`occurredAt`.

Events: - `order.created` - `order.updated` - `order.accepted` -
`order.rejected` - `order.served` - `order_item.updated` -
`table.updated` - `session.opened` - `session.closed` - `bill.updated` -
`payment.recorded` - `payment.voided` - `menu.updated` -
`notification.created`

Audience: - `order.created`: manager and staff; customer session may
also receive confirmation. - Order/item updates: authenticated
manager/staff plus only the relevant customer session. - `menu.updated`:
public menu clients. - Payment/bill updates: manager only, and staff
only if the product owner later grants access. - Audit details: manager
only.

On reconnect: 1. Reauthenticate. 2. Refetch table summaries and open
table details. 3. Fetch unread notifications. 4. Reconcile UI state with
API response.

Never depend on a realtime event being delivered exactly once. Use
idempotent handlers and refetch authoritative state after reconnect.

# 12. Business Logic and Calculations

## Menu and pricing

-   Backend reads active menu item price and tax rate at submission
    time.
-   Store snapshots on each order item.
-   Define tax calculation and rounding precisely. Recommended:
    calculate line subtotal = unit price × quantity; calculate line tax
    using the snapshot rate; round to two decimal places per line; sum
    lines. Confirm whether menu prices are tax-inclusive or
    tax-exclusive before production. Make this configurable/documented.
-   If an item becomes unavailable after the customer opens the menu,
    reject the submission for that item and return a clear error; do not
    silently omit it.

## Bill calculation

For v1, recommended billing policy: - `PENDING`: not included in the
payable total yet; optionally shown as "pending approval value". -
`ACCEPTED` and `SERVED`: included in bill total. - `REJECTED` and
`CANCELLED`: excluded from bill total. - Total = billable subtotal + tax
− discount. - Balance due = total − valid recorded payments. - If
manager rejects an item after it has already been accepted, require an
explicit manager correction/cancellation action and audit reason. -
Recalculate from saved snapshots whenever an item is
accepted/rejected/cancelled/edited or a payment is recorded/voided. -
Once bill is closed, no changes to orders/items/payments except a
separate audited correction process.

## Session lifecycle

-   QR scan calls session endpoint.
-   If an OPEN session exists, return it.
-   If none exists, create one atomically and create its bill (or create
    bill on first order; pick one and implement consistently).
-   Multiple simultaneous scans must result in the same OPEN session.
-   Closing session and bill must be one transaction.
-   After closure, old session IDs reject new order submissions.
-   A future QR scan creates a new session with a new session ID and
    bill.
-   If there is a closed session but no new session, public QR flow must
    create the new session on the next access.

## Item/order state

-   Only manager can accept/reject.
-   Staff/manager can mark accepted items served.
-   Whole-order actions are shortcuts that update eligible items
    atomically.
-   Reject actions require a reason.
-   Do not allow serving an item that is pending/rejected/cancelled.
-   Do not allow editing historical served/rejected items through
    ordinary PATCH routes.
-   Recompute aggregate order status after every item state transition.

# 13. Concurrency, Reliability, and Security

-   Use DB transactions for order creation, order numbering, session
    creation, state transitions, bill recalculation, payment recording,
    and closure.
-   Enforce one open session per table at database level.
-   Use idempotency keys for order submissions and payments.
-   Avoid duplicate orders from repeated taps/retries.
-   Protect against race conditions when two staff/managers act on the
    same item; use optimistic versioning (`updated_at`/version) or row
    locks.
-   Add rate limits to public QR endpoints and login.
-   Validate QR token format and never use guessable table IDs as the
    sole public secret.
-   Use HTTPS in production.
-   Restrict CORS to configured frontend origins.
-   Avoid leaking stack traces/secrets in API errors.
-   Sanitize/render user-entered notes safely to prevent XSS.
-   Use least-privilege DB credentials and environment variables for
    secrets.
-   Ensure role checks occur in backend middleware and in service-layer
    logic.
-   Add CSRF protections if cookie-based authentication is used.
-   Use database migrations and seed scripts.
-   Log errors with request IDs; never log passwords/tokens or sensitive
    payment data.
-   Provide backups and document restore steps.
-   Keep audit logs append-only for app users.

# 14. Recommended Project Structure

``` text
cafe-ordering/
  apps/
    web/
      src/
        app/
        components/
        features/
          customer-menu/
          tables/
          table-session/
          menu-management/
          billing/
          notifications/
          auth/
        lib/
        types/
    api/
      src/
        routes/
        controllers/
        services/
        repositories/
        middleware/
        realtime/
        validation/
        utils/
      tests/
  database/
    migrations/
    seeds/
  docs/
    SPEC.md
    API.md
  .env.example
  README.md
```

Use a shared TypeScript types/schema package if using a monorepo. Keep
route handlers thin; put transaction/business logic in services.

# 15. Required Frontend Routes

Public: - `/t/:qrToken` --- menu/cart/current-session order status

Authenticated: - `/login` - `/manager/tables` -
`/manager/tables/:tableId` - `/manager/menu` - `/manager/payments` or
`/manager/reports` - `/manager/audit` - `/staff/tables` -
`/staff/tables/:tableId`

Do not create `/manager/orders` as a separate global order-management
page.

# 16. Validation and Error Codes

At minimum implement: - `INVALID_QR_TOKEN` - `SESSION_NOT_FOUND` -
`SESSION_CLOSED` - `TABLE_ALREADY_HAS_OPEN_SESSION` -
`MENU_ITEM_UNAVAILABLE` - `INVALID_QUANTITY` -
`ORDER_ALREADY_PROCESSED` - `INVALID_STATUS_TRANSITION` -
`REJECTION_REASON_REQUIRED` - `BILL_NOT_FOUND` - `BILL_ALREADY_CLOSED` -
`BILL_HAS_BALANCE` - `PENDING_ITEMS_REMAIN` -
`PAYMENT_EXCEEDS_BALANCE` - `DUPLICATE_REQUEST` - `FORBIDDEN` -
`VALIDATION_ERROR`

Errors must explain the issue in user-friendly language while keeping
internal details private.

# 17. Testing Requirements

Write unit, integration, and end-to-end tests.

## Required scenarios

1.  Each of the 10 table QR tokens resolves to the correct table and
    same shared menu.
2.  Opening the same table QR multiple times while a session is open
    returns the same session.
3.  Two simultaneous first scans cannot create two open sessions.
4.  Customer can submit order #1 and order #2 in the same session.
5.  Both orders appear in the same table queue, grouped by submission.
6.  A new order triggers a notification to connected manager and staff.
7.  Reconnecting manager/staff still shows the order and unread
    notification.
8.  Double tap/retry with the same idempotency key creates only one
    order.
9.  Manager can accept the entire order and all eligible items update.
10. Manager can accept one item while other items remain pending.
11. Manager can reject an item with a reason; it is excluded from bill
    total.
12. Manager cannot reject a served item through the normal reject
    endpoint.
13. Staff cannot accept/reject/delete orders or change the menu.
14. Staff can mark an accepted item served.
15. Cannot mark pending/rejected items served.
16. Order aggregate status correctly reflects mixed item statuses.
17. Menu create/update/deactivate operations are manager-only.
18. Customer opening QR after menu change sees updated menu.
19. Changing menu price does not change historical order-item snapshots.
20. Unavailable items are rejected at order submission.
21. Bill totals and tax use server values, not client-submitted prices.
22. Cash payment updates paid amount/balance correctly.
23. UPI payment requires manager action and records reference if
    supplied.
24. Split cash + UPI payments settle a bill correctly.
25. Overpayment is blocked unless explicitly supported.
26. Session closure is blocked when balance remains.
27. Session closure is blocked while unresolved pending items/orders
    remain.
28. Closing bill and session is atomic.
29. New QR access after closure starts a new session and new bill.
30. Requests against old closed session cannot add orders.
31. Audit log captures accept/reject/edit/serve/payment/close/menu
    changes.
32. Realtime duplicate events do not duplicate UI orders/notifications.
33. Public API never exposes payment data, staff identities, audit logs,
    or past-session data.
34. Refresh/reconnect restores correct state.

# 18. Acceptance Criteria

The build is complete only when: - All three experiences are usable on
mobile/tablet/desktop as appropriate. - Customer QR pages always load
the current menu from the API. - Each table has a unique QR but all use
one menu. - Multiple order submissions attach to one active session. -
Manager/staff see new orders in the relevant table queue without
refreshing and receive a notification. - No global Orders page or
kitchen screen exists. - Manager can manage menu sections/items. - Staff
cannot perform manager-only actions, even through direct API calls. -
Item-level and order-level accept/reject/served actions work
consistently. - Rejected items are excluded from the bill and retained
in history. - One running bill exists per session; cash, UPI, and split
payments work. - A closed session cannot receive new orders. - Next QR
visit creates a fresh session and bill. - Automated tests cover all
critical business rules. - README explains local setup, environment
variables, migrations, seed users, QR generation, tests, and deployment.

# 19. Environment Variables

Provide `.env.example` with placeholders only:

``` env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgresql://...
FRONTEND_URL=http://localhost:5173
API_BASE_URL=http://localhost:4000
AUTH_SECRET=replace-with-a-long-random-secret
CAFE_NAME=My Cafe
CAFE_TIMEZONE=Asia/Kolkata
```

Add realtime-provider variables only if the selected provider requires
them. Never commit real secrets.

# 20. Build Instructions for the Coding AI

Implement in small, runnable milestones. Do not generate only mockups or
pseudocode.

1.  Create repository, frontend, backend, database migrations,
    `.env.example`, and README.
2.  Implement schema, migrations, seed data for 10 tables, sample
    sections/items, and an initial manager account created securely via
    setup instructions.
3.  Implement authentication and backend role authorization.
4.  Implement public QR resolution, atomic session creation, current
    menu API, cart/order submission, item snapshots, and idempotency.
5.  Implement table grid and table detail for manager/staff, with
    realtime updates and notifications.
6.  Implement manager menu management and customer menu refresh
    behavior.
7.  Implement order/item acceptance, rejection, served actions,
    aggregate statuses, and audit logging.
8.  Implement bills, cash/UPI/split payment recording, reports, and
    atomic session closure.
9.  Add responsive styling, loading/error/empty states, reconnect
    handling, and accessibility.
10. Add tests for all acceptance criteria.
11. Run type checking, linting, migrations, unit/integration/e2e tests,
    and production build. Fix failures rather than documenting them as
    unresolved.
12. Document any deliberate deviation from this specification before
    considering the implementation complete.

Do not hardcode menu data in the frontend, do not trust client-side
prices or roles, do not permanently delete historical records, and do
not build a kitchen screen or separate global Orders page.
