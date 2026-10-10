-- 20261004000034_wash_reviews.sql
-- SAFE / additive. A customer can rate every wash that has been done (1 to 5 stars) and, if they want, write a review. The rating can be sent with no review at all.
-- One rating per wash (a customer can change their rating or review later). Single washes, membership washes and free washes are all just washes, so one table covers them.
--
--   wash_reviews                 booking_id (unique), the customer, the specialist who did the wash (as it was then), rating 1-5, optional review (up to 1000 characters).
--                                Closed to everyone: only the functions below read or write it.
--   rate_wash(booking, rating, review)   the customer: only their own wash, only once it is completed. Saves or changes the rating and review. Audited.
--   my_wash_reviews(booking ids)         the customer: their own ratings for a list of washes (what the Washes tab shows).
--   admin_wash_review(booking)           one wash's review, for the admin's wash sheet (Washes area).
--   admin_list_reviews(max rating, limit)   the latest reviews with the average and a count per star, for the admin Reviews tab (Washes area).
-- Nothing the mobile app uses is changed: this is a new table and new functions.

CREATE TABLE IF NOT EXISTS public.wash_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES public.bookings(id) ON DELETE RESTRICT,
  customer_profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  worker_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  rating smallint NOT NULL,
  review text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wash_reviews_rating_check CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT wash_reviews_review_check CHECK (review IS NULL OR char_length(review) BETWEEN 1 AND 1000)
);
CREATE INDEX IF NOT EXISTS idx_wash_reviews_created ON public.wash_reviews (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wash_reviews_worker ON public.wash_reviews (worker_profile_id, created_at DESC);
ALTER TABLE public.wash_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wash_reviews FROM PUBLIC, anon, authenticated;

-- The customer rates (and optionally reviews) one of their completed washes. Calling it again changes it.
CREATE OR REPLACE FUNCTION public.rate_wash(p_booking_id uuid, p_rating integer, p_review text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_profile uuid := public.current_profile_id();
  v_b public.bookings%ROWTYPE;
  v_review text := NULLIF(btrim(COALESCE(p_review, '')), '');
  v_worker uuid;
  v_row public.wash_reviews%ROWTYPE;
  v_new boolean;
BEGIN
  IF v_profile IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_profile AND role = 'customer') THEN
    RAISE EXCEPTION 'Customer profile not found' USING ERRCODE = '42501';
  END IF;
  IF p_rating IS NULL OR p_rating < 1 OR p_rating > 5 THEN RAISE EXCEPTION 'Choose 1 to 5 stars'; END IF;
  IF v_review IS NOT NULL AND char_length(v_review) > 1000 THEN RAISE EXCEPTION 'Please keep the review under 1000 characters'; END IF;
  SELECT * INTO v_b FROM public.bookings WHERE id = p_booking_id AND customer_profile_id = v_profile;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF v_b.status <> 'completed' THEN RAISE EXCEPTION 'You can rate a wash once it has been done'; END IF;
  SELECT wa.worker_profile_id INTO v_worker FROM public.worker_assignments wa WHERE wa.booking_id = p_booking_id ORDER BY wa.is_active DESC, wa.created_at DESC LIMIT 1;
  v_new := NOT EXISTS (SELECT 1 FROM public.wash_reviews WHERE booking_id = p_booking_id);
  INSERT INTO public.wash_reviews (booking_id, customer_profile_id, worker_profile_id, rating, review)
  VALUES (p_booking_id, v_profile, v_worker, p_rating, v_review)
  ON CONFLICT (booking_id) DO UPDATE SET rating = EXCLUDED.rating, review = EXCLUDED.review, updated_at = now()
  RETURNING * INTO v_row;
  PERFORM app_private.audit('booking', p_booking_id, CASE WHEN v_new THEN 'wash_rated' ELSE 'wash_rating_changed' END,
    jsonb_build_object('rating', p_rating, 'has_review', v_review IS NOT NULL));
  RETURN jsonb_build_object('booking_id', v_row.booking_id, 'rating', v_row.rating, 'review', v_row.review, 'updated_at', v_row.updated_at);
END $$;
REVOKE ALL ON FUNCTION public.rate_wash(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rate_wash(uuid, integer, text) TO authenticated;

-- The customer's own ratings for some washes.
CREATE OR REPLACE FUNCTION public.my_wash_reviews(p_booking_ids uuid[]) RETURNS TABLE (booking_id uuid, rating smallint, review text, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT r.booking_id, r.rating, r.review, r.updated_at
    FROM public.wash_reviews r
   WHERE r.customer_profile_id = public.current_profile_id() AND r.booking_id = ANY (COALESCE(p_booking_ids, ARRAY[]::uuid[]))
$$;
REVOKE ALL ON FUNCTION public.my_wash_reviews(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_wash_reviews(uuid[]) TO authenticated;

-- One wash's review for the admin (NULL when there is none).
CREATE OR REPLACE FUNCTION public.admin_wash_review(p_booking_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('bookings', 'view');
  RETURN (SELECT jsonb_build_object('rating', r.rating, 'review', r.review, 'created_at', r.created_at, 'updated_at', r.updated_at) FROM public.wash_reviews r WHERE r.booking_id = p_booking_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_wash_review(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_wash_review(uuid) TO authenticated;

-- The latest reviews (optionally only up to a rating, for "low ratings"), with the average and how many of each star.
CREATE OR REPLACE FUNCTION public.admin_list_reviews(p_max_rating integer DEFAULT NULL, p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('bookings', 'view');
  RETURN jsonb_build_object(
    'summary', (SELECT jsonb_build_object(
                  'count', count(*)::integer,
                  'average', COALESCE(round(avg(rating)::numeric, 2), 0),
                  'stars', jsonb_build_object('1', count(*) FILTER (WHERE rating = 1), '2', count(*) FILTER (WHERE rating = 2), '3', count(*) FILTER (WHERE rating = 3),
                                              '4', count(*) FILTER (WHERE rating = 4), '5', count(*) FILTER (WHERE rating = 5)),
                  'with_text', count(*) FILTER (WHERE review IS NOT NULL)::integer)
                FROM public.wash_reviews),
    'reviews', COALESCE((
      SELECT jsonb_agg(x ORDER BY (x ->> 'updated_at') DESC) FROM (
        SELECT jsonb_build_object(
                 'id', r.id, 'booking_id', r.booking_id, 'rating', r.rating, 'review', r.review, 'created_at', r.created_at, 'updated_at', r.updated_at,
                 'customer_name', c.full_name, 'worker_name', w.full_name, 'service_name', s.name, 'scheduled_date', b.scheduled_date, 'booking_type', b.booking_type::text,
                 'vehicle_model', v.model, 'registration_number', v.registration_number) AS x
          FROM public.wash_reviews r
          JOIN public.bookings b ON b.id = r.booking_id
          JOIN public.services s ON s.id = b.service_id
          JOIN public.vehicles v ON v.id = b.vehicle_id
          JOIN public.profiles c ON c.id = r.customer_profile_id
          LEFT JOIN public.profiles w ON w.id = r.worker_profile_id
         WHERE (p_max_rating IS NULL OR r.rating <= p_max_rating)
         ORDER BY r.updated_at DESC
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 300)) q), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.admin_list_reviews(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_reviews(integer, integer) TO authenticated;
