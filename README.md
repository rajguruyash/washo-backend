# WASHO website

Doorstep car and bike washing for Kharadi, Pune. React 19 + Vite + Tailwind 4 frontend, and a thin Express server.

**Supabase is the single backend**, shared with the mobile app: Postgres (with row-level security and all business rules as
functions), Auth (phone OTP via Twilio Verify), Razorpay edge functions and Storage. This repo's server contains no business
logic and no database of its own; it signs people in, calls the database functions *as the signed-in person*, and relays the
Razorpay edge functions. The mobile app is not touched by anything in this repo.

## What the website does

- **Customer** (`/app`): the **custom membership wizard** is the main product: vehicle → 1/2/3 washes a week → Body/Deep
  combination and days → 1/3/6/12 months → start date and time slot → request. WASHO reviews it and sets the price; the customer
  sees a fully itemised quote (every discount is its own line), accepts, pays through Razorpay, and only after the payment is
  **verified** does the membership activate and every wash get scheduled. Also: dashboard, membership detail with rescheduling
  (washes can be rescheduled, not cancelled), single washes, booking details with before/after photos, vehicles, addresses.
- **Specialist** (`/worker`, email + password): Today / In progress / Upcoming / Completed / Cancelled-moved queues, only the
  washes assigned to them; call customer → customer confirmed or call not picked up (wash stays scheduled) → start → before photos
  → after photos → complete; issues and notes.
- **Admin** (`/admin`, email + password, role from `profiles.role`): requests (quote with a labelled adjustment, or reject),
  washes (assign, reschedule, cancel, history, photos), memberships (regular specialist), customers and specialists, and payments
  or refunds that need a human.
- No credit system anywhere.

## Run it locally (no Supabase project needed)

```bash
npm install
npm run dev:stack      # local fake Supabase (Auth, edge functions, Storage) over a real local copy of the production schema + all migrations
PORT=5001 npm run dev  # in a second terminal: Vite, proxying /api to the stack
```

Customer OTP is `123456`. Admin `admin@washo.test` / `Admin-pass-1`, specialist `worker@washo.test` / `Worker-pass-1`.
Razorpay is simulated locally. Needs a local Postgres and the production schema dump (see `supabase/README.md`).

## Against a Supabase branch / test project

Apply `supabase/migrations/*` (and `supabase/cutover/*` on a **branch only**; see below), deploy the edge functions, set the
`.env` values from `.env.example`, then `npm run backend:dev`. Never point this at production until the checklist in
`supabase/README.md` is done.

> The website needs `supabase/cutover/20261005000001_*` (credit-free wash completion). The cutover files must not be applied to
> production until the mobile app release that no longer needs the retired functions is live.

## Production database checklist

Sign-in itself needs only the original schema, and works on a database that has none of the new migrations (it reads
`profiles` tolerantly and takes email from the Supabase token until `profiles.email` exists). Everything else in the app
needs the migrations. Apply them **in order, on a branch or backup first**; they are additive and re-runnable:

1. `supabase/migrations/20261004000001` … `…0009` (`…0003` adds `profiles.email` with `ADD COLUMN IF NOT EXISTS`; it cannot run alone because it needs the `app_private` schema from `…0001`)
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
