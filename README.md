# WASHO website

Doorstep car and bike washing for Kharadi, Pune. React 19 + Vite + Tailwind 4 frontend, and a thin Express server.

**Supabase is the single backend**, shared with the mobile app: Postgres (with row-level security and all business rules as
functions), Auth (phone OTP via Twilio Verify), Razorpay edge functions and Storage. This repo's server contains no business
logic and no database of its own; it signs people in, calls the database functions *as the signed-in person*, and relays the
Razorpay edge functions. The mobile app is not touched by anything in this repo.

## What the website does

- **Customer** (`/app`): the **custom membership wizard** is the main product: vehicle → 1 to 7 washes a week (a toggle, with the price updating) → Body/Deep
  combination and days → 1/3/6/12 months → start date and time slot → review and **pay**. The price is the rate card with every discount
  as its own line; there is no approval step. Only after the Razorpay payment is **verified** does the membership activate and every wash get scheduled. Also: dashboard, membership detail with rescheduling
  (washes can be rescheduled, not cancelled), single washes, booking details with before/after photos, vehicles, addresses.
- **Specialist** (`/worker`, email + password): Today / In progress / Upcoming / Completed / Cancelled-moved queues, only the
  washes assigned to them; call customer → customer confirmed or call not picked up (wash stays scheduled) → start → before photos
  → after photos → complete; issues and notes.
- **Admin** (`/admin`, email + password, role from `profiles.role`): washes (book one for a customer, edit, assign, reschedule, cancel, history, photos),
  **History** (every past wash, newest first: filter by date, status, specialist, search; totals for what is shown), memberships (regular specialist), customers and specialists (add, edit, archive), services, prices and discounts, and payments or refunds that need a human.
  See "Admin: create, edit, archive" below. **Campaigns**: free-wash offers for new customers (see "Free-wash campaigns").
- **Free-wash campaign** (`/navratri`, banner on every public page while one is on): a new customer signs in by phone, adds a vehicle and address, picks a day and a time and slides to claim. No payment.
- No credit system anywhere.

## Run it locally (no Supabase project needed)

```bash
npm install
npm run dev:stack      # local fake Supabase (Auth, edge functions, Storage) over a real local copy of the production schema + all migrations
PORT=5001 npm run dev  # in a second terminal: Vite, proxying /api to the stack
```

Customer OTP is `123456`. Admin `admin@washo.test` / `Admin-pass-1`, specialist `worker@washo.test` / `Worker-pass-1`.
Razorpay is simulated locally (a stand-in for its API; `GET /__dev/checkout?order=<id>` returns what Checkout would send). Needs a local Postgres and the production schema dump (see `supabase/README.md`).

## Against a Supabase branch / test project

Apply `supabase/migrations/*` (and `supabase/cutover/*` on a **branch only**; see below), deploy the edge functions, set the
`.env` values from `.env.example`, then `npm run backend:dev`. Never point this at production until the checklist in
`supabase/README.md` is done.

> The website needs `supabase/cutover/20261005000001_*` (credit-free wash completion). The cutover files must not be applied to
> production until the mobile app release that no longer needs the retired functions is live.

## Payments (Razorpay Standard Checkout)

The website server does the Razorpay work; the database decides the amount and settles the result.

1. `POST /api/payments/membership-checkout` (or `/api/payments/on-demand`): the database validates and prices the order, the server creates the Razorpay order for exactly that amount (never a browser-supplied amount) and returns `{ order_id, amount, currency, key_id }`.
2. The browser opens the Razorpay Checkout modal with that order (dismissal and `payment.failed` are handled and shown).
3. `POST /api/payments/verify` with `razorpay_order_id`, `razorpay_payment_id`, `razorpay_signature`: HMAC-SHA256(`order_id|payment_id`, `RAZORPAY_KEY_SECRET`) is checked (400 on mismatch or missing fields; nothing is marked paid), then Razorpay's own record of the payment (captured, same order and amount), then the database settles it. The membership and its washes are created only at that point.

Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in Render's environment. Not configured: payment routes answer 503 `payments_unavailable`.
The Supabase edge functions in `supabase/functions` are not used by the website.

