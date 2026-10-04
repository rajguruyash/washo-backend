-- 20261004000002_catalog_and_pricing.sql
-- SAFE / additive. Canonical WASHO prices and the explicit membership discount model.
--
--   Unit prices (paise): Bike Wash 6500, Car Body Wash 15000, Car Deep Cleaning 22000, SUV Deep Cleaning 25000
--   Frequency discount : 1/week 0%, 2/week 0%, 3/week 10%
--   Duration discount  : 1 month 0%, 3 months 5%, 6 months 10%, 12 months 15%
--   Combined discount is capped (default 15%) and the cap shows up as its own line when it bites.
--   Washes per month   : washes_per_week x 4
--
-- Discounts are DATA (membership_discount_rules / pricing_settings), never buried in function bodies.
-- Nothing is deleted. Old price rows are deactivated, not removed.

-- ───────────────────────── services: website/mobile catalogue fields ─────────────────────────
ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS wash_kind text,
  ADD COLUMN IF NOT EXISTS tagline text,
  ADD COLUMN IF NOT EXISTS duration_minutes integer,
  ADD COLUMN IF NOT EXISTS includes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;

ALTER TABLE public.services DROP CONSTRAINT IF EXISTS services_wash_kind_check;
ALTER TABLE public.services ADD CONSTRAINT services_wash_kind_check CHECK (wash_kind IS NULL OR wash_kind IN ('body', 'deep'));

UPDATE public.services
   SET wash_kind = CASE WHEN code LIKE '%deep%' THEN 'deep' WHEN code LIKE '%body%' THEN 'body' END
 WHERE wash_kind IS NULL;

-- Display copy. These are STARTING VALUES (durations and "includes" were never specified); edit freely.
UPDATE public.services s SET
  tagline = COALESCE(s.tagline, v.tagline),
  duration_minutes = COALESCE(s.duration_minutes, v.duration_minutes),
  includes = CASE WHEN s.includes = '[]'::jsonb THEN v.includes ELSE s.includes END,
  sort_order = CASE WHEN s.sort_order = 0 THEN v.sort_order ELSE s.sort_order END
FROM (VALUES
  ('bike-body-wash',    'Showroom shine, right at your parking spot', 30,  '["Pressure wash","Foam wash","Tyre & rim cleaning","Seat & tank wipe-down","Before & after photos"]'::jsonb, 1),
  ('car-body-wash',     'Scratch-free exterior, zero water waste',    45,  '["Pressure wash","Foam wash","Tyre & rim cleaning","Glass cleaning","Before & after photos"]'::jsonb, 2),
  ('car-deep-cleaning', 'Inside and out, top to bottom',              120, '["Everything in Body Wash","Interior vacuum","Dashboard & panel cleaning","Door-jamb & seat detailing","Mat deep clean","Before & after photos"]'::jsonb, 3),
  ('suv-deep-cleaning', 'Space-sized care for bigger rides',          150, '["Everything in Body Wash","Interior vacuum (all rows)","Dashboard & panel cleaning","Cargo area & roof-rail detailing","Mat deep clean","Before & after photos"]'::jsonb, 4)
) AS v(code, tagline, duration_minutes, includes, sort_order)
WHERE s.code = v.code;

-- ───────────────────────── Unit prices (pricing_rules, duration 1 / tier 1) ─────────────────────────
-- Idempotent: if an active rule already has the right amount, it is left alone; otherwise it is
-- deactivated (valid_to = now) and a NEW rule_version is inserted. Rows are never deleted.
DO $$
DECLARE
  r record;
  v_service uuid;
  v_active public.pricing_rules%ROWTYPE;
  v_next integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('bike-body-wash',    'bike'::public.vehicle_type,  6500),
      ('car-body-wash',     'car'::public.vehicle_type,  15000),
      ('car-body-wash',     'suv'::public.vehicle_type,  15000),  -- SUVs use Car Body Wash at the car price
      ('car-deep-cleaning', 'car'::public.vehicle_type,  22000),
      ('car-deep-cleaning', 'suv'::public.vehicle_type,  22000),  -- on-demand only; memberships use SUV Deep Cleaning
      ('suv-deep-cleaning', 'suv'::public.vehicle_type,  25000)
    ) AS t(code, vtype, cents)
  LOOP
    SELECT id INTO v_service FROM public.services WHERE code = r.code;
    CONTINUE WHEN v_service IS NULL;

    SELECT * INTO v_active FROM public.pricing_rules
     WHERE service_id = v_service AND vehicle_type = r.vtype AND duration_months = 1 AND quantity_tier = 1
       AND active AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
     ORDER BY rule_version DESC LIMIT 1;

    IF FOUND AND v_active.base_amount_cents = r.cents THEN CONTINUE; END IF;

    IF FOUND THEN
      UPDATE public.pricing_rules SET active = false, valid_to = now(), updated_at = now() WHERE id = v_active.id;
    END IF;

    SELECT COALESCE(max(rule_version), 0) + 1 INTO v_next FROM public.pricing_rules
     WHERE service_id = v_service AND vehicle_type = r.vtype AND duration_months = 1 AND quantity_tier = 1;

    INSERT INTO public.pricing_rules (service_id, vehicle_type, duration_months, quantity_tier, base_amount_cents, discount_percent, active, rule_version, valid_from)
    VALUES (v_service, r.vtype, 1, 1, r.cents, 0, true, v_next, now());
  END LOOP;

  -- Discounts and quantities are no longer expressed as pricing_rules rows. Deactivate (never delete) any
  -- others so single-row price lookups (including the existing edge function) stay unambiguous.
  UPDATE public.pricing_rules
     SET active = false, valid_to = COALESCE(valid_to, now()), updated_at = now()
   WHERE active AND (duration_months <> 1 OR quantity_tier <> 1);
