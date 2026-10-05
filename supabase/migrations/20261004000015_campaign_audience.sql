-- 20261004000015_campaign_audience.sql
-- SAFE and re-runnable. Who may claim a campaign's free wash: anyone, or new customers only.
--
-- campaigns.new_customers_only has existed since migration 14 (default true) and claim_campaign_wash() / get_campaign_status() already honour it,
-- but admin_save_campaign() could not set it. This replaces it with a version that takes the switch (NULL = leave as it is; a new campaign
-- with no answer stays "new customers only"). Everything else about the function is unchanged. The one-per-phone / vehicle / flat rules, the
-- caps and the dates apply either way; "new customers only" additionally requires no earlier wash or membership and a vehicle nobody has had washed.
--
-- The old 14-argument version is dropped so a call with 14 arguments cannot be ambiguous. The website sends all 15.

DROP FUNCTION IF EXISTS public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean);

-- p_id NULL creates (the code is fixed once created: it can be in links and on posters). Returns the campaign id.
CREATE OR REPLACE FUNCTION public.admin_save_campaign(
  p_id uuid, p_code text, p_name text, p_description text,
  p_claim_opens_on date, p_claim_closes_on date, p_use_by_date date,
  p_total_cap integer, p_daily_cap integer, p_pack_offer_days integer,
  p_bp_1 integer, p_bp_2 integer, p_bp_3plus integer, p_active boolean DEFAULT NULL, p_new_customers_only boolean DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_admin();
  v_cap integer := app_private.setting('max_total_discount_bp');
  v_name text := btrim(COALESCE(p_name, ''));
  v_desc text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_code text := lower(btrim(COALESCE(p_code, '')));
  v_claimed integer;
  v_id uuid := p_id;
BEGIN
  IF char_length(v_name) NOT BETWEEN 3 AND 80 THEN RAISE EXCEPTION 'Give the campaign a name (3 to 80 characters)'; END IF;
  IF v_desc IS NOT NULL AND char_length(v_desc) > 400 THEN RAISE EXCEPTION 'Keep the description under 400 characters'; END IF;
  IF p_claim_opens_on IS NULL OR p_claim_closes_on IS NULL OR p_use_by_date IS NULL THEN RAISE EXCEPTION 'Set when claims open and close, and the last day to use the wash'; END IF;
  IF p_claim_closes_on < p_claim_opens_on THEN RAISE EXCEPTION 'Claims cannot close before they open'; END IF;
  IF p_use_by_date < p_claim_opens_on THEN RAISE EXCEPTION 'The last day to use the wash cannot be before claims open'; END IF;
  IF p_total_cap IS NULL OR p_total_cap < 1 OR p_total_cap > 100000 THEN RAISE EXCEPTION 'Set how many free washes there are (1 or more)'; END IF;
  IF p_daily_cap IS NOT NULL AND (p_daily_cap < 1 OR p_daily_cap > 10000) THEN RAISE EXCEPTION 'The daily limit must be 1 or more, or empty for no daily limit'; END IF;
  IF p_pack_offer_days IS NULL OR p_pack_offer_days < 1 OR p_pack_offer_days > 365 THEN RAISE EXCEPTION 'The pack offer lasts 1 to 365 days'; END IF;
  IF p_bp_1 IS NULL OR p_bp_2 IS NULL OR p_bp_3plus IS NULL OR LEAST(p_bp_1, p_bp_2, p_bp_3plus) < 0 THEN RAISE EXCEPTION 'Enter the three pack discounts'; END IF;
  IF GREATEST(p_bp_1, p_bp_2, p_bp_3plus) > v_cap THEN
    RAISE EXCEPTION 'A pack discount cannot be more than the % percent combined discount cap', trim_scale(v_cap / 100.0);
  END IF;

  IF v_id IS NULL THEN
    IF v_code !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR char_length(v_code) NOT BETWEEN 3 AND 40 THEN
      RAISE EXCEPTION 'The short name is 3 to 40 letters, numbers and dashes, for example navratri-2026';
    END IF;
    IF EXISTS (SELECT 1 FROM public.campaigns WHERE code = v_code) THEN RAISE EXCEPTION 'There is already a campaign called %', v_code; END IF;
    INSERT INTO public.campaigns (code, name, description, is_active, claim_opens_on, claim_closes_on, use_by_date, total_cap, daily_cap,
                                  pack_offer_days, pack_offer_bp_1, pack_offer_bp_2, pack_offer_bp_3plus, new_customers_only, created_by)
    VALUES (v_code, v_name, v_desc, COALESCE(p_active, false), p_claim_opens_on, p_claim_closes_on, p_use_by_date, p_total_cap, p_daily_cap,
            p_pack_offer_days, p_bp_1, p_bp_2, p_bp_3plus, COALESCE(p_new_customers_only, true), v_admin)
    RETURNING id INTO v_id;
    PERFORM app_private.audit('campaign', v_id, 'campaign_created', jsonb_build_object('code', v_code, 'total_cap', p_total_cap, 'daily_cap', p_daily_cap, 'new_customers_only', COALESCE(p_new_customers_only, true)));
  ELSE
    PERFORM 1 FROM public.campaigns WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Campaign not found'; END IF;
    SELECT count(*) INTO v_claimed FROM public.campaign_claims WHERE campaign_id = v_id AND status <> 'released';
    IF p_total_cap < v_claimed THEN RAISE EXCEPTION '% free washes are already claimed, so the total cannot go below that', v_claimed; END IF;
    UPDATE public.campaigns
       SET name = v_name, description = v_desc, claim_opens_on = p_claim_opens_on, claim_closes_on = p_claim_closes_on, use_by_date = p_use_by_date,
           total_cap = p_total_cap, daily_cap = p_daily_cap, pack_offer_days = p_pack_offer_days,
           pack_offer_bp_1 = p_bp_1, pack_offer_bp_2 = p_bp_2, pack_offer_bp_3plus = p_bp_3plus,
           is_active = COALESCE(p_active, is_active), new_customers_only = COALESCE(p_new_customers_only, new_customers_only), updated_at = now()
     WHERE id = v_id;
    PERFORM app_private.audit('campaign', v_id, 'campaign_updated', jsonb_build_object('total_cap', p_total_cap, 'daily_cap', p_daily_cap, 'new_customers_only', p_new_customers_only));
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_campaign(uuid, text, text, text, date, date, date, integer, integer, integer, integer, integer, integer, boolean, boolean) TO authenticated; -- is_admin() inside
