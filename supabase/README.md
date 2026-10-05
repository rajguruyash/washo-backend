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
