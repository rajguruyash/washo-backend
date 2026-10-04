-- 20261005000002_cutover_archive_credit_tables.sql
-- *** CUTOVER (after ...0001). Removes the credit/entitlement tables WITHOUT deleting history blindly. ***
--
--   * If membership_entitlements, entitlement_transactions and membership_periods are ALL empty:
--     they are dropped, along with the triggers and helper functions that only served them.
--   * If ANY of them holds rows: they are moved, untouched, into a locked-down schema `legacy_credits`
--     (no client access at all) so the history is preserved for finance/audit. Nothing is deleted.
--
-- Either way no live function or policy reads them any more.

DO $$
DECLARE
  n_ent bigint; n_tx bigint; n_per bigint;
BEGIN
  SELECT count(*) INTO n_ent FROM public.membership_entitlements;
  SELECT count(*) INTO n_tx  FROM public.entitlement_transactions;
  SELECT count(*) INTO n_per FROM public.membership_periods;

  IF n_ent = 0 AND n_tx = 0 AND n_per = 0 THEN
    DROP TABLE public.entitlement_transactions;
    DROP TABLE public.membership_entitlements;
    DROP TABLE public.membership_periods;
    DROP FUNCTION IF EXISTS public.validate_entitlement_transaction();
    DROP FUNCTION IF EXISTS public.validate_entitlement();
    DROP FUNCTION IF EXISTS public.validate_membership_period();
    RAISE NOTICE 'Credit tables were empty and have been dropped.';
  ELSE
    CREATE SCHEMA IF NOT EXISTS legacy_credits;
    REVOKE ALL ON SCHEMA legacy_credits FROM PUBLIC, anon, authenticated;
    ALTER TABLE public.entitlement_transactions SET SCHEMA legacy_credits;
    ALTER TABLE public.membership_entitlements  SET SCHEMA legacy_credits;
    ALTER TABLE public.membership_periods       SET SCHEMA legacy_credits;
    REVOKE ALL ON ALL TABLES IN SCHEMA legacy_credits FROM PUBLIC, anon, authenticated, service_role;
    EXECUTE format('COMMENT ON SCHEMA legacy_credits IS %L',
      format('Retired credit system, archived read-only. entitlements=%s, transactions=%s, periods=%s rows at archive time. Do not delete without finance sign-off.', n_ent, n_tx, n_per));
    RAISE NOTICE 'Credit tables had data (entitlements=%, transactions=%, periods=%) and were archived to legacy_credits.', n_ent, n_tx, n_per;
  END IF;
END $$;

-- The credit-only event type stays allowed in booking_events so historical rows remain valid.
-- The retired stubs from ...0001 (create_custom_membership, book_membership_credit_wash,
-- consume_membership_entitlement_for_booking, the create_on_demand_booking overloads) should be DROPPED in a
-- later migration once no mobile build in the field still calls them.
