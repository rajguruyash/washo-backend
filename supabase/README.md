# WASHO Supabase: migrations for the website + mobile app

**Status: written and tested locally. NOTHING here has been applied to any Supabase project.**
Everything was run only against throwaway local Postgres databases restored from `washoapp/washo_schema.sql`
(a schema-only dump of production). No production data was read, copied, changed or deleted.

## The rules these migrations implement

| Rule | Where |
|---|---|
| No credits, carry-forward, ledger, FEFO, membership periods | `cutover/…0001`, `…0002` |
| On-demand prices: Bike 65, Car Body 150, Car Deep 220, SUV Deep 250 (SUVs use Car Body at 150) | `…0002` |
| No fixed plans. Custom membership only: 1, 2 or 3 washes a week (1 = one wash type; 2 = 1 Body + 1 Deep; 3 = Body + Deep mix) | `…0002`, `…0004` |
| Washes per month = washes per week x 4; length 1 / 3 / 6 / 12 months | `…0002`, `…0005` |
| Frequency discount: 3/week = 10%. Duration discount: 3 / 6 / 12 months = 5 / 10 / 15%. Combined **capped at 15%**; the cap is its own labelled line | `…0002` (data, not code) |
| Customer -> WASHO reviews -> WASHO sets price -> customer accepts -> Razorpay -> verified -> membership active -> washes generated | `…0003`..`…0005` |
| Customer is never shown a price before WASHO approves; WASHO adjustments are a labelled line with a reason | `…0004` |
| Quote validity 7 days (`pricing_settings.quote_validity_days`) | `…0002` |
| Membership washes can be rescheduled, not cancelled | `…0006`, `cutover/…0001` |
| One Razorpay webhook, in the Supabase edge function | `functions/razorpay-webhook` |
| Security: Razorpay signature, amount, ownership, idempotency; no unpaid activation; admin roles; worker restriction; private photos | `…0001`, `…0005`, `cutover/…0003`, `…0004` |

Assumptions I made (change them in data, not code): SUV memberships use *Car Body Wash* (150) for body and *SUV Deep Cleaning* (250) for deep. Bikes can repeat Bike Wash 2 or 3 times a week. GST is not modelled: customers are charged exactly the listed amount. Service durations and "includes" text are placeholders.

## Two folders, applied at different times

### `migrations/`: SAFE. Apply first. The mobile app keeps working unchanged.
Additive, or strictly-more-correct versions of functions the app already calls (same signatures). Re-runnable.

| File | What it does |
|---|---|
| `…0001_security_safe_fixes` | `admin_set_user_role` admin-only + audited; hardcoded admin emails replaced by real roles; phone-linking takeover closed; `activate_paid_*` service-only + ownership; booking-event CHECK fixed; coupons not public; new functions private by default |
| `…0002_catalog_and_pricing` | the rate card, discount rules, settings, `compute_membership_quote`, public catalogue |
| `…0003_schema_additions` | new columns/tables (`membership_requests`, `website_leads`, `audit_events`…), `washo_api` role, unique indexes |
| `…0004_membership_request_flow` | create / review / accept / decline, with price hidden until approved |
| `…0005_payment_intents_and_settlement` | `create_booking_payment_intent`, `attach_provider_order`, `settle_payment`, schedule generation |
| `…0006_reschedule_membership_wash` | fixes reschedule (changing the time slot always failed) |
| `…0007_fix_worker_call_and_start` | `worker_call_customer` never worked; any worker could steal a job |
| `…0008_service_rpc_wrappers` | service-only wrappers so edge functions can reach the private payment functions |

### `cutover/`: apply ONLY after the mobile app + edge functions are updated.
These intentionally break old app behaviour (free bookings, credit redemption, public photo links, workers reading every customer).

