-- 20261004000010_membership_up_to_7_and_estimate.sql
-- SAFE / additive and re-runnable. Two product changes:
--
--  1. A membership can have 1 to 7 washes a week (was 1 to 3). One wash per vehicle per day still holds, so the chosen
--     weekdays are all different. Rules for the mix: bikes have one wash type; 1 a week is either kind; 2 a week is one Body +
--     one Deep; 3 or more a week mixes Body and Deep.
--     Frequency discount for 4-7 a week is set to 10%, the same as the 3-a-week rate (ASSUMPTION: it is a data row in
--     membership_discount_rules, so WASHO can change it without a deploy).
--  2. Customers can see an ESTIMATE while they build a plan: estimate_membership_price() runs the same calculator WASHO's
--     quote starts from (rate card x washes, explicit discounts, the cap). It is only an estimate: WASHO still reviews the
--     request and confirms the final price, and the price stored on the request stays hidden from the customer until then.

-- the request table only allowed 1-3 a week
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT con.conname FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid
            WHERE t.relname = 'membership_requests' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%frequency_per_week%'
  LOOP
    EXECUTE format('ALTER TABLE public.membership_requests DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE public.membership_requests ADD CONSTRAINT membership_requests_frequency_per_week_check CHECK (frequency_per_week BETWEEN 1 AND 7);
END $$;

INSERT INTO public.membership_discount_rules (kind, key_value, discount_bp, label)
SELECT 'frequency', n, 1000, n || ' washes a week' FROM generate_series(4, 7) n
 WHERE NOT EXISTS (SELECT 1 FROM public.membership_discount_rules r WHERE r.kind = 'frequency' AND r.key_value = n AND r.active);

-- the calculator (same as before, with the 1-7 range and the "3 or more mixes" rule)
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
  v_dur_bp integer;
  v_freq_cents bigint;
  v_dur_cents bigint;
  v_combined bigint;
  v_cap_cents bigint;
  v_cap_adj bigint := 0;
  v_total_discount bigint;
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

  -- Composition rules
  IF p_vehicle_type = 'bike' THEN
    IF v_deeps > 0 THEN RAISE EXCEPTION 'Bikes have one wash type'; END IF;
  ELSIF v_freq = 2 AND NOT (v_bodies = 1 AND v_deeps = 1) THEN
    RAISE EXCEPTION '2 washes a week is 1 body wash + 1 deep cleaning';
  ELSIF v_freq >= 3 AND (v_bodies < 1 OR v_deeps < 1) THEN
    RAISE EXCEPTION '% washes a week mixes body washes and deep cleanings', v_freq;
  END IF;

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

  SELECT discount_bp INTO v_freq_bp FROM public.membership_discount_rules WHERE active AND kind = 'frequency' AND key_value = v_freq;
  SELECT discount_bp INTO v_dur_bp  FROM public.membership_discount_rules WHERE active AND kind = 'duration'  AND key_value = p_duration_months;
  v_freq_bp := COALESCE(v_freq_bp, 0);
  v_dur_bp := COALESCE(v_dur_bp, 0);

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
    'frequency_discount', jsonb_build_object('bp', v_freq_bp, 'cents', v_freq_cents, 'label', (SELECT label FROM public.membership_discount_rules WHERE active AND kind='frequency' AND key_value=v_freq)),
    'duration_discount',  jsonb_build_object('bp', v_dur_bp,  'cents', v_dur_cents,  'label', (SELECT label FROM public.membership_discount_rules WHERE active AND kind='duration'  AND key_value=p_duration_months)),
    'cap', jsonb_build_object('max_bp', v_cap_bp, 'applied', v_cap_adj > 0, 'adjustment_cents', v_cap_adj),
    'total_discount_cents', v_total_discount,
    'final_cents', v_subtotal - v_total_discount,
    'rounding', 'half_up_to_paisa'
  );
END;
$$;
REVOKE ALL ON FUNCTION app_private.compute_membership_quote(public.vehicle_type, jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.compute_membership_quote(public.vehicle_type, jsonb, integer) TO service_role;

-- ───────────────────────── customer-facing estimate ─────────────────────────
-- Anyone may ask "what would this plan cost?" (the rate card is public already). Returns the full breakdown, every discount as its own
-- line. Nothing is stored and nothing is created.
CREATE OR REPLACE FUNCTION public.estimate_membership_price(p_vehicle_type public.vehicle_type, p_weekly_pattern jsonb, p_duration_months integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app_private.compute_membership_quote(p_vehicle_type, p_weekly_pattern, p_duration_months);
$$;
REVOKE ALL ON FUNCTION public.estimate_membership_price(public.vehicle_type, jsonb, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.estimate_membership_price(public.vehicle_type, jsonb, integer) TO anon, authenticated, service_role;
