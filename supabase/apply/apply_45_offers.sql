-- WASHO migration 45: the offer on Home (a discount or a complimentary wash, switched on from Admin). Paste into the Supabase SQL Editor and Run, once. Independent of 46.
begin;

-- 20261004000045_home_offers.sql
-- SAFE / additive and re-runnable. THE OFFER ON THE HOME SCREEN. An admin (Super admin, Operations or Marketing: the roles that already manage Campaigns) writes a short offer in
-- Admin -> Campaigns, chooses what kind it is (a Discount, or a Complimentary wash), and switches it on. While it is on, the website shows it in a strip under the header
-- and the mobile app shows it at the top of Home, with nothing to deploy. Switching it off (or its last day passing) takes it away from both.
--
--   promo_offers                         one row per offer: kind, headline, an optional line of detail, an optional coupon code to show, an optional first and last day, on or off
--   get_live_offers()                    what the website and the app show right now (open to everyone, signed in or not): the newest few offers that are on and inside their dates.
--                                        A coupon code is only handed out while that coupon can really be used, so a banner never invites people to type a dead code
--   admin_list_offers()                  every offer, newest first, with where it stands (live, switched off, starts later, ended) and whether its code still works
--   admin_save_offer(...)                make an offer (p_id NULL) or change one
--   admin_set_offer_active(id, on/off)   the switch
--   admin_delete_offer(id)               remove an offer (it is only a notice, not a record of money; the change is written to the audit log)
-- It never changes a price. A discount's real percentage lives in Discounts (coupons and automatic discounts); a complimentary wash is the Campaign's claim flow. The offer
-- only tells people about them. Nothing existing is touched: no customer, wash, payment, coupon or campaign row changes when this is applied.

CREATE TABLE IF NOT EXISTS public.promo_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('discount', 'complimentary_wash')),
  headline text NOT NULL CHECK (char_length(headline) BETWEEN 3 AND 60),
  details text CHECK (details IS NULL OR char_length(details) <= 140),
  code text CHECK (code IS NULL OR code ~ '^[A-Z0-9]{3,20}$'),
  is_active boolean NOT NULL DEFAULT false,
  starts_on date,
  ends_on date,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promo_offers_dates_check CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT promo_offers_code_kind_check CHECK (code IS NULL OR kind = 'discount')
);
CREATE INDEX IF NOT EXISTS promo_offers_live_idx ON public.promo_offers (is_active, created_at DESC);
ALTER TABLE public.promo_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.promo_offers FROM PUBLIC, anon, authenticated;