| File | Needs this app change first |
|---|---|
| `…0001_remove_credits_and_unpaid_creators` | App books via `create-razorpay-order` (intents) and requests memberships; no credit screens. Old builds get "please update the app" |
| `…0002_archive_credit_tables` | Drops the credit tables if empty; **archives them to `legacy_credits` if they hold any rows**. Never deletes history |
| `…0003_worker_privacy` | Worker app reads the pool with `worker_pool()` instead of selecting `bookings`/`profiles` |
| `…0004_private_photos` | Apps use signed URLs instead of `getPublicUrl` |
| `…0005_profile_phone_lock` | Customers can no longer type their own phone number into their profile |

After a deprecation window, drop the refusing stubs left by `cutover/…0001` (`create_custom_membership`, `book_membership_credit_wash`, `consume_membership_entitlement_for_booking`, the `create_on_demand_booking` overloads).

## Before applying anything to a real project
1. Take a backup or create a Supabase **branch**. Apply there first.
2. Run the read-only checks (grants of the risky functions, row counts of the credit tables, current `pricing_rules`, whether the test worker from migration 009 exists).
3. On the branch, confirm `GRANT authenticated TO washo_api` works (it needs admin option on `authenticated`), then give the role a password: `ALTER ROLE washo_api WITH LOGIN PASSWORD '...'`.
4. **Webhook secret.** The deployed webhook only has `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. The new one requires `RAZORPAY_WEBHOOK_SECRET`, the same string entered as the secret on the webhook in the Razorpay dashboard. (The old code fell back to the API key secret, which Razorpay does not sign webhooks with unless you typed that same value there.) Set it before deploying.
5. Deploy `functions/*` with `config.toml` (only the webhook has `verify_jwt = false`).
6. Optional: schedule `select app_private.expire_membership_quotes()` daily with `pg_cron`.

## Testing (all local, none of it touches Supabase)
```bash
npm run db:baseline        # rebuild the production-schema replica from washo_schema.sql
npm run db:test:baseline   # 15 "red" tests: every vulnerability/bug reproduces on production's schema
npm run db:test            # safe migrations + cutover (applied inside rolled-back transactions)
npm run db:test:full       # everything applied for real: exploits closed + full lifecycle
npx vitest run supabase/functions   # signature / webhook helpers
```
The baseline replica emulates Supabase's default grants (pg_dump omits them). If your real grants differ, run the grants
query from the plan and tell me.

## Import the old website leads (read-only on Render, dry-run by default)
```bash
LEGACY_DATABASE_URL=... TARGET_DATABASE_URL=... npm run leads:import            # counts only
LEGACY_DATABASE_URL=... TARGET_DATABASE_URL=... npm run leads:import -- --apply
```
Idempotent. Payment screenshots are not copied; their old path is kept.

## Not done yet
- The website backend and UI still use their own local schema. Switching them to these Supabase functions, removing the credit UI, and building the membership-request wizard is the next step.
- The mobile app needs: the intent-based payment flow, the membership-request screens, `worker_pool()`, signed photo URLs, removal of credit screens.
- Edge functions could not be run here (no Deno). Their pure logic is unit-tested; they need a deploy to a branch and a Razorpay test-mode payment.
- Refunds: a cancelled paid wash creates a `requested` refund for the full amount (migration 12); an admin approves it and the website server asks Razorpay to pay it back. There is no Razorpay webhook.
- Coupons: the old edge function read a column that does not exist (`discount_percent`); coupons are not wired into the new intent flow.


## Added for the website integration

- `migrations/20261004000009_worker_workflow.sql` (SAFE, additive): `worker_queue`, `worker_pool`, `worker_claim_booking` (paid + unclaimed only),
  `worker_confirm_customer`, `worker_customer_unavailable` (wash stays scheduled), `worker_report_issue`, `worker_add_note`, a stricter
  `save_booking_photo`, `booking_photos_for_viewer`, `admin_assign_worker`, `admin_assign_membership_worker`, `admin_reschedule_wash`,
  refunds admin read + `admin_resolve_refund`.
- `migrations/20261004000006` now has one shared reschedule core used by customers and admins; a moved wash returns to the membership's regular specialist.
- `cutover/20261005000001` also replaces `admin_update_booking` without credit logic.
- Website API tests: `./supabase/tests/run.sh api`. Local click-through: `./supabase/tests/run.sh dev`.

## Refund workflow (migration 12)

- `cancel_customer_booking()` (moved here from `cutover/20261005000001`, so it works before the cutover): cancelling a paid on-demand wash raises a `requested` refund for the FULL amount paid; membership washes still cannot be cancelled by customers. No credit logic.
- `admin_begin_refund(id)` claims it (`approved`, `approved_at`); a claim younger than two minutes is refused so two admins cannot both pay.
- `admin_finish_refund(id, razorpay_refund_id)` records `processed`, marks the payment `refunded`, adds the `refunded` booking event. Idempotent for the same Razorpay refund id.
- `admin_fail_refund(id, reason)` records `failed` with `failure_reason` (retryable). `admin_resolve_refund` still records a refund paid by hand and now does the same bookkeeping for `processed`.
- Adds `refunds.approved_at` and `refunds.failure_reason`. Tests: `supabase/tests/after-12-refund-workflow.test.ts`, `backend/tests/api-refunds.test.ts`.

## Admin management (migration 13)

Adds `profiles.archived_at` and `customer_addresses.archived_at` and the admin functions behind the Admin page: `admin_update_customer_profile`, `admin_set_profile_archived`
(customers and specialists; guards for live work, releases a specialist's washes to the pool), `admin_begin_password_reset`, `admin_save_vehicle` / `admin_set_vehicle_active`,
`admin_save_address` / `admin_set_address_archived`, `admin_create_booking` (cash or complimentary, source `admin`), `admin_update_booking_details`, `admin_save_service` /
`admin_set_service_active` / `admin_set_service_price` (versioned), `admin_set_discount` / `admin_remove_discount`, `admin_set_pricing_setting` (whitelisted keys and ranges).
Triggers stop an archived specialist from being assigned work. Nothing is deleted. Tests: `supabase/tests/after-13-admin-management.test.ts`, `backend/tests/api-admin-management.test.ts`.


## Free-wash campaigns (migration 14)

Adds `campaigns` and `campaign_claims` (read-only to people through row-level security: an admin sees all, a customer sees their own claim and its campaign; every write goes through the functions below), and:
`claim_campaign_wash` (customer: checks the offer is on and open, the total and per-day caps, new customer, one per phone / plate / flat, the date window, lead time and one wash per vehicle per day; creates the free body wash and the claim in one step, serialised per campaign),
`get_campaign_status` (public: the campaign, spots left, full days, this visitor's state and their membership offer), `admin_save_campaign` / `admin_set_campaign_active`.
A trigger on `bookings` keeps the claim in step with its wash (completed starts the offer, cancelled gives the claim back, no_show uses it up). A trigger on `memberships` records a membership priced with the offer.
`app_private.compute_membership_quote` is replaced with the same logic plus the offer for the signed-in customer. No rows are created or changed; no campaign exists until an admin creates one.
Tests: `supabase/tests/after-14-campaigns.test.ts`, `backend/tests/api-campaign.test.ts`.

## Campaign audience (migration 15)

Replaces `admin_save_campaign` with a version that takes `p_new_customers_only` (NULL = leave as it is; a new campaign with no answer stays "new customers only"), so a campaign can be open to anyone. `claim_campaign_wash` and `get_campaign_status` already honoured `campaigns.new_customers_only`; the one-per-phone / plate / flat rules, the caps and the dates apply either way.
The old 14-argument version is dropped so a call cannot be ambiguous. Tests: `supabase/tests/after-15-campaign-audience.test.ts`, `backend/tests/api-campaign.test.ts`.

## Any mix of Body and Deep washes (migration 16)

`app_private.compute_membership_quote` loses its composition rules: 2 a week no longer has to be 1 Body + 1 Deep, and 3 or more no longer has to include both. A membership is 1 to 7 washes a week in total on different weekdays, any mix of Body and Deep (a bike only has the Body wash). The price calculation, discounts, cap and the welcome offer are unchanged.

## A membership's last day in Pune time (migration 17)

`app_private.fulfil_membership` compared the schedule against `end_at::date`, which in a UTC session is the evening before the last day (end_at is midnight in Pune), so the final day of a term could never be used and a tight plan with a skipped day could fail to schedule. It now reads the last day in Pune time, as the reschedule function already does.

## Sent emails (migration 18)

`email_log` (admins can read it; nobody else) with a unique (kind, ref_id), and three functions for the website server (service role and the website's database role only): `svc_claim_email` (takes the right to send; NULL if already sent, being sent, or given up after 3 tries),
`svc_finish_email` (records sent or failed) and `svc_membership_reminders_due` (active memberships ending within N days, with an email, not yet reminded, not already renewed for the same vehicle). Tests: `supabase/tests/after-18-email-log.test.ts`, `backend/tests/api-emails.test.ts`.

## Crowd limits (migration 19)

`capacity_rules` (one row for weekdays, one for weekends: whole-day busy/full and per-window busy/full; defaults 10/15 and 6/9 on weekdays, 15/20 and 9/12 on weekends), editable only through `admin_set_capacity` (admin, audited as `capacity_changed`; it refuses a "full" below its "busy").
`app_private.washes_on` counts the washes holding a place (everything except cancelled, refunded, refund_requested, no_show and rescheduled), `public.get_capacity(from, to)` (any signed-in user, at most 400 days) returns each day's total, limit and state plus each window's state, and
`app_private.require_capacity` is called by `create_booking_payment_intent` and `claim_campaign_wash`, so a full day or window cannot be booked however the request arrives. Admin-made bookings and paid memberships are never blocked. Tests: `supabase/tests/after-19-capacity.test.ts`, `backend/tests/api-capacity.test.ts`.

## Exact dates for a membership (migration 20)

`membership_requests.custom_dates` (jsonb), the planner `app_private.plan_membership_washes` (lays a weekly pattern across the term, skipping days when the vehicle already has a wash and, when asked, days that are full; says "cannot fit all N washes" when it falls short),
`app_private.check_custom_dates` (exact count per wash kind, one a day, on or after today + `membership_min_lead_days`, within the term, at most the weekly number in any Monday to Sunday week, no clash, no full days) and `public.preview_membership_dates` (shows a customer where a plan lands).
`create_membership_request` and `start_membership_checkout` gain a final `p_custom_dates jsonb DEFAULT NULL` argument (the old 9-argument versions are dropped so a call cannot be ambiguous), and `fulfil_membership` lays the washes out with the planner or the chosen dates (includes the migration 17 fix).
Tests: `supabase/tests/after-20-exact-dates.test.ts`.

## A specialist moves a wash; a customer clears a plan (migration 21)

`public.worker_reschedule_wash(booking, new_date, new_slot?, reason?)`: a specialist who holds a membership wash moves it when the vehicle is not available. It runs the same core as the customer's and the admin's reschedule (`app_private.reschedule_wash`, which now records `by` = customer | worker | admin in the booking event), so the same rules hold:
the membership must be active, the wash not started, the new day inside the term and not earlier than the wash's original day, and no other wash for that vehicle that day. A specialist may choose today or any later day (a customer needs 2 days' notice). The wash stays with that specialist on its new day unless the membership has a different regular specialist.
It refuses single washes, washes the specialist does not hold, and a started wash.

`customer_hidden_plans` and `public.remove_my_plan(kind, id)`: a customer clears a plan from their own pages. `kind` is `membership_request` (a plan started but not paid for, or an earlier request that has ended) or `membership` (one that has ended). Nothing is deleted: the plan is remembered as hidden (the website lists skip it; admins still see everything).
An unpaid plan's checkout is stopped the way starting a different plan already does it (its open payment is marked failed, the request cancelled). An active membership, a request that has become a membership, and a plan whose payment has been received are refused. Tests: `supabase/tests/after-21-worker-reschedule.test.ts`, `backend/tests/api-reschedule-remove.test.ts`.

## Crowd limits never block (migration 22)

Admin → Capacity is now a warning, not a wall. `require_capacity()` (single-wash checkout, free-wash claim) never refuses; `plan_membership_washes()` no longer passes over a crowded day and `check_custom_dates()` no longer refuses one (a day where the same vehicle already has a wash is still refused, and so are the term, notice and per-week rules).
`get_capacity()` is unchanged: it still reports ok / busy / full per day and window, and the website shows "full" as red ("Rush") and "busy" as amber. Wording only: `create_membership_request`'s "cannot fit" message and `admin_set_capacity`'s messages say red and amber. No data is touched. Tests: `after-19-capacity.test.ts`, `after-20-exact-dates.test.ts`, `backend/tests/api-capacity.test.ts`.

## Completing a membership wash without credits (migration 23)

Production still had the mobile app's original `worker_complete_wash`, which for a membership wash spends a wash credit (`consume_membership_entitlement_for_booking`). Memberships bought on the website have no credits, so a specialist's final "Mark wash completed" failed. Migration 23 replaces only that function with the credit-free one from `cutover/20261005000001` (the wash must be held by the caller and in progress,
needs a before and an after photo, becomes completed, the schedule entry is marked completed, the event is logged and the customer notified; completing twice does nothing). Nothing else from the cutover is applied: the old mobile booking functions, photo links and the workers' view of customers are untouched. When the cutover is applied later it installs the identical function.
Tests: `supabase/tests/after-23-worker-complete.test.ts`.

## Free washes are placed by WASHO (migration 24)

A campaign claim no longer asks for a date or a time window. `app_private.pick_campaign_slot()` chooses the earliest day from today to the campaign's last day that has room under the campaign's own daily limit and where the vehicle has no other wash, preferring a day that is not red in Admin → Capacity (a red day is used only when every day is red), and on it the quietest window that is still far enough ahead (the usual notice rule).
`claim_campaign_wash()` keeps its signature but ignores any date or window passed in, so nobody can choose by calling the API directly; it returns `scheduled_date` and `time_slot`, and refuses plainly when no day is left. Every other rule is unchanged. Tests: `after-14-campaigns.test.ts`, `after-19-capacity.test.ts`, `backend/tests/api-campaign.test.ts`.

## A typed mobile number for email customers (migration 25)

`public.set_my_phone(number)` sets (or, with NULL, clears) the number on the caller's own customer profile, without a code: 10 digits starting 6 to 9 (a +91 or 91 in front is accepted), stored as +91XXXXXXXXXX. It refuses someone who signs in WITH a confirmed number (that number is their identity), a number another profile already has, staff and visitors.
It is a typed number, not a verified one, and never links or merges accounts (only a number a login has confirmed does that). It raises the same `washo.allow_identity_change` switch the account-merge function uses, so the profile phone lock in `cutover/20261005000005`, when it is applied, still lets it through. The audit trail records `phone_added_unverified` with the last four digits. Tests: `after-25-set-my-phone.test.ts`, `backend/tests/api-email-login.test.ts`.

## A login with no profile gets one when it signs in (migration 26)

A customer profile is created by a trigger when an auth account is created. A login made before that trigger existed (production has a few, including an email address that signed up in September) could sign in but had no profile, and the website said "Your account is not set up yet".
`public.ensure_my_profile()` repairs exactly that, for the CALLER's own login and only when it has no profile: a login with a confirmed number joins the profile that already has the number (the usual phone linking), otherwise a customer profile is made from the login's details. It never touches a login that has a profile and never makes staff.
The website calls it right after a code has been accepted (email code and phone code). Tests: `after-26-ensure-my-profile.test.ts`, `backend/tests/api-email-login.test.ts`.



## Admin roles, support, settings, activity log, dashboard and export (migration 27)

`20261004000027_admin_roles_support_settings.sql`, additive and re-runnable. New: `admin_access` (one role per admin: super_admin, operations, finance, marketing, support), `admin_role_areas` (what each role may `view` or `manage`, as data), `app_settings` (maintenance mode, its message, the big-refund threshold), `support_tickets` + `support_messages`.
All five tables have row-level security on and NO direct access for anyone: everything goes through `SECURITY DEFINER` functions that check the caller's role (`app_private.require_access(area, level)`). Functions: `my_admin_access`, `admin_team`, `admin_set_access`, `admin_promote_to_admin`, `admin_set_admin_active`, `get_public_settings` (anyone), `admin_get_settings`, `admin_set_setting`, `admin_refund_policy`,
`create_support_ticket`, `my_support_tickets`, `my_support_ticket`, `reply_to_my_ticket`, `admin_support_list`, `admin_support_get`, `admin_support_reply`, `admin_support_set_status`, `admin_activity`, `admin_log_event`, `admin_dashboard`, `admin_export`.
`admin_begin_refund`, `admin_finish_refund`, `admin_fail_refund` and `admin_resolve_refund` are replaced with the same bodies plus the `payments` permission, and (for a refund at or above the threshold) the super admin.
The seed makes rajguruyash29@gmail.com the super admin and any other existing admin Operations. An admin with NO row in `admin_access` can do nothing new (fails closed); the website still treats the owner's email as super admin so a mistake in the table cannot lock the owner out.
Production dry run (rolled back): data fingerprint unchanged, the one admin becomes super_admin with all 21 areas, the dashboard / export / team / settings functions answer for them against real data, and `anon` is refused.


## Washes in a month (migration 28)

`20261004000028_monthly_membership_plan.sql`, additive. A membership can be chosen as washes in a MONTH (4 to 28, any mix of Body and Deep) instead of washes a week. New columns on `membership_requests` (`monthly_body`, `monthly_deep`, `preferred_weekdays`); a monthly request has an empty `weekly_pattern` and `frequency_per_week` holds the weekly equivalent, so every older reader keeps working.
New: `compute_monthly_quote`, `estimate_monthly_price` (anyone), `plan_monthly_washes` (the one place that lays a month out: windows tile the term, washes at positions (i + 0.5) x days / washes among the candidate weekdays, Deep cleans spread among them), `check_custom_dates_counts`, `preview_monthly_dates`, `create_monthly_membership_request`, `start_monthly_membership_checkout`.
Replaced (same bodies, only what they say or count changed): `fulfil_membership` (a monthly plan holds monthly_body + monthly_deep washes a month; a weekly plan is untouched), `my_membership_requests` / `admin_list_membership_requests` / `svc_membership_reminders_due` (more columns), `worker_queue` (the label says "5 washes a month · 3 months"), `admin_export` (memberships: "Washes a month").
Production dry run (rolled back): data fingerprint unchanged; 3 a week x 3 months and 8 Body + 4 Deep x 3 months both cost 5,335.20; the customer, admin, export and reminder reads work on real rows; anon is refused.


## Renewal emails in three steps (migration 29)

`20261004000029_membership_renewal_stages.sql`, additive. `svc_membership_renewals_due(kind, from_days, to_days, requires_kind, requires_days, limit)` lists who is due for one of three emails (`membership_renewal_reminder`: ends in 1-7 days; `membership_renewal_last_call`: ends in 0-2 days, only after the first went out 2+ days earlier; `membership_renewal_ended`: ended 1-3 days ago). A plan's last day is the day its washes stop, so "0 days" is the last day itself.
Excluded: already renewed, archived, no email, cancelled; once per kind per membership (`email_log`); never two renewal emails within 24 hours. Only the service role and the website's database role can call it. `svc_membership_reminders_due()` (first step only) is kept.

## Admin controls for the renewal emails (migration 30)

`20261004000030_renewal_email_controls.sql`, additive and re-runnable. One new row in `app_settings` (`renewal_emails`, defaults = exactly what the emails always did: automatic on, heads-up 7 days, last reminder 2 days, after-it-ended 3 days, sending 9 to 20 Pune time) and these functions:
- `svc_renewal_settings()` (service role / the website's database role only): what the job reads. `app_private.renewal_settings()` fills any missing part from the defaults, so a half-written row cannot break the job.
- `admin_get_renewal_settings()` (needs to VIEW Memberships), `admin_set_renewal_settings(jsonb)` (needs to MANAGE Memberships: Operations, super admin): checked (switches are true/false; days heads-up 1-14, last 0-7, ended 1-14; hours 0-23 before 1-24; whole numbers only) and audited as `renewal_settings_changed`.
- `admin_renewals_overview()`: memberships ending within 14 days or ended within 7 with what each email did, whether they renewed, and the 30 latest emails. `admin_renewal_row(uuid)`: one membership in the shape the email needs, for "Send now".
Production dry run (rolled back, production checked untouched afterwards): data fingerprint unchanged; the job and the Admin page read the defaults; the owner saved a change (audited) and bad settings were refused; anon is refused.

## Exact dates with one wash a day, and a spread that keeps clear of the rush (migration 31)

`20261004000031_exact_dates_any_days_and_rush_aware_spread.sql`, additive and re-runnable; no table and no stored row is touched.
- `app_private.check_custom_dates_counts` (replaced, same arguments): the "no more than N washes in one week" rule is gone. What remains: exactly the plan's Body and Deep counts for the term, one wash a day, inside the term, not before the earliest start, never on a day the vehicle already has a wash. (`p_per_week` is no longer used. A plan chosen the older way, washes a week, keeps its own rules.)
- `app_private.day_load(date)` (new): how full a day is as a share of what that day can take (weekend vs weekday limits from `capacity_rules`); only used to rank days.
- `app_private.plan_monthly_washes` (replaced, same arguments and result): each month's candidate days are cut into as many equal parts as there are washes, one wash per part, as before; inside its part a wash takes the quietest day, and among equally quiet days the one that was always picked, so with no rush the dates are unchanged. Used by the preview and when the payment is verified.

## Coupons (migration 32)

`20261004000032_coupons.sql`, additive. **The shared database already has a `public.coupons` table that the mobile app uses (`discount_pct`, `validate_coupon`); it is not touched.** New tables `membership_coupons` (code A-Z0-9 3 to 20, `discount_bp` 1 to 5000, `is_active`, optional `expires_on` and `max_uses`, `once_per_customer`) and `membership_coupon_redemptions` (one row per paid membership that used a coupon, unique per membership); both are closed to everyone but the functions.
- `app_private.apply_coupon(quote, code, customer)` puts a coupon on a price quote: extra percentage of the subtotal, added to `total_discount_cents`, `final_cents` lowered, and a `coupon` object `{id, code, bp, cents}` in the quote. Refuses with a plain message (not valid, expired, used up, already used). `public.estimate_monthly_price_with_coupon(...)` is the review step (signed-in customers only).
- `create_monthly_membership_request` and `start_monthly_membership_checkout` (replaced; a new last argument `p_coupon text DEFAULT NULL`, so a call without it behaves exactly as before). A retry of the same plan with the same coupon returns the same payment; a different coupon (or none) replaces the open checkout.
- A trigger on `memberships` records the redemption when a paid membership's `pricing_snapshot` carries a coupon, so `fulfil_membership` is untouched and the use is counted at payment, never at checkout.
- Admin (Campaigns area): `admin_list_coupons`, `admin_save_coupon` (create or change; the code never changes), `admin_set_coupon_active`, `admin_coupon_uses`. Audited as `coupon_created`, `coupon_changed`, `coupon_switched_on`, `coupon_switched_off`.
Production dry run (rolled back, production checked untouched afterwards): see the commit message.

## Coupons on single washes (migration 33)

`20261004000033_coupons_single_wash.sql`, additive. `membership_coupons.applies_to` (`membership` | `single` | `both`; coupons made before this keep working on memberships only) and redemptions can now be a `booking_id` instead of a `membership_id` (exactly one of the two). `app_private.check_coupon(code, customer, kind)` is the one place that decides whether a customer may use a code for a membership or a single wash (on, not expired, not used up, not used before by them when "once per customer", meant for this kind); `apply_coupon` (memberships) asks it, and so does `coupon_for_single`.
- `estimate_single_wash_with_coupon(vehicle, service, code)`: the review step's price (signed-in customers only).
- `create_booking_payment_intent_with_coupon(...)`: CALLS the existing `create_booking_payment_intent` (untouched: the mobile app may use it) and then lowers that pending payment's amount and writes the coupon into its `intent`, so settlement, the booking's `price_cents` and refunds all use the discounted amount. A coupon that cannot be used raises and undoes the payment it just made. With no coupon it is exactly the old function.
- A trigger on `payments` (only for `on_demand` payments that get a `booking_id` and carry a coupon) records the use when the wash is PAID for.
- `admin_save_coupon` (replaced; a new last argument `p_applies_to` defaulting to `membership`, so a call from the website that is live today still works), `coupon_json` and `admin_coupon_uses` say what a coupon works on and whether each use was a membership or a single wash.

## Ratings and reviews (migration 34)

`20261004000034_wash_reviews.sql`, additive; the shared database had no review or rating table or function. `wash_reviews` (one per `booking_id`, rating 1-5, optional review up to 1000 characters, the specialist who did the wash; closed to everyone but the functions). `rate_wash(booking, rating, review)` (the customer's own completed wash; saves or changes; audited as `wash_rated` / `wash_rating_changed`), `my_wash_reviews(ids)` (their own), `admin_wash_review(booking)` and `admin_list_reviews(max_rating, limit)` (Washes area: Operations, Finance, Support, super admin; the list carries the average and a count per star).

## Clearing finished washes (migration 35)

`20261004000035_hide_finished_washes.sql`, additive. `customer_hidden_washes` (a customer reads only their own rows), `hide_my_wash(booking)` (done, cancelled, refunded or missed washes only) and `unhide_my_wash(booking)`. Nothing is deleted.
Production dry run (rolled back, production checked untouched afterwards): see the commit message.

## Campaign opening and closing times (migration 36)

`20261004000036_campaign_times.sql`, additive. `campaigns.claim_opens_at` / `claim_closes_at` (timestamptz, both set or both empty, closing after opening). `app_private.campaign_opens_at(campaign)` and `campaign_closes_at(campaign)` are the one place that says when a campaign opens and closes: the exact times when there are some, else the start of the first day and the end of the last (Pune time), so a campaign made before this behaves exactly as it did.
- `get_campaign_status` (replaced): the campaign people can claim now, or that opens soon, chosen by the clock (open ones first); it also returns `claim_opens_at` and `claim_closes_at`.
- `claim_campaign_wash` (replaced, one change): refuses before the opening time with "This offer opens on 10 Sep, 10:00 am" and from the closing time with "This offer has ended".
- `admin_save_campaign` (replaced; two new last arguments, both optional): derives `claim_opens_on` / `claim_closes_on` from the times as Pune dates, so everything that reads the dates keeps working. A call without times (the website that is live today) still works and leaves a campaign with whole days.
Production dry run (rolled back, production checked untouched afterwards): see the commit message.


## Deleting a campaign (migration 37)

`20261004000037_campaign_delete.sql`, additive. Deleting a campaign means archiving it, so nothing a customer claimed or the audit trail is lost.
- `campaigns.archived_at` (timestamptz, empty for every campaign that exists today) and an index over the campaigns that are not archived.
- `admin_archive_campaign(id)` (new): switches the campaign off, stamps `archived_at`, and writes a `campaign_deleted` audit entry with the code and the number of claims. Any signed-in admin, like saving a campaign (the same rule as the other campaign controls). Its short name can never be used again.
- `campaigns_stay_archived` (trigger): an archived campaign cannot be switched back on or edited ("This campaign was deleted"). Updates that change nothing go through.
- The admin list leaves archived campaigns out. The BFF falls back to the old list when a database does not have this migration yet.
Production dry run (rolled back, production checked untouched afterwards): see the commit message.
