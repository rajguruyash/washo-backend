-- 20261004000007_fix_worker_call_and_start.sql
-- SAFE: same signatures, strictly more correct.
--
-- Found in the production schema:
--   * worker_call_customer ALWAYS failed: it assigned a text CASE expression to an enum column
--     ("column status is of type booking_status but expression is of type text").
--   * worker_call_customer and worker_start_wash let ANY worker take over a job: if the caller was not the
--     active worker they deactivated whoever was and assigned themselves (start_wash only refused once the
--     wash was already in progress). With worker privacy tightened, that would be a way to read customer details.
--   * worker_start_wash would start a wash in any status except completed/cancelled, including an UNPAID
--     ('pending') booking.
--
-- Rule now (one place): a worker may act on a booking only if they are its active worker, or it is an
-- unclaimed CONFIRMED booking, in which case acting on it claims it (so "call customer" before "claim" still works).

CREATE OR REPLACE FUNCTION app_private.ensure_worker_assignment(p_booking_id uuid, p_worker uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status public.booking_status;
  v_existing uuid;
BEGIN
  SELECT status INTO v_status FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;

  SELECT worker_profile_id INTO v_existing FROM public.worker_assignments WHERE booking_id = p_booking_id AND is_active LIMIT 1;
  IF v_existing = p_worker THEN RETURN; END IF;
  IF v_existing IS NOT NULL THEN RAISE EXCEPTION 'This wash is already assigned to another specialist'; END IF;
  IF v_status <> 'confirmed' THEN RAISE EXCEPTION 'This wash is not available to claim (it is %)', v_status; END IF;

  INSERT INTO public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) VALUES (p_booking_id, p_worker, true, now());
  UPDATE public.bookings SET status = 'worker_assigned', updated_at = now() WHERE id = p_booking_id;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'worker_assigned', p_worker, jsonb_build_object('worker_id', p_worker));
END $$;
REVOKE ALL ON FUNCTION app_private.ensure_worker_assignment(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.worker_call_customer(p_booking_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_worker uuid := public.current_profile_id();
BEGIN
  IF NOT public.is_worker() THEN RAISE EXCEPTION 'Only authenticated workers can log customer calls'; END IF;
  PERFORM app_private.ensure_worker_assignment(p_booking_id, v_worker);

  UPDATE public.bookings
     SET status = CASE WHEN status = 'in_progress' THEN 'in_progress'::public.booking_status ELSE 'worker_called'::public.booking_status END,
         updated_at = now()
   WHERE id = p_booking_id AND status IN ('worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress');
  IF NOT FOUND THEN RAISE EXCEPTION 'This wash can no longer be updated'; END IF;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id) VALUES (p_booking_id, 'worker_called', v_worker);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.worker_start_wash(p_booking_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_status public.booking_status;
BEGIN
  IF NOT public.is_worker() THEN RAISE EXCEPTION 'Only authenticated workers may start a wash'; END IF;
  PERFORM app_private.ensure_worker_assignment(p_booking_id, v_worker);

  SELECT status INTO v_status FROM public.bookings WHERE id = p_booking_id;
  IF v_status = 'in_progress' THEN RETURN true; END IF; -- already started by this worker
  IF v_status NOT IN ('worker_assigned', 'worker_called', 'call_not_picked_up') THEN
    RAISE EXCEPTION 'This wash cannot be started (it is %)', v_status;
  END IF;

  UPDATE public.bookings SET status = 'in_progress', updated_at = now() WHERE id = p_booking_id;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id) VALUES (p_booking_id, 'wash_started', v_worker);
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION public.worker_call_customer(uuid), public.worker_start_wash(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_call_customer(uuid), public.worker_start_wash(uuid) TO authenticated;
