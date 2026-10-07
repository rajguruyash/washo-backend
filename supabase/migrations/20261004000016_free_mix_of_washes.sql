-- 20261004000016_free_mix_of_washes.sql
-- SAFE and re-runnable. A membership is now ANY mix of Body washes and Deep cleans, 1 to 7 a week in total.
--
-- Before: 2 a week had to be exactly 1 Body + 1 Deep, and 3 or more a week had to include at least one of each. The membership page now lets the
-- customer say how many Body washes and how many Deep cleans they want each week (for example 2 Body and 0 Deep, or 1 Body and 3 Deep), and then which
-- days each goes on. So those two rules are gone. What stays: 1 to 7 washes a week in total, a different weekday for each wash (one wash per vehicle
-- per day), bikes have only the Body wash, and the price calculation, discounts, cap and the welcome offer are exactly as they were.
--
-- This is migration 14's compute_membership_quote() with only the composition block replaced.

CREATE OR REPLACE FUNCTION app_private.compute_membership_quote(p_vehicle_type public.vehicle_type, p_weekly_pattern jsonb, p_duration_months integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_freq integer;
  v_weeks integer := app_private.setting('weeks_per_month');
  v_cap_bp integer := app_private.setting('max_total_discount_bp');
  v_bodies integer;
  v_deeps integer;
  v_lines jsonb := '[]'::jsonb;
  v_subtotal bigint := 0;
  v_freq_bp integer;
  v_freq_label text;
  v_dur_bp integer;
  v_freq_cents bigint;
  v_dur_cents bigint;
  v_combined bigint;
  v_cap_cents bigint;
  v_cap_adj bigint := 0;
  v_total_discount bigint;
  v_offer jsonb;
  rec record;
BEGIN
  IF p_weekly_pattern IS NULL OR jsonb_typeof(p_weekly_pattern) <> 'array' THEN
    RAISE EXCEPTION 'Choose your washes for the week';
  END IF;
  v_freq := jsonb_array_length(p_weekly_pattern);
  IF v_freq NOT BETWEEN 1 AND 7 THEN
    RAISE EXCEPTION 'A membership has 1 to 7 washes a week';
  END IF;

  IF (SELECT count(DISTINCT (e->>'weekday')) FROM jsonb_array_elements(p_weekly_pattern) e) <> v_freq THEN
    RAISE EXCEPTION 'Choose a different day for each wash';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_weekly_pattern) e
              WHERE (e->>'weekday') IS NULL OR (e->>'weekday') !~ '^[0-6]$' OR (e->>'kind') NOT IN ('body', 'deep') OR (e->>'kind') IS NULL) THEN
    RAISE EXCEPTION 'Each wash needs a weekday (0-6) and a kind (body or deep)';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.membership_discount_rules WHERE active AND kind = 'duration' AND key_value = p_duration_months) THEN
    RAISE EXCEPTION 'Membership length must be 1, 3, 6 or 12 months';
  END IF;

  SELECT count(*) FILTER (WHERE e->>'kind' = 'body'), count(*) FILTER (WHERE e->>'kind' = 'deep')
    INTO v_bodies, v_deeps FROM jsonb_array_elements(p_weekly_pattern) e;

  -- Composition: any mix of Body washes and Deep cleans, 1 to 7 a week in total (on different days). Bikes have only the one wash type.
  IF p_vehicle_type = 'bike' AND v_deeps > 0 THEN RAISE EXCEPTION 'Bikes have one wash type'; END IF;

  -- Lines: one per service
  FOR rec IN
    SELECT o.service_id, s.code, s.name, k.kind, k.n AS per_week
      FROM (SELECT e->>'kind' AS kind, count(*)::int AS n FROM jsonb_array_elements(p_weekly_pattern) e GROUP BY 1) k
      LEFT JOIN public.membership_service_options o ON o.vehicle_type = p_vehicle_type AND o.wash_kind = k.kind
      LEFT JOIN public.services s ON s.id = o.service_id
     ORDER BY k.kind
  LOOP
    IF rec.service_id IS NULL THEN
      RAISE EXCEPTION 'No % wash is offered for this vehicle', rec.kind;
    END IF;
    DECLARE
      v_unit integer := app_private.unit_price_cents(rec.service_id, p_vehicle_type);
      v_qty integer := rec.per_week * v_weeks * p_duration_months;
    BEGIN
      IF v_unit IS NULL THEN RAISE EXCEPTION 'No price is set for % on this vehicle', rec.name; END IF;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'service_id', rec.service_id, 'code', rec.code, 'name', rec.name, 'kind', rec.kind,
        'per_week', rec.per_week, 'quantity', v_qty, 'unit_cents', v_unit, 'line_cents', v_unit::bigint * v_qty));
      v_subtotal := v_subtotal + v_unit::bigint * v_qty;
    END;
  END LOOP;

  SELECT discount_bp, label INTO v_freq_bp, v_freq_label FROM public.membership_discount_rules WHERE active AND kind = 'frequency' AND key_value = v_freq;
  SELECT discount_bp INTO v_dur_bp  FROM public.membership_discount_rules WHERE active AND kind = 'duration'  AND key_value = p_duration_months;
  v_freq_bp := COALESCE(v_freq_bp, 0);
  v_dur_bp := COALESCE(v_dur_bp, 0);

  -- The welcome offer for a customer whose free-wash campaign wash is done (their own rate for this many washes a week).
  SELECT jsonb_build_object('claim_id', cl.id, 'campaign_id', k.id, 'name', k.name, 'bp', r.bp)
    INTO v_offer
    FROM public.campaign_claims cl
    JOIN public.campaigns k ON k.id = cl.campaign_id
    CROSS JOIN LATERAL (SELECT CASE WHEN v_freq = 1 THEN k.pack_offer_bp_1 WHEN v_freq = 2 THEN k.pack_offer_bp_2 ELSE k.pack_offer_bp_3plus END AS bp) r
   WHERE cl.customer_profile_id = public.current_profile_id()
     AND cl.status = 'completed' AND cl.offer_membership_id IS NULL AND cl.offer_expires_at > now()
   ORDER BY r.bp DESC LIMIT 1;
  IF v_offer IS NOT NULL AND (v_offer->>'bp')::int > v_freq_bp THEN
    v_freq_bp := (v_offer->>'bp')::int;
    v_freq_label := 'Welcome offer · ' || v_freq || CASE WHEN v_freq = 1 THEN ' wash per week' ELSE ' washes per week' END;
  ELSE
    v_offer := NULL;
  END IF;

  -- Sequential: frequency off the subtotal, then duration off what remains. Half-up rounding to the paisa.
  v_freq_cents := round(v_subtotal::numeric * v_freq_bp / 10000);
  v_dur_cents  := round((v_subtotal - v_freq_cents)::numeric * v_dur_bp / 10000);
  v_combined   := v_freq_cents + v_dur_cents;
  v_cap_cents  := round(v_subtotal::numeric * v_cap_bp / 10000);

  IF v_combined > v_cap_cents THEN
    v_cap_adj := v_combined - v_cap_cents;   -- the part of the discount the cap takes back
    v_total_discount := v_cap_cents;
  ELSE
    v_total_discount := v_combined;
  END IF;

  RETURN jsonb_build_object(
    'vehicle_type', p_vehicle_type,
    'frequency_per_week', v_freq,
    'duration_months', p_duration_months,
    'weeks_per_month', v_weeks,
    'washes_total', v_freq * v_weeks * p_duration_months,
    'lines', v_lines,
    'subtotal_cents', v_subtotal,
    'frequency_discount', jsonb_build_object('bp', v_freq_bp, 'cents', v_freq_cents, 'label', v_freq_label),
    'duration_discount',  jsonb_build_object('bp', v_dur_bp,  'cents', v_dur_cents,  'label', (SELECT label FROM public.membership_discount_rules WHERE active AND kind='duration'  AND key_value=p_duration_months)),
    'cap', jsonb_build_object('max_bp', v_cap_bp, 'applied', v_cap_adj > 0, 'adjustment_cents', v_cap_adj),
    'total_discount_cents', v_total_discount,
    'final_cents', v_subtotal - v_total_discount,
    'rounding', 'half_up_to_paisa'
  ) || CASE WHEN v_offer IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('campaign_offer', v_offer) END;
END;
$$;
REVOKE ALL ON FUNCTION app_private.compute_membership_quote(public.vehicle_type, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.compute_membership_quote(public.vehicle_type, jsonb, integer) TO service_role;
