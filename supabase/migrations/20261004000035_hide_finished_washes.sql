-- 20261004000035_hide_finished_washes.sql
-- SAFE / additive. A customer can clear a FINISHED wash (done, cancelled, refunded or missed) from their own Washes tab, and bring it back. Nothing is deleted: the wash, its photos,
-- its rating and its payment all stay, WASHO and the specialist still see everything, and the wash can still be opened from a link. Same idea as customer_hidden_plans (migration 21).
--
--   customer_hidden_washes     which washes this customer cleared (they can read only their own rows; only the functions write)
--   hide_my_wash(booking)      clear one finished wash. A wash that is still coming up, or one with a refund waiting, cannot be cleared.
--   unhide_my_wash(booking)    bring it back (the "Undo" after clearing).

CREATE TABLE IF NOT EXISTS public.customer_hidden_washes (
  customer_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_profile_id, booking_id)
);
ALTER TABLE public.customer_hidden_washes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_hidden_washes_own_read ON public.customer_hidden_washes;
CREATE POLICY customer_hidden_washes_own_read ON public.customer_hidden_washes FOR SELECT TO authenticated
  USING (customer_profile_id = public.current_profile_id());
REVOKE ALL ON public.customer_hidden_washes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_hidden_washes TO authenticated; -- RLS: their own rows only

CREATE OR REPLACE FUNCTION public.hide_my_wash(p_booking_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_status text;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  SELECT status::text INTO v_status FROM public.bookings WHERE id = p_booking_id AND customer_profile_id = v_profile;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF v_status NOT IN ('completed', 'cancelled', 'refunded', 'no_show') THEN
    RAISE EXCEPTION 'Only a wash that is finished can be cleared from your list';
  END IF;
  INSERT INTO public.customer_hidden_washes (customer_profile_id, booking_id) VALUES (v_profile, p_booking_id) ON CONFLICT DO NOTHING;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.hide_my_wash(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hide_my_wash(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.unhide_my_wash(p_booking_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_profile uuid := public.current_profile_id();
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.customer_hidden_washes WHERE customer_profile_id = v_profile AND booking_id = p_booking_id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.unhide_my_wash(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unhide_my_wash(uuid) TO authenticated;