END $$;

-- The unit price a customer pays for one wash of a service on a vehicle type.
CREATE OR REPLACE FUNCTION app_private.unit_price_cents(p_service_id uuid, p_vehicle_type public.vehicle_type)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT base_amount_cents FROM public.pricing_rules
   WHERE service_id = p_service_id AND vehicle_type = p_vehicle_type AND duration_months = 1 AND quantity_tier = 1
     AND active AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
   ORDER BY rule_version DESC LIMIT 1;
$$;

-- ───────────────────────── Which service a membership uses for each kind of wash ─────────────────────────
CREATE TABLE IF NOT EXISTS public.membership_service_options (
  vehicle_type public.vehicle_type NOT NULL,
  wash_kind text NOT NULL CHECK (wash_kind IN ('body', 'deep')),
  service_id uuid NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  PRIMARY KEY (vehicle_type, wash_kind)
);
ALTER TABLE public.membership_service_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_service_options_read ON public.membership_service_options;
CREATE POLICY membership_service_options_read ON public.membership_service_options FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS membership_service_options_admin ON public.membership_service_options;
CREATE POLICY membership_service_options_admin ON public.membership_service_options FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
REVOKE ALL ON public.membership_service_options FROM anon, authenticated;
GRANT SELECT ON public.membership_service_options TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.membership_service_options TO authenticated; -- RLS limits writes to admins

INSERT INTO public.membership_service_options (vehicle_type, wash_kind, service_id)
SELECT o.vt, o.kind, s.id
  FROM (VALUES
    ('bike'::public.vehicle_type, 'body', 'bike-body-wash'),
    ('car'::public.vehicle_type,  'body', 'car-body-wash'),
    ('car'::public.vehicle_type,  'deep', 'car-deep-cleaning'),
    ('suv'::public.vehicle_type,  'body', 'car-body-wash'),
    ('suv'::public.vehicle_type,  'deep', 'suv-deep-cleaning')
  ) AS o(vt, kind, code)
  JOIN public.services s ON s.code = o.code
ON CONFLICT DO NOTHING;

-- ───────────────────────── Explicit discount rules + settings ─────────────────────────
CREATE TABLE IF NOT EXISTS public.membership_discount_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('frequency', 'duration')),
  key_value smallint NOT NULL CHECK (key_value > 0),
  discount_bp integer NOT NULL CHECK (discount_bp BETWEEN 0 AND 10000), -- basis points: 1000 = 10%
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_membership_discount_active ON public.membership_discount_rules (kind, key_value) WHERE active;
ALTER TABLE public.membership_discount_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS membership_discount_rules_read ON public.membership_discount_rules;
CREATE POLICY membership_discount_rules_read ON public.membership_discount_rules FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS membership_discount_rules_admin ON public.membership_discount_rules;
CREATE POLICY membership_discount_rules_admin ON public.membership_discount_rules FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
REVOKE ALL ON public.membership_discount_rules FROM anon, authenticated;
GRANT SELECT ON public.membership_discount_rules TO anon, authenticated;
GRANT INSERT, UPDATE ON public.membership_discount_rules TO authenticated;

