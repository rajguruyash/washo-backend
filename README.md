# WASHO website

Doorstep car and bike washing for Kharadi, Pune. React 19 + Vite + Tailwind 4 frontend, and a thin Express server.

**Supabase is the single backend**, shared with the mobile app: Postgres (with row-level security and all business rules as
functions), Auth (phone OTP via Twilio Verify), Razorpay edge functions and Storage. This repo's server contains no business
logic and no database of its own; it signs people in, calls the database functions *as the signed-in person*, and relays the
Razorpay edge functions. The mobile app is not touched by anything in this repo.

## What the website does

- **Customer** (`/app`): the **custom membership wizard** is the main product: vehicle → how many **Body washes** and how many **Deep cleans** a week (+ / − counters, up to 7 in total, an (i) on each explains what the wash includes, and the per-wash price follows the vehicle, so an SUV's Deep clean costs more) →
  the days: "just add your preferred days and we will manage your whole month" (ONE row of the seven weekdays: tap a day for a Body wash, switch the brush to Deep cleans and tap the days for those, in another colour; a weekday has one wash) →  1/3/6/12 months → start date and time slot → review and **pay**. The price is the rate card with every discount
  as its own line; there is no approval step. Only after the Razorpay payment is **verified** does the membership activate and every wash get scheduled. Any mix is allowed (even all Body, or all Deep; a bike only has the Body wash). Also: dashboard, membership detail with rescheduling
  (washes can be rescheduled, not cancelled), single washes, booking details with before/after photos, vehicles, addresses. A hidden "Want to pick exact dates?" option on the start step opens a calendar for the whole term (nothing before today + 2 days, none after the term ends, one wash a day, at most the weekly number in any Monday to Sunday week, busy days in amber and rush days in red, all still pickable). A reminder email a week before a membership ends opens the wizard with the old plan filled in (`/app/membership/new?renew=<id>`). Every wizard shows its progress as a React Bits Stepper (numbered circles that fill as you go; tap a finished step to go back). **Washes done**: a plan's page (and a link on the dashboard) lists the finished washes; tapping one opens what was done and its before and after photos, big on the same page. **Hold to remove**: a plan started but not paid for (on the dashboard and the Membership page), or one that has ended, is cleared with a press-and-hold button (React Bits Hold Button). Nothing is deleted: the unpaid plan's checkout is stopped, WASHO keeps its records, and an active membership or a payment that has come in is never touched.
- **Specialist** (`/worker`, email + password): Today / In progress / Upcoming / Completed / Cancelled-moved queues, only the
  washes assigned to them; call customer → customer confirmed or call not picked up (wash stays scheduled) → start → before photos
  → after photos → complete; issues and notes. **Car not available?** On a membership wash the specialist can move it to the next day, the day after, or any day they choose (and another time window); it stays in their queue, the customer's timeline says the specialist moved it and why, and the usual rules hold (inside the membership, not on a day that vehicle already has a wash).
- **Admin** (`/admin`, email + password + an emailed code, role from `profiles.role` and `admin_access`): a **Dashboard** (today's new customers, paid orders, money collected and refunded, payments that went wrong, complaints waiting, a 14-day chart), then washes (book one for a customer, edit, assign, reschedule, cancel, history, photos),
  **History** (every past wash, newest first: filter by date, status, specialist, search; totals for what is shown), memberships (regular specialist), customers and specialists (add, edit, archive), services, prices and discounts, and payments or refunds that need a human.
  See "Admin: create, edit, archive" below. **Campaigns**: free-wash offers (see "Free-wash campaigns"). **Capacity**: how many vehicles a day and a time window can take (see "Crowd limits"). **Support** (customers' complaints), **Export** (CSV), **Activity log**, **Team** (admins and their roles) and **Settings** (maintenance mode, big refunds, password): see "Back-office" below.
- **Opening the site**: a loading screen (React Bits Drift Wall: a tilted, drifting wall of small copies of WASHO's own photos behind the logo) stays for at least 3.5 seconds on every visit (never more than 9, and longer only if the site is genuinely not ready), then the page appears and the prices count down to their real numbers in about half a second (`CountUp` is a timed tween, not a spring, and waits for the loading screen to leave). After sign-in a pop-up greets the customer by name (a tick that draws itself, ripples and droplets) before the app opens.
- **Free-wash campaign** (`/navratri`, banner on every public page while one is on; the campaign blocks catch a gold glare of light, React Bits Glare Hover): a customer signs in by phone, adds a vehicle and address and slides to claim. No payment, and **no day or time to pick**: WASHO places the wash (the earliest day, up to the campaign's last day, with room under its own daily limit, avoiding red rush days when it can, in the quietest window that is far enough ahead) and tells the customer at once.
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

## Crowd limits (capacity): a warning, never a wall

Every wash booked for a day counts toward that day and toward its time window (morning, afternoon, night): memberships, single washes and free washes. Cancelled, refunded, refund-requested, no-show and moved washes do not count.
Two numbers per kind of day, editable by an admin in **Admin → Capacity** (`admin_set_capacity`; it also lists the days ahead with how full each is):

| | Whole day amber / red | Each window amber / red |
|---|---|---|
| Monday to Friday | 10 / 15 | 6 / 9 |
| Saturday and Sunday | 15 / 20 | 9 / 12 |

Past the **amber** number a day or window is shown amber; past the **red** number it is shown red (**"Rush"**) with the note *"It is a rush on this day, so there might be a slight delay. You can still book it."* **There is no upper limit: nothing is ever closed.** A red day or window can be chosen and booked like any other (single washes, free washes, weekday memberships and exact dates alike); only the colour and the note change. A day is red when its total reaches the red number or when every window is red. The window numbers are a starting guess: change them to fit your team.
What still refuses a day: a vehicle already has a wash on it (a vehicle is washed once a day), a free-wash campaign's own daily cap, notice and term rules. A membership's weekday plan lands on the days chosen whatever the crowd; the plan preview marks the red ones.

**Exact dates.** The membership wizard has a hidden option to pick every wash date yourself (`custom_dates` on `POST /api/payments/membership-checkout`; `POST /api/membership-preview` shows where an automatic plan lands and how busy each day is). The database checks the same rules the calendar shows.

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

## Speed

What makes the first visit quick (and repeat visits nearly instant), all in the repository:
- **Fonts are self-hosted** (`src/fonts.css`, `src/assets/fonts`, preloaded): no third-party stylesheet blocks the first paint. The rupee sign has its own 1 KB file instead of an 80 KB one.
- **Files under `/assets` are cached for a year** (`immutable`: their names change with every build); the page itself is always re-checked. A returning visitor loads the site from their own device.
- **The first requests start before the app's code arrives** (`public/early.js` asks for who is signed in, the rate card and the campaign banner while the scripts download; `src/lib/http.ts` picks the answers up).
- **A few seconds of memory for public answers** (`backend/src/publicCache.ts`): the rate card, a visitor's campaign banner and a visitor's price estimate come from memory, with visitors asking at the same moment sharing one lookup. An admin changing anything, and a claim, empty it at once. A signed-in customer's own answers are never kept.
- **Images are sized for where they are shown** (the service photos about 70 KB, the crew photo 51 KB, the header logo 13 KB), and the loading screen's wall uses small copies.
- Not code: on Render's free plan an idle server falls asleep and the first visit after a quiet spell waits for it to wake. A paid instance, or a free uptime monitor calling `/api/health` every 5 minutes, avoids that.

## Sign-in

- **Mobile number + code** (Supabase Auth phone OTP, Twilio Verify). The main way in for customers, and the only one that gives them a verified number.
- **Continue with Email** (customers and specialists): an email and a password. **Sign in**, or **Create account** (8 or more characters with a letter and a number). There is **no verification email and no emailed code for customers**: the password is their key, so a typed address proves nothing and nothing is sent to it.
  `POST /api/auth/email/signup` creates the login at Supabase Auth (service role, already confirmed) and signs them in; `POST /api/auth/email/login` checks the password (8 wrong ones in 15 minutes for an address make it wait; sign-ups are limited per network). A login that has no profile yet (an account made before profiles were created automatically) gets one at this moment (`ensure_my_profile()`, migration 26), for the phone code too.
  There is no "forgot password" by email (an unverified address cannot be trusted to reset anything): the page points to the mobile number.
- **Admins: password, then a code emailed through Resend.** After the password is right the server throws away the login Supabase just issued, makes a code with Supabase Auth (`generate_link`) and **emails it through Resend** (`RESEND_API_KEY`, `EMAIL_FROM`) to the admin's own address; the code never goes to the browser. The session starts only when `POST /api/auth/admin/code/verify` gets it back
  (Supabase checks it: one use, its expiry; 5 wrong tries end the step; a new code at most every 30 seconds and 6 an hour). If the code cannot be emailed the admin is refused: **it never falls back to the password alone.**
  What proves the second step is a **signed cookie** (`washo_2fa`, made only by this server, from `ADMIN_2FA_SECRET` or derived from `SUPABASE_SERVICE_ROLE_KEY`) that every admin request must carry for that same person. A stolen password turned into a Supabase token by talking to Supabase directly is not enough to open the console. The cookie slides while the admin is busy and runs out after **30 minutes without a request** (`ADMIN_IDLE_MINUTES`) and after 12 hours always; the page also signs the admin out and says why.
  Admins cannot sign in with a text message alone or with Google (a SIM swap must never open the console). The owner (`SUPER_ADMIN_EMAIL`, default rajguruyash29@gmail.com) is always the super admin, whatever the roles table says.
  **Resend only mails arbitrary inboxes once the sender domain is verified.** Until then, if it refuses an admin's address, set `ADMIN_CODE_TO=<an inbox you read>` on the server: every admin code goes there instead (still two steps, nobody locked out). Remove it after the domain is verified.
- Passwords: specialists and admins need 12 or more characters with upper and lower case and a number, and nothing guessable (`backend/src/password.ts`); the admin Settings page has Change password (the current one is checked first).
- *Continue with Google* is no longer offered on the page. Its server routes (`/api/auth/google`, `/api/auth/callback`) are still there but unused (and refuse an admin); Google does not need to be enabled in Supabase.

A customer who signed in with their email has no mobile number, and a specialist has to ring the customer. Setup asks only for their name. **A mobile number is compulsory at the last step of a membership, a single wash and a free-wash claim**: the step shows "Add your mobile number to pay",
the customer types a 10-digit +91 number and saves it (**no code, no confirmation**); `409 phone_required` stops payment on the server too. They can also add or correct it on the Account page.
`PUT /api/me/phone` saves it through `set_my_phone()` (migration 25), which refuses a number another WASHO account already has and anyone who signs in with a confirmed number, then attaches it, unconfirmed, to the same login at Supabase Auth, so if the same person later signs in WITH that number they reach this same account instead of a second one.
A typed number is never treated as verified and never merges accounts by itself. Customers who sign in by phone always have one, and see none of this.

**The pay slider is never dead.** When something is missing (the mobile number, an address, or booking is paused) the customer can still slide it all the way: the handle turns **red**, says what is missing inside the track, and the page scrolls to the exact place to put it right and flashes it red once (`src/lib/payBlockers.ts`, `SlideToPay`). Nothing is sent anywhere. (The cursor is not moved into the field: focusing an input while the page scrolls closes the page in WebKit.)

## Back-office (roles, support, settings, activity, export)

Migration `20261004000027_admin_roles_support_settings.sql` (all additive; the mobile app still only knows customer / worker / admin):

- **Roles.** `profiles.role` stays `admin` for everyone; the finer role is in `admin_access`: **super_admin, operations, finance, marketing, support**. What each may view or manage is DATA (`admin_role_areas`, 21 areas, `view` or `manage`). Operations: washes, memberships, people, services, campaigns, capacity, exports of customers / washes / memberships. Finance: payments and refunds, history, exports of payments / refunds / memberships; can look at washes. Marketing: campaigns. Support: look up people and washes, answer complaints, export complaints. Only the super admin: Team, Settings, Activity log. The owner is seeded as super admin; any other existing admin became Operations.
  **Enforcement.** One gate (`backend/src/access.ts`) is mounted on every `/api/admin` path: signed in, second step done, has a role, and the role may do THIS (a GET is `view`, anything else `manage`). A path it does not know is refused to everyone but the super admin. The database enforces it too for everything new, and for the four refund functions. (Older admin functions, such as editing a customer, are still guarded only by `is_admin()` inside the database, so for those the website's gate is the lock.)
- **Team** (super admin): add an admin (login with a strong password, then a role), change a role (takes effect at once), switch an admin off or on (locks the login at Supabase). Nobody changes their own role, the super admin cannot be changed or switched off, and an existing customer's email can never be turned into an admin (`admin_promote_to_admin` only accepts a brand-new login with no history).
- **Safe refunds.** A refund at or above the threshold (Settings → Big refunds, ₹1,000 to start) can only be approved by the super admin, who must also type the amount back. Finance can approve smaller ones; Operations, Marketing and Support cannot approve any. Nothing is deleted anywhere: "delete" is archive, with a confirm sheet.
- **Support / complaints.** A customer opens one from Account → Help (or "Tell us" on a wash), picks what it is about, optionally the wash, and follows the thread in the app; WASHO is emailed (`ADMIN_EMAIL`). Admins with the support role answer from the Support tab and move it open → in progress → resolved → closed; a customer writing back to a resolved one reopens it. A customer sees only their own.
- **Settings.** *Maintenance mode*: customers cannot START a booking, payment or free-wash claim (503 with your message; the pay slider goes red with "Booking is paused for now", and a notice shows at the top of the site). Payments already made are still recorded, and specialists and admins carry on. *Big refunds* (above). *Admin sign-in security* shows how sign-in is protected and has Change my password.
  **Not built, on purpose:** a tax %, platform fees or a minimum order (they would change what customers are charged; say the numbers and the rules and they are a small addition), and a force-update version (that is for the mobile app, which this repo does not touch).
- **Dashboard**: today's new customers, paid orders, free washes claimed, money collected and refunded, payments that went wrong (failed today, paid but not booked, started but not confirmed), complaints waiting, and a 14-day chart. A role that may not see payments gets none of the money numbers (from the database, not hidden by the page).
- **Activity log** (super admin): every audited change, refund, setting, role change, sign-in and export with who did it, searchable. Every admin sign-in is recorded.
- **Export**: CSV of customers, washes, memberships, payments, refunds, complaints and the activity log, by date range, up to 50,000 rows. Each kind has its own permission; only the customers export carries phone numbers and emails; a cell that starts with `=`, `+`, `-` or `@` is stored as text so a customer's name cannot run as a spreadsheet formula; every download is written to the activity log.
- **Daily backups** are a Supabase setting (paid plan: daily backups and point-in-time recovery), not something code can switch on. The exports above are for your own copies.

Tests: `supabase/tests/after-27-admin-roles-support-settings.test.ts` (database), `backend/tests/api-admin-roles.test.ts` and `api-email-login.test.ts` (website).

## Production database checklist

Sign-in itself needs only the original schema, and works on a database that has none of the new migrations (it reads
`profiles` tolerantly and takes email from the Supabase token until `profiles.email` exists). Everything else in the app
needs the migrations. They are additive and re-runnable.

**Easiest way:** `npm run db:bundle` writes `supabase/bundles/safe-migrations.sql`: all the safe migrations in order, in ONE transaction (if anything
fails, nothing is applied). Run `supabase/bundles/preflight-check.sql` first (read-only), try the bundle on a Supabase branch or after a backup, paste it into
the Supabase SQL editor, then run the preflight again: every line should read `true`.

1. The safe migrations `supabase/migrations/20261004000001` … `…0026` (`…0016` lets a membership be any mix of Body and Deep washes; `…0017` reads a membership's last day in Pune time; `…0018` remembers sent emails; `…0019` adds crowd limits; `…0020` lets a membership use exact dates; `…0021` lets a specialist move a membership wash and a customer clear a plan; `…0022` makes the crowd limits a warning, never a wall; `…0023` lets a specialist complete a membership wash without credits; `…0024` has WASHO place a free wash (no date to pick); `…0025` lets an email customer save a typed mobile number; `…0026` sets up a login that has no profile when it signs in; `…0012` adds the refund workflow: a refund request on cancel, and admin approval; `…0013` adds admin management with archive; `…0014` adds free-wash campaigns; `…0015` lets a campaign be open to anyone) (`…0003` adds `profiles.email` with `ADD COLUMN IF NOT EXISTS`; it cannot run alone because it needs the `app_private` schema from `…0001`)
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