-- Can this coupon be used today? (on, not past its last day, not used up)
CREATE OR REPLACE FUNCTION app_private.coupon_is_live(p_code text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.membership_coupons c
     WHERE c.code = p_code AND c.is_active
       AND (c.expires_on IS NULL OR c.expires_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
       AND (c.max_uses IS NULL OR (SELECT count(*) FROM public.membership_coupon_redemptions r WHERE r.coupon_id = c.id) < c.max_uses))
$$;
REVOKE ALL ON FUNCTION app_private.coupon_is_live(text) FROM PUBLIC, anon, authenticated;

-- One offer as the Admin page shows it.
CREATE OR REPLACE FUNCTION app_private.offer_json(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
           'id', o.id, 'kind', o.kind, 'headline', o.headline, 'details', o.details, 'code', o.code, 'is_active', o.is_active,
           'starts_on', o.starts_on, 'ends_on', o.ends_on, 'created_at', o.created_at, 'updated_at', o.updated_at,
           'code_works', CASE WHEN o.code IS NULL THEN NULL ELSE app_private.coupon_is_live(o.code) END,
           'status', CASE WHEN NOT o.is_active THEN 'off'
                          WHEN o.ends_on IS NOT NULL AND o.ends_on < (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'ended'
                          WHEN o.starts_on IS NOT NULL AND o.starts_on > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN 'scheduled'
                          ELSE 'live' END)
    FROM public.promo_offers o WHERE o.id = p_id
$$;
REVOKE ALL ON FUNCTION app_private.offer_json(uuid) FROM PUBLIC, anon, authenticated;

-- What everyone sees right now.
CREATE OR REPLACE FUNCTION public.get_live_offers() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', x.id, 'kind', x.kind, 'headline', x.headline, 'details', x.details,
           'code', CASE WHEN x.code IS NOT NULL AND app_private.coupon_is_live(x.code) THEN x.code END) ORDER BY x.created_at DESC), '[]'::jsonb)
    FROM (
      SELECT o.* FROM public.promo_offers o
       WHERE o.is_active
         AND (o.starts_on IS NULL OR o.starts_on <= (now() AT TIME ZONE 'Asia/Kolkata')::date)
         AND (o.ends_on IS NULL OR o.ends_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
       ORDER BY o.created_at DESC LIMIT 3
    ) x
$$;
REVOKE ALL ON FUNCTION public.get_live_offers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_live_offers() TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_list_offers() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('campaigns', 'view');
  RETURN COALESCE((SELECT jsonb_agg(app_private.offer_json(o.id) ORDER BY o.is_active DESC, o.created_at DESC) FROM public.promo_offers o), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.admin_list_offers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_offers() TO authenticated; -- the role check is inside

-- Make an offer (p_id NULL) or change one.
CREATE OR REPLACE FUNCTION public.admin_save_offer(
  p_id uuid, p_kind text, p_headline text, p_details text, p_code text, p_starts_on date, p_ends_on date, p_active boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('campaigns', 'manage');
  v_kind text := btrim(COALESCE(p_kind, ''));
  v_headline text := btrim(COALESCE(p_headline, ''));
  v_details text := NULLIF(btrim(COALESCE(p_details, '')), '');
  v_code text := NULLIF(upper(btrim(COALESCE(p_code, ''))), '');
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_active boolean := COALESCE(p_active, false);
  v_id uuid;
BEGIN
  IF v_kind NOT IN ('discount', 'complimentary_wash') THEN RAISE EXCEPTION 'Choose what kind of offer this is: a discount or a complimentary wash'; END IF;
  IF char_length(v_headline) NOT BETWEEN 3 AND 60 THEN RAISE EXCEPTION 'Write the offer in 3 to 60 characters'; END IF;
  IF v_details IS NOT NULL AND char_length(v_details) > 140 THEN RAISE EXCEPTION 'Keep the extra line to 140 characters'; END IF;
  IF v_code IS NOT NULL THEN
    IF v_kind <> 'discount' THEN RAISE EXCEPTION 'Only a discount can show a coupon code'; END IF;
    IF v_code !~ '^[A-Z0-9]{3,20}$' THEN RAISE EXCEPTION 'A coupon code is 3 to 20 letters and numbers, with no spaces'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.membership_coupons WHERE code = v_code) THEN
      RAISE EXCEPTION 'There is no coupon with the code %. Make it under Discounts first, or leave the code empty', v_code;
    END IF;
  END IF;
  IF p_starts_on IS NOT NULL AND p_ends_on IS NOT NULL AND p_ends_on < p_starts_on THEN RAISE EXCEPTION 'The last day cannot be before the first day'; END IF;
  IF v_active AND p_ends_on IS NOT NULL AND p_ends_on < v_today THEN RAISE EXCEPTION 'The last day cannot be in the past'; END IF;

  IF p_id IS NULL THEN
    INSERT INTO public.promo_offers (kind, headline, details, code, is_active, starts_on, ends_on, created_by)
    VALUES (v_kind, v_headline, v_details, v_code, v_active, p_starts_on, p_ends_on, v_me) RETURNING id INTO v_id;
    PERFORM app_private.audit('offer', v_id, 'offer_created', jsonb_build_object('kind', v_kind, 'headline', v_headline, 'switched_on', v_active));
  ELSE
    UPDATE public.promo_offers
       SET kind = v_kind, headline = v_headline, details = v_details, code = v_code, starts_on = p_starts_on, ends_on = p_ends_on, is_active = v_active, updated_at = now()
     WHERE id = p_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'That offer no longer exists'; END IF;
    PERFORM app_private.audit('offer', v_id, 'offer_changed', jsonb_build_object('kind', v_kind, 'headline', v_headline, 'switched_on', v_active));
  END IF;
  RETURN app_private.offer_json(v_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_save_offer(uuid, text, text, text, text, date, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_save_offer(uuid, text, text, text, text, date, date, boolean) TO authenticated; -- the role check is inside

CREATE OR REPLACE FUNCTION public.admin_set_offer_active(p_id uuid, p_active boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('campaigns', 'manage');
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  o public.promo_offers%ROWTYPE;
BEGIN
  IF p_active IS NULL THEN RAISE EXCEPTION 'Say whether the offer is on or off'; END IF;
  SELECT * INTO o FROM public.promo_offers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'That offer no longer exists'; END IF;
  IF p_active AND o.ends_on IS NOT NULL AND o.ends_on < v_today THEN RAISE EXCEPTION 'This offer''s last day has passed. Change the dates to switch it on again'; END IF;
  IF o.is_active IS DISTINCT FROM p_active THEN
    UPDATE public.promo_offers SET is_active = p_active, updated_at = now() WHERE id = p_id;
    PERFORM app_private.audit('offer', p_id, CASE WHEN p_active THEN 'offer_switched_on' ELSE 'offer_switched_off' END, jsonb_build_object('headline', o.headline));
  END IF;
  RETURN app_private.offer_json(p_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_offer_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_offer_active(uuid, boolean) TO authenticated; -- the role check is inside

CREATE OR REPLACE FUNCTION public.admin_delete_offer(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('campaigns', 'manage');
  o public.promo_offers%ROWTYPE;
BEGIN
  DELETE FROM public.promo_offers WHERE id = p_id RETURNING * INTO o;
  IF NOT FOUND THEN RAISE EXCEPTION 'That offer no longer exists'; END IF;
  PERFORM app_private.audit('offer', p_id, 'offer_deleted', jsonb_build_object('kind', o.kind, 'headline', o.headline));
  RETURN jsonb_build_object('id', p_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_offer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_offer(uuid) TO authenticated; -- the role check is inside

commit;