### When the browser never reports back (Google Pay, tab cleared, signal lost)

A customer can pay in a UPI app and come back to a window that never heard about it. Razorpay then has the money and WASHO has no booking. Four things close that gap, and all of them settle through the same idempotent database function, so a payment is never recorded twice:

1. **The app asks Razorpay.** When a payment window closes ("cancelled"), the server checks the order with Razorpay before the customer is told it failed. And when a customer opens the app, `POST /api/payments/reconcile` re-checks their checkouts from the last 3 days that never confirmed (at most every 10 minutes, and only if one is waiting). A found payment is recorded with a "We found your payment" message.
2. **Razorpay's webhook.** `POST /api/razorpay/webhook` records `payment.captured` / `order.paid` by itself, with no browser involved. Set it up once: Razorpay dashboard → Settings → Webhooks → Add → URL `https://washo.online/api/razorpay/webhook`, events **payment.captured** and **order.paid**, a secret of your choosing; then put the same secret in Render as `RAZORPAY_WEBHOOK_SECRET`. The body is checked against its signature; a bad signature is refused. If Razorpay or the database is unreachable the webhook answers 5xx, so Razorpay delivers it again.
3. **Admin: Needs attention → Started but not confirmed.** Lists checkouts that were opened and never confirmed; **Check with Razorpay** records one that was paid.
4. **Admin: Washes → Book a wash → Paid online.** For anything that still cannot be matched: book the wash for the customer and paste the Razorpay payment id (`pay_…`) from the dashboard. The server asks Razorpay: the payment must be captured, for exactly the rate-card price, and not used before. A cancellation can then be refunded through Razorpay like any other online payment.

### Cancelling and refunds

A customer can cancel a single wash that has not started. If it was paid, the database records a **refund request for the full amount** (no cutoff, no deduction).
Nothing is refunded until an **admin approves it** (Admin → Needs attention → *Approve and refund*):

1. `POST /api/admin/refunds/:id/approve` (admin only). `admin_begin_refund()` claims the refund, so two admins cannot pay it twice.
2. The server asks Razorpay to refund the original payment for exactly that amount (`POST /v1/payments/:id/refund`). It first looks for a refund Razorpay already made for the same WASHO refund id, so a retry never pays twice.
3. On success `admin_finish_refund()` records Razorpay's refund id, marks the payment refunded and adds *Refunded* to the customer's timeline. If Razorpay refuses, the reason is kept (`refunds.failure_reason`, shown to the admin only), the refund shows *failed*, and the admin can try again.

*Paid it by hand* is still there for a refund done in the Razorpay dashboard (it needs the Razorpay refund id). Membership washes cannot be cancelled by customers; they reschedule.
There is no Razorpay webhook: refund status is whatever Razorpay answered when it was created.

## Admin: create, edit, archive

The Admin page manages the working data. **Nothing is ever deleted: "delete" means archive** (hidden from the working lists, restorable, history always kept).

| Area | Create | Edit | Archive / restore |
|---|---|---|---|
| **Specialists** | email + password login | name, phone, set a new password | archived: signed out, locked at Supabase, upcoming washes and memberships return to the pool (not while a wash is in progress) |
| **Customers** | registered by phone (they confirm the number with a code when they first sign in) | name, email (never the phone: it is their sign-in) | refused while they have scheduled washes or an active membership; signed out and locked at Supabase |
| **Vehicles / addresses** | for any customer | all fields (a vehicle with wash history keeps its type) | archived; refused while a scheduled wash uses it |
| **Washes** | booked for a customer: *paid to WASHO in cash* (recorded as a paid offline payment at the rate-card price) or *complimentary* | address, parking spot, note; assign, reschedule | cancel (a paid one raises a refund request) |
| **Services and prices** | single-wash services | details; **prices are versioned** (the old price is closed, never overwritten) | retire / restore (not the services memberships are built from) |
| **Discounts and rules** | add a discount (replaces the old one, which is kept) | percentages, the discount cap, lead times | remove a discount |

