# WASHO website

Doorstep car and bike washing for Kharadi, Pune. React 19 + Vite + Tailwind 4 frontend, and a thin Express server.

**Supabase is the single backend**, shared with the mobile app: Postgres (with row-level security and all business rules as
functions), Auth (phone OTP via Twilio Verify), Razorpay edge functions and Storage. This repo's server contains no business
logic and no database of its own; it signs people in, calls the database functions *as the signed-in person*, and relays the
Razorpay edge functions. The mobile app is not touched by anything in this repo.

## What the website does

- **Customer** (`/app`): the **custom membership wizard** is the main product: vehicle → **how many washes in a MONTH**: how many **Body washes** and how many **Deep cleans** (+ / − counters, **at least 4 in all, up to 28**, any mix: 2 Body + 2 Deep, 4 Body + 1 Deep, ...; fewer than 4 shows a red "Choose at least 4 washes a month" and will not let them carry on; an (i) on each explains what the wash includes, and the per-wash price follows the vehicle, so an SUV's Deep clean costs more) →
  the days: "choose the days of the week that suit you" (tap weekdays; at least one day per 4 washes a month, so 5 a month needs 2 days; the washes are spread **evenly through every month** on those days, one a day, never on a day the vehicle already has a wash, Deep cleans spread among the Body washes) → 1/3/6/12 months (a membership is that many months of the monthly plan) → start date and time slot → review and **pay**. The price is the rate card with every discount
  as its own line; there is no approval step. Only after the Razorpay payment is **verified** does the membership activate and every wash get scheduled. Also: dashboard, membership detail with rescheduling
  (washes can be rescheduled, not cancelled), single washes, booking details with before/after photos, vehicles, addresses. A hidden "Want to pick exact dates?" option on the start step opens a calendar for the whole term (nothing before today + 2 days, none after the term ends, one wash a day and nothing else: washes on days one after another are fine, exactly the monthly counts times the months, busy days in amber and rush days in red, all still pickable). A reminder email a week before a membership ends opens the wizard with the old plan filled in (`/app/membership/new?renew=<id>`; a plan sold the older "washes a week" way is read as four weeks' worth a month on the same weekdays). Every wizard shows its progress as a React Bits Stepper (numbered circles that fill as you go; tap a finished step to go back). **Washes done**: a plan's page (and a link on the dashboard) lists the finished washes; tapping one opens what was done and its before and after photos, big on the same page. **Hold to remove**: a plan started but not paid for (on the dashboard and the Membership page), or one that has ended, is cleared with a press-and-hold button (React Bits Hold Button). Nothing is deleted: the unpaid plan's checkout is stopped, WASHO keeps its records, and an active membership or a payment that has come in is never touched.
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

**Exact dates.** The membership wizard has a hidden option to pick every wash date yourself (`custom_dates` on `POST /api/payments/membership-checkout`; `POST /api/membership-preview` shows where an automatic plan lands and how busy each day is). The database checks the same rules the calendar shows (migration 31: one wash a day is the only limit).

**The automatic spread keeps clear of the rush** (migration 31). When the customer does not pick exact dates, each month's washes are spread evenly over the weekdays they chose, one to each equal part of the month, as before; within its part a wash now takes the quietest day (the fewest washes already booked that day, against what that day can take), and with no rush anywhere the dates are exactly what they always were. If the chosen days leave no choice, a busy day is still used: a rush is a warning, never a refusal. The same rule lays out the washes when the payment is verified.

**Washes a month (migration 28).** `POST /api/payments/membership-checkout`, `/api/membership-preview` and `/api/membership-estimate` take `monthly: { body, deep, weekdays }` (the older `weekly_pattern` still works for every membership already sold). Price: the rate card times the monthly counts times the months, the frequency discount keyed by the weekly equivalent (washes a month divided by 4, rounded down: 4-7 = 1 a week, 8-11 = 2, 12 or more = 3 and up, so 12 a month earns what 3 a week always did), then the length discount and the 15% cap, exactly as before. The same plan priced either way costs the same (a test proves it). The database lays the washes out (`plan_monthly_washes`): each month of the term gets its own washes, spread evenly on the chosen weekdays. A paid membership is never refused: if the chosen days fill up between paying and the washes being laid out, any day is used.

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

## Renewal emails (memberships about to end)

A customer is emailed (through Resend, `RESEND_API_KEY` + `EMAIL_FROM`) in up to three steps, each **once** per membership (`email_log` remembers), always with a **Renew my membership** button that opens the wizard with their plan filled in (`/app/membership/new?renew=<id>`; the new plan starts the day after the old one ends, or in two days if it already has):

| Step | When | What it says |
|---|---|---|
| a week before | the last day is 1 to 7 days away | "your membership ends in N days" |
| the last days | the last day is 0 to 2 days away, and only if the first email went out at least 2 days earlier | "a quick last reminder", and how many washes are still unused |
| once it is over | it ended 1 to 3 days ago and was not renewed | "your membership has ended, renew in one tap" |

Never to someone who has **already renewed** (another active membership for the same vehicle that runs past this one), never to an archived customer or one with no email address, never two within 24 hours, and a failed send is tried again on the next run (up to 3 times). A plan chosen as washes in a month says "5 washes a month"; an older one says "3 washes per week".
`runRenewalReminders()` (`backend/src/reminders.ts`) does it; the database lists who is due (`svc_membership_renewals_due`, migration 29). It runs by itself **every hour** while the site is awake, and the numbers in the table above are only the starting values: **Admin → Memberships → Renewal emails** (migration 30) controls them.

**Controlling it from the Admin page** (Operations and the super admin change it; Finance and Support can look; everyone else has no access to Memberships):
- **Send renewal emails automatically**: the master switch of the hourly job. Off means nothing goes out by itself.
- **Each of the three emails**: its own switch (an email that is off is never sent, not even by hand) and how many days before the last day (or, for "after it ended", days after) it covers: heads-up 1 to 14, last reminder 0 to 7, after it ended 1 to 14. With the heads-up switched off, the last reminder no longer waits for it.
- **Send from / until (Pune time)**: the hours the automatic job may send in (9 am to 8 pm to begin with, so nobody is mailed at 3 am). Saving is checked by the database and written to the activity log (`renewal_settings_changed`, with what it was and what it became).
- **Who needs one?** (a dry run: counts per step, nothing sent) and **Send reminders now** run the same job by hand. A person pressing a button is never held back by the master switch or the hours; the three steps still apply.
- **Coming up** lists every membership ending in the next 14 days or ended in the last 7, with what each of the three emails did (sent on a date / failed, will retry / not sent / off) and whether they have already renewed. Clicking an email that has not gone out sends that one to that customer now, once (after a confirmation).
- **Latest emails sent** shows the last 30 with their result and any error.
`/api/cron/reminders` (the outside scheduler) follows the master switch and the hours like the hourly job; `/api/admin/reminders/run` is the by-hand version. A database without migration 30 simply runs on the starting values.
**Important on Render's free plan:** the server falls asleep when nobody visits, and a sleeping server sends nothing. Set `CRON_SECRET` (16+ random characters) on Render and have a free scheduler (cron-job.org, Render Cron Job, GitHub Actions) call `POST https://washo.online/api/cron/reminders` with the header `Authorization: Bearer <CRON_SECRET>` once an hour (the call also wakes the server). Nobody is emailed twice however often it is called.
Customers with no email address (they sign in by phone) get the same reminder on their own pages: a **Renew** card on the dashboard and the Membership page whenever a membership ends within a week or ended in the last week (`RenewalNotice`), with a nudge to add an email.
Resend only mails arbitrary inboxes once the sender domain is verified (resend.com/domains); until then customer emails will not arrive.

## Discounts and coupons (Admin → Discounts)

A membership's price is the rate card times the washes, then these, each its own line the customer sees:
1. **By washes in a month** (a plan's washes a month divided by 4, rounded down, picks the rule: 4 to 7 = rule 1, 8 to 11 = rule 2, 12 to 15 = rule 3 ... 28 = rule 7). Comes off the plan price.
2. **By membership length** (1, 3, 6 or 12 months). Comes off what is left after the first.
3. **The biggest total of those two** (15% to begin with). Anything over it is taken back as its own "cap" line.
4. **A coupon** (below), an extra percentage of the plan price, on top of all that and not counted in the cap.

**Campaign times (migration 36).** A free-wash campaign's **Claims open** and **Claims close** are an exact date and time in Pune time (for example "10 September, 10:00 am to 12 September, 8:00 pm"), picked in the Admin → Campaigns form. They are decided by the clock: before the opening time the website shows the offer as upcoming ("Starts 10 Sept at 10:00 AM") and a claim is refused with the time; from the closing time it is over. A campaign saved without times (every campaign made before) still opens at the start of its first day and closes at the end of its last. The campaign still needs to be **switched on** to show at all, and "Last day for the wash" is still a day.

**Admin → Discounts** holds all of it: the washes-a-month rules and the length rules (change a percentage, add or remove a rule), the biggest total, and the coupons. Changing a rule affects only memberships bought from then on; a membership already paid for keeps its price. (The Services area changes the rules; the Campaigns area makes coupons, so Marketing can make coupons without being able to touch the rest.)

**Coupons** (migration 32). The admin makes a code (3 to 20 letters and numbers, e.g. `EXTRA5`) worth 0.01% to 50% off the plan price, optionally with a last day, a most-uses limit, a note, and "each customer can use it once" (on by default). People are told by word of mouth and type it into **Have a coupon?** on the last step (Review and pay); the server checks it for that customer and says in plain words if it cannot be used (not valid, expired, used up, already used). The price shows it as `Coupon EXTRA5 (5%)`, the slider shows what will be charged, and the Razorpay amount is exactly that.
- The percentage is taken from the plan price (the subtotal): "extra 5%" on a ₹1,800 plan is ₹90, whatever the other discounts are.
- It is frozen into the price when the checkout starts. A use is counted only when the membership is **paid for** (an abandoned checkout uses nothing), and a customer who had already started paying is never refused because the coupon ran out meanwhile.
- A coupon is switched off, never deleted: every use stays on record (Admin → Discounts → Who used it). Making, changing and switching a coupon is in the activity log.
- A coupon **works on** memberships, on single washes, or on both (the admin chooses when making it; migration 33). The box is on the last step of both (Review and pay): a membership takes the extra percentage off the plan price on top of the other discounts; a single wash takes it off the rate-card price, so the Razorpay amount and the booking's price are the discounted amount. A coupon meant for the other kind says so in plain words ("That coupon is for memberships only"). "Each customer can use it once" counts across both kinds. Free-wash claims have no coupon box (they are free). For a single wash the coupon is taken off the payment AFTER the existing `create_booking_payment_intent` has made it (that function is left exactly as it is, because the mobile app may use it): `create_booking_payment_intent_with_coupon`, and a payment that is already taken is never refused. Wrong codes are slowed down: after 10 that did not work in 15 minutes the customer waits.
- The shared database already has a `coupons` table that the mobile app uses for its own first-wash offers (`FREEFIRSTWASH`, `WASHOFREE`). The website's coupons are separate tables (`membership_coupons`, `membership_coupon_redemptions`) and never read or change that one; typing a mobile-app code on the website says it is not valid.

## Ratings and reviews (migration 34)

Every wash that has been done can be rated, single, membership or free wash alike. On the customer's **Washes** tab (Completed & past) each finished wash carries five stars: tap one and a sheet opens with a review box (optional: **the stars can be sent alone**), then **Submit rating** (or **Submit review** when words were typed). The same block is on the wash's own page and in the membership page's finished-wash sheet. It can be changed later (stars and words); there is one rating per wash. Only the customer who had the wash, and only once it is `completed` (the database decides: `rate_wash`). `wash_reviews` is closed to everyone but its functions; the specialist who did the wash is remembered with each rating.
The admin sees it in two places (Washes area, so Operations, Finance, Support and the super admin): on the wash's sheet ("What the customer said") and on the **Reviews** tab (average, how many of each star, the latest ratings, and a filter for 3 stars or less).

## Clearing finished washes from the Washes tab (migration 35)

A finished wash (done, cancelled, refunded or missed) can be **swiped left** (React Bits Swipe Row) to clear it from the customer's own list, with an **Undo** on the toast. Nothing is deleted: the wash, photos, rating and payment stay, WASHO and the specialist still see it, and it still opens from a link (`customer_hidden_washes`, `hide_my_wash`, `unhide_my_wash`). A wash that is coming up, or has a refund waiting, cannot be cleared. A database without the migration just has nothing cleared.

## The home screen and the landing page

- **Home** (`/app`): "Hi, name", then three tiles side by side so everything is in view at once: **Build a membership**, **Book a single wash**, **Add a vehicle** (opens the vehicle sheet right there).
- **Landing**: **Or book one wash** is the turning ring of service photos (React Bits Circular Carousel) with each wash's price, here and on `/services`. The page ends with a **WASHO member card on a lanyard** (React Bits Lanyard: a three.js card hanging from a strap that swings when dragged; its front and back are `src/assets/brand/washo-card.webp` and `washo-card-back.webp`). Its code (about 140 KB gzipped) is only fetched when the visitor scrolls within a screen of it, so it costs nothing to anyone who never gets there; until then, and where WebGL is unavailable, the card shows as a still image.
- **Steps**: the membership wizard, the single-wash wizard and the free-wash claim all show their progress as the React Bits Stepper (numbered circles joined by lines that fill, a tick that draws itself).

## Speed

What makes the first visit quick (and repeat visits nearly instant), all in the repository:
- **Fonts are self-hosted** (`src/fonts.css`, `src/assets/fonts`, preloaded): no third-party stylesheet blocks the first paint. The rupee sign has its own 1 KB file instead of an 80 KB one.
- **Files under `/assets` are cached for a year** (`immutable`: their names change with every build); the page itself is always re-checked. A returning visitor loads the site from their own device.
- **The first requests start before the app's code arrives** (`public/early.js` asks for who is signed in, the rate card and the campaign banner while the scripts download; `src/lib/http.ts` picks the answers up).
- **A few seconds of memory for public answers** (`backend/src/publicCache.ts`): the rate card, a visitor's campaign banner and a visitor's price estimate come from memory, with visitors asking at the same moment sharing one lookup. An admin changing anything, and a claim, empty it at once. A signed-in customer's own answers are never kept.
- **Images are sized for where they are shown** (the service photos about 70 KB, the crew photo 51 KB, the header logo 13 KB), and the loading screen's wall uses small copies.
- Not code: on Render's free plan an idle server falls asleep and the first visit after a quiet spell waits for it to wake. A paid instance, or a free uptime monitor calling `/api/health` every 5 minutes, avoids that.

## Sign-in

- **Mobile number + password** (the main way in for customers). `POST /api/auth/mobile/signup` and `/api/auth/mobile/login`. **No code and no SMS**: a code only helps if the phone company delivers it, and it costs every time. The password belongs to a login Supabase Auth keeps under an address derived from the number (`91XXXXXXXXXX@phone.washo.invalid`, see `backend/src/phone.ts`; `.invalid` can never receive mail, it is never shown or emailed). Supabase's own password sign-in with a *phone* only works for a number a code has confirmed, so this one is typed, not confirmed: it is attached to the login **unconfirmed** and saved on the profile by `set_my_phone` exactly like "add your number". So a typed number **never links to or merges with another account** (only a number a code confirmed does), and a number another account already has is refused ("That mobile number already has a WASHO account"). The session is a normal Supabase one in the usual httpOnly cookies: the long cookie lasts **30 days and starts again on every visit**, so closing the browser signs nobody out. 8 wrong passwords for a number in 15 minutes make it wait; sign-ups are limited per network; staff and admins cannot use it (they sign in with email, an admin with the emailed code too).
  *Consequences to know:* the number is not verified (one person can register a number that is not theirs, but cannot reach anyone else's account or data); a forgotten password is replaced through a code: **"Get a code instead"** (below) signs the person in to the same account, and for the next 15 minutes Account → Password lets them choose a new one without the old one (`POST /api/auth/mobile/password`; the session token's own `amr` claim says it came from a code, so a session that began with a password, or is older, cannot do this; with the current password the usual `POST /api/auth/password` works any time). Accounts made with a code before this have no password until they set one that way.
- **A code to the mobile number** (Supabase Auth phone OTP; how it is delivered depends on the project's SMS hook, see "Phone codes through 2Factor"). Now the **"Get a code instead"** link on the sign-in page: for a forgotten password and for accounts made with a code. It is the only way that gives a *verified* number.
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

## Phone codes through 2Factor (Send SMS Hook)

Supabase Auth used to send phone codes with Twilio Verify. `supabase/functions/send-sms-hook` delivers them through 2Factor instead (approved template `WASHO_LOGIN_OTP`, sender WASHO). **Supabase still generates, stores, checks and expires the 6-digit code and creates the session** (user ids, profiles and sessions do not change); the function only *delivers* the code Supabase hands it. It is not an OTP system of its own and never calls 2Factor's AUTOGEN or VERIFY endpoints.

> **This affects the website AND the mobile app.** A Supabase Auth hook is project-wide: while it is switched on, every phone code of this Supabase project (website sign-in, mobile app sign-in, phone-number change) is delivered through 2Factor. The mobile app's code is not touched. There is no Twilio fallback (a fallback could text the same person twice).

- **2Factor request** (their documentation, "Send OTP (Manual Generation)"): `GET https://2factor.in/API/V1/:api_key/SMS/:phone_number/:otp_value/:otp_template_name`, phone in international form (`+91XXXXXXXXXX`; confirmed by a real send), a 4 to 6 digit code we supply. It answers `{"Status":"Success","Details":"<session id>"}` or `{"Status":"Error","Details":"..."}`. Only Indian mobile numbers (`91` + a number starting 6-9) are sent; anything else is refused.
- **What Supabase sends the hook:** `{ metadata, user: {...}, sms: { otp, phone } }`. The number to text is `sms.phone` (for a phone-number change that is the NEW number; `user.phone` is still the old one). Older Auth versions send only `user`: then `user.phone`.
- **Who may call it.** Supabase signs every hook call (Standard Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256 over `id.timestamp.raw body`, keyed by `SEND_SMS_HOOK_SECRET`). A missing secret, a bad signature, a timestamp more than 5 minutes off, or a `webhook-id` already accepted is refused, and nothing is sent. Without a configured secret or API key the function refuses everything. (`verify_jwt = false` in `supabase/config.toml`, because the signature is the authentication.)
- **What never reaches a log or an error message:** the API key, the request URL, the code, the full phone number (logs show `91******1234`), the hook secret. A network error from `fetch` is only classified (its own text holds the URL). Callers get plain words: 401 invalid signature, 400 unreadable request or non-Indian number, 500 "could not send" when 2Factor says no (key, template, balance), 503 when 2Factor is slow or down (3.5 s limit; Supabase gives a hook about 5 s). Supabase retries a hook only for a 429/503 that carries a `retry-after` header, and this function never sends one, so the person simply asks for a new code. A failed send is never reported as success.
- **Files:** `supabase/functions/send-sms-hook/{index.ts,handler.ts}`, `supabase/functions/_shared/sms.ts`; tests `sms.test.ts` and `handler.test.ts` (run by `npm test`, 2Factor is mocked).
- **Secrets** (Supabase → Edge Functions → Secrets; never in Git or this repo's `.env`): `TWOFACTOR_API_KEY`, `SEND_SMS_HOOK_SECRET` (`v1,whsec_<base64>`, the SAME value as the hook's secret in Authentication → Hooks), `TWOFACTOR_OTP_TEMPLATE` (optional, default `WASHO_LOGIN_OTP`).
- **Deploy:** `supabase functions deploy send-sms-hook --no-verify-jwt --project-ref opjbxvpffrceibbuybiq` (always by name: without a name the CLI deploys every function). Never `supabase config push` for this repo (its `config.toml` is only a fragment), and do not add an `[auth.hook.send_sms]` block to it.
- **Switch on:** Authentication → Hooks → Send SMS hook → HTTPS, URL `https://opjbxvpffrceibbuybiq.supabase.co/functions/v1/send-sms-hook`, secret = `SEND_SMS_HOOK_SECRET`, enable. Also check Authentication → Providers → Phone: phone provider on, SMS OTP length 6.
- **Roll back (about a minute, no code change):**
  1. Authentication → Hooks → Send SMS hook → turn it **off** (or delete it). Supabase goes back to the Phone provider settings, which were left untouched (Twilio Verify and its credentials).
  2. Nothing to redeploy. The function can stay deployed; it is inert without the hook.
  3. Ask for a **fresh code** afterwards: with the hook on, Supabase checks codes itself; with it off, Twilio Verify checks them, so a code issued under the other mode will not work.
  4. Sign in once on the website and once in the mobile app to confirm. Existing sessions are not affected either way.
- **Replay protection is per running instance** (an id is remembered for 11 minutes in memory), plus the 5-minute timestamp window and Supabase's own SMS rate limits.

## Tests

| Command | What it proves |
|---|---|
| `npm run typecheck` | frontend + server |
| `npm test` | pure unit tests (formatting, Razorpay signature helpers, the Send SMS Hook with a mocked 2Factor) |
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