INSERT INTO public.membership_discount_rules (kind, key_value, discount_bp, label) VALUES
  ('frequency', 1, 0,    '1 wash a week'),
  ('frequency', 2, 0,    '2 washes a week'),
  ('frequency', 3, 1000, '3 washes a week'),
  ('duration',  1, 0,    '1 month'),
  ('duration',  3, 500,  '3 months'),
  ('duration',  6, 1000, '6 months'),
  ('duration',  12, 1500, '12 months')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS public.pricing_settings (
  key text PRIMARY KEY,
  value_int integer NOT NULL,
  description text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.pricing_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pricing_settings_read ON public.pricing_settings;
CREATE POLICY pricing_settings_read ON public.pricing_settings FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS pricing_settings_admin ON public.pricing_settings;
CREATE POLICY pricing_settings_admin ON public.pricing_settings FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
REVOKE ALL ON public.pricing_settings FROM anon, authenticated;
GRANT SELECT ON public.pricing_settings TO anon, authenticated;
GRANT INSERT, UPDATE ON public.pricing_settings TO authenticated;

INSERT INTO public.pricing_settings (key, value_int, description) VALUES
  ('max_total_discount_bp',     1500, 'Cap on frequency + duration discount combined, in basis points (1500 = 15%)'),
  ('weeks_per_month',              4, 'A membership month is billed as this many weeks of washes'),
  ('quote_validity_days',          7, 'How long a WASHO-approved quote can be accepted'),
  ('membership_min_lead_days',     2, 'Earliest membership start, in days from today'),
  ('on_demand_min_lead_hours',     2, 'On-demand bookings must start at least this many hours from now'),
  ('payment_intent_minutes',      30, 'How long a started payment stays valid')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION app_private.setting(p_key text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT value_int FROM public.pricing_settings WHERE key = p_key;
$$;

-- ───────────────────────── The price calculator (single source of truth) ─────────────────────────
-- p_weekly_pattern: [{"weekday": 1, "kind": "body"}, ...]  (weekday 0 = Sunday)
-- Returns the full, explicit breakdown. Every rupee of discount appears as a labelled line.
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
  IF v_freq NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'A membership has 1, 2 or 3 washes a week';
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
  ELSIF v_freq = 3 AND (v_bodies < 1 OR v_deeps < 1) THEN
    RAISE EXCEPTION '3 washes a week mixes body washes and deep cleanings';
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
REVOKE ALL ON FUNCTION app_private.unit_price_cents(uuid, public.vehicle_type) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.unit_price_cents(uuid, public.vehicle_type) TO service_role;
REVOKE ALL ON FUNCTION app_private.setting(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.setting(text) TO service_role;

-- ───────────────────────── Public catalogue (marketing site needs prices without a login) ─────────────────────────
CREATE OR REPLACE FUNCTION public.get_public_catalog() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'services', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'code', s.code, 'name', s.name, 'description', s.description, 'tagline', s.tagline,
        'vehicle_type', s.vehicle_type, 'wash_kind', s.wash_kind, 'duration_minutes', s.duration_minutes,
        'includes', s.includes,
        'unit_prices', (SELECT jsonb_agg(jsonb_build_object('vehicle_type', r.vehicle_type, 'price_cents', r.base_amount_cents) ORDER BY r.vehicle_type)
                          FROM public.pricing_rules r
                         WHERE r.service_id = s.id AND r.duration_months = 1 AND r.quantity_tier = 1 AND r.active
                           AND r.valid_from <= now() AND (r.valid_to IS NULL OR r.valid_to > now()))
      ) ORDER BY s.sort_order, s.name) FROM public.services s WHERE s.is_active), '[]'::jsonb),
    'membership_options', COALESCE((SELECT jsonb_agg(jsonb_build_object('vehicle_type', o.vehicle_type, 'wash_kind', o.wash_kind, 'service_code', s.code) ORDER BY o.vehicle_type, o.wash_kind)
                                      FROM public.membership_service_options o JOIN public.services s ON s.id = o.service_id WHERE s.is_active), '[]'::jsonb),
    'discounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'key', key_value, 'discount_bp', discount_bp, 'label', label) ORDER BY kind, key_value)
                             FROM public.membership_discount_rules WHERE active), '[]'::jsonb),
    'max_total_discount_bp', (SELECT value_int FROM public.pricing_settings WHERE key = 'max_total_discount_bp'),
    'weeks_per_month', (SELECT value_int FROM public.pricing_settings WHERE key = 'weeks_per_month')
  );
$$;
REVOKE ALL ON FUNCTION public.get_public_catalog() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_catalog() TO anon, authenticated, service_role;