Every rule is enforced in the database (migration `20261004000013`), every change writes an audit event, and an archived person is also refused by the website itself, so an open session ends at once.
The Auth admin API (create a customer, lock a login, set a password) needs `SUPABASE_SERVICE_ROLE_KEY` on the server, as photos already do.

## Sign-in

- **Mobile number + code** (Supabase Auth phone OTP, Twilio Verify). The main way in for customers.
- **Continue with Google**: OAuth through Supabase Auth with PKCE. `GET /api/auth/google` keeps a one-time secret in an httpOnly cookie and sends the browser to Supabase; `GET /api/auth/callback` exchanges the returned code with that secret and sets the usual session cookies.
  Needs the Google provider switched on in Supabase (Authentication → Providers → Google) and `https://washo.online/api/auth/callback` in Authentication → URL Configuration → Redirect URLs.
  Optional `PUBLIC_URL=https://washo.online` pins the address sent to Supabase (otherwise the request's own address is used).
- **Continue with Email**: email + password, for any account that has one (specialists and admins today). Where they land depends on their role.

A customer who signed in with Google has no mobile number, and a specialist has to ring the customer. They are asked to add one (a code is texted to it; Supabase refuses a number that already belongs to another account),
and `409 phone_required` stops them paying until they have. Customers who sign in by phone always have one.

## Production database checklist

Sign-in itself needs only the original schema, and works on a database that has none of the new migrations (it reads
`profiles` tolerantly and takes email from the Supabase token until `profiles.email` exists). Everything else in the app
needs the migrations. They are additive and re-runnable.

**Easiest way:** `npm run db:bundle` writes `supabase/bundles/safe-migrations.sql`: all the safe migrations in order, in ONE transaction (if anything
fails, nothing is applied). Run `supabase/bundles/preflight-check.sql` first (read-only), try the bundle on a Supabase branch or after a backup, paste it into
the Supabase SQL editor, then run the preflight again: every line should read `true`.

1. The safe migrations `supabase/migrations/20261004000001` … `…0015` (`…0012` adds the refund workflow: a refund request on cancel, and admin approval; `…0013` adds admin management with archive; `…0014` adds free-wash campaigns; `…0015` lets a campaign be open to anyone) (`…0003` adds `profiles.email` with `ADD COLUMN IF NOT EXISTS`; it cannot run alone because it needs the `app_private` schema from `…0001`)
2. `supabase/cutover/20261005000001` only when the website is the live customer app and the mobile release no longer needs the retired functions

`./supabase/tests/run.sh legacy` proves sign-in against a database shaped like production today.

## Tests

| Command | What it proves |
|---|---|
| `npm run typecheck` | frontend + server |
| `npm test` | pure unit tests (formatting, Razorpay signature helpers) |
| `npm run db:test:baseline` | the production vulnerabilities reproduce on the unmodified schema |
| `npm run db:test` | safe migrations (rolled-back transactions on a local replica) |
| `npm run db:test:full` | safe + cutover: end-to-end membership and worker lifecycle |
| `./supabase/tests/run.sh legacy` | sign-in (customer OTP, worker, admin) against a database shaped like production today |
| `npm run test:api` | the website server over HTTP against the fake Supabase and the real database rules |
| `npm run test:all` | everything above except the baseline |

## Layout

- `src/`: React app (`pages/app`, `pages/worker`, `pages/admin`, `components`, `lib`)
- `backend/src/`: Express (auth relay, database calls as the user, edge-function relay, photo storage)
- `supabase/`: migrations, cutover migrations, edge functions, importer, test harness (`supabase/README.md`)
