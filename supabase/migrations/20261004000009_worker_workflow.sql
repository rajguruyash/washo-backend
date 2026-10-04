-- 20261004000009_worker_workflow.sql
-- SAFE / additive. The membership-wash workflow for specialists (workers), built on the EXISTING tables:
-- bookings, worker_assignments, booking_events, booking_photos. No new worker system.
--
--   membership paid -> washes generated -> assigned (admin, or the worker claims from the pool)
--   -> worker queue -> CALL customer -> confirmed | not picked up (stays scheduled)
--   -> START -> before photos -> after photos -> COMPLETE -> next wash is already in the queue
--
-- Rules enforced here for every client (website and mobile):
--   * a worker can act on a wash only if they hold it (or it is an unclaimed, paid and confirmed wash)
--   * a worker sees customer name/phone/address/vehicle ONLY for washes they currently hold; nothing else
--   * "not picked up" never completes or charges anything and the wash stays scheduled
--   * completing needs a before AND an after photo (worker_complete_wash)
--   * every step is a booking_events row, so WASHO can see exactly what happened
--
-- worker_pool() used to live in the cutover set; it is additive and safe, so it ships here.

-- ───────────────────────── the pool (unclaimed upcoming washes, no customer details) ─────────────────────────
CREATE OR REPLACE FUNCTION public.worker_pool(p_days integer DEFAULT 14)
RETURNS TABLE (
  booking_id uuid, scheduled_date date, time_slot public.time_slot, booking_type public.booking_type,
  service_name text, vehicle_type public.vehicle_type, society_name text, area_locality text, city text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_worker() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only workers can view the pool' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT b.id, b.scheduled_date, b.time_slot, b.booking_type, s.name, v.vehicle_type,
         COALESCE(a.society_name, va.society_name), COALESCE(a.area_locality, va.area_locality), COALESCE(a.city, va.city)
    FROM public.bookings b
    JOIN public.services s ON s.id = b.service_id
    JOIN public.vehicles v ON v.id = b.vehicle_id
    LEFT JOIN public.customer_addresses a ON a.id = b.address_id
    LEFT JOIN public.customer_addresses va ON va.id = v.address_id
   WHERE b.status = 'confirmed'
     AND b.scheduled_date BETWEEN (now() AT TIME ZONE 'Asia/Kolkata')::date AND (now() AT TIME ZONE 'Asia/Kolkata')::date + GREATEST(p_days, 1)
     AND NOT EXISTS (SELECT 1 FROM public.worker_assignments wa WHERE wa.booking_id = b.id AND wa.is_active)
   ORDER BY b.scheduled_date, b.time_slot;
END $$;
REVOKE ALL ON FUNCTION public.worker_pool(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_pool(integer) TO authenticated;

-- ───────────────────────── claim: only a paid, confirmed, unclaimed wash ─────────────────────────
-- (the original accepted any status except completed/cancelled, including unpaid 'pending' bookings)
CREATE OR REPLACE FUNCTION public.worker_claim_booking(p_booking_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_worker() THEN RAISE EXCEPTION 'Only authenticated workers may claim a booking'; END IF;
  PERFORM app_private.ensure_worker_assignment(p_booking_id, public.current_profile_id());
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.worker_claim_booking(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_claim_booking(uuid) TO authenticated;

-- ───────────────────────── the worker's queue ─────────────────────────
-- One call returns everything the worker dashboard needs. `bucket` says which tab a row belongs to:
--   today        washes due today (or overdue) that the worker holds and has not started
--   in_progress  started, not finished
--   upcoming     the next p_days days
--   completed    finished in the last 30 days
--   changed      cancelled, or moved/released away from this worker in the last 14 days (no customer details)
-- `change` (jsonb) is set when the wash was rescheduled / cancelled / released recently, so the queue can say
-- "moved from Mon 6 Oct, morning".
CREATE OR REPLACE FUNCTION public.worker_queue(p_days integer DEFAULT 7)
RETURNS TABLE (
  booking_id uuid, reference_code text, status text, bucket text, is_overdue boolean,
  booking_type text, scheduled_date date, time_slot text,
  service_name text, wash_kind text,
  vehicle_type text, vehicle_make text, vehicle_model text, registration_number text, vehicle_color text,
  customer_name text, customer_phone text,
  address_label text, society_name text, building_block text, flat_number text, area_locality text, city text,
  parking_location text, instructions text, target_completion_time text,
  membership_id uuid, membership_reference text, membership_label text, wash_number integer, washes_total integer,
  customer_confirmed_at timestamptz, calls_made integer, last_call_at timestamptz,
  photos_before integer, photos_after integer, started_at timestamptz, completed_at timestamptz,
  change jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_days integer := LEAST(GREATEST(COALESCE(p_days, 7), 1), 60);
BEGIN
  IF NOT public.is_worker() THEN RAISE EXCEPTION 'Only workers can view the worker queue' USING ERRCODE = '42501'; END IF;

  RETURN QUERY
  WITH mine AS (
    SELECT b.id, true AS holds FROM public.bookings b
      JOIN public.worker_assignments wa ON wa.booking_id = b.id AND wa.worker_profile_id = v_worker AND wa.is_active
  ), released AS (
    SELECT DISTINCT b.id, false AS holds FROM public.bookings b
      JOIN public.worker_assignments wa ON wa.booking_id = b.id AND wa.worker_profile_id = v_worker
       AND NOT wa.is_active AND wa.unassigned_at > now() - interval '14 days'
     WHERE b.status NOT IN ('completed')
       AND NOT EXISTS (SELECT 1 FROM public.worker_assignments x WHERE x.booking_id = b.id AND x.worker_profile_id = v_worker AND x.is_active)
  ), picked AS (
    SELECT * FROM mine UNION ALL SELECT * FROM released
  ), seq AS (   -- "wash 7 of 24" within a membership
    SELECT x.id, row_number() OVER (PARTITION BY x.membership_id ORDER BY x.scheduled_date, x.created_at)::int AS n,
           count(*) OVER (PARTITION BY x.membership_id)::int AS total
      FROM public.bookings x
     WHERE x.membership_id IN (SELECT b.membership_id FROM public.bookings b JOIN picked p ON p.id = b.id WHERE b.membership_id IS NOT NULL)
       AND x.status <> 'cancelled'
  ), base AS (
    SELECT b.*, p.holds,
           CASE
             WHEN NOT p.holds THEN 'changed'
             WHEN b.status = 'completed' THEN 'completed'
             WHEN b.status IN ('cancelled', 'refund_requested', 'refunded', 'no_show') THEN 'changed'
             WHEN b.status = 'in_progress' THEN 'in_progress'
             WHEN b.scheduled_date <= v_today THEN 'today'
             ELSE 'upcoming'
           END AS bk
      FROM public.bookings b JOIN picked p ON p.id = b.id
  )
  SELECT b.id, b.reference_code, b.status::text, b.bk, (b.bk = 'today' AND b.scheduled_date < v_today),
         b.booking_type::text, b.scheduled_date, b.time_slot::text,
         s.name, s.wash_kind,
         v.vehicle_type::text,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.make END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.model END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.registration_number END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE v.color END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE cp.full_name END,
         CASE WHEN b.bk IN ('today', 'upcoming', 'in_progress') THEN cp.phone END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.label END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.society_name END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.building_block END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.flat_number END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.area_locality END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE a.city END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE COALESCE(b.parking_location, v.parking_location, a.parking_location) END,
         CASE WHEN b.bk = 'changed' THEN NULL ELSE mr.customer_notes END,
         b.target_completion_time,
         b.membership_id, mr.reference_code,
         CASE WHEN b.membership_id IS NULL THEN NULL
              ELSE COALESCE(mr.frequency_per_week::text || ' wash' || CASE WHEN mr.frequency_per_week > 1 THEN 'es' ELSE '' END || ' a week · ' || mr.duration_months::text || ' month' || CASE WHEN mr.duration_months > 1 THEN 's' ELSE '' END,
                            'Membership') END,
         sq.n, sq.total,
         b.customer_confirmed_at,
         (SELECT count(*)::int FROM public.booking_events e WHERE e.booking_id = b.id AND e.event_type = 'worker_called' AND e.actor_profile_id = v_worker),
         (SELECT max(e.created_at) FROM public.booking_events e WHERE e.booking_id = b.id AND e.event_type = 'worker_called' AND e.actor_profile_id = v_worker),
         (SELECT count(*)::int FROM public.booking_photos ph WHERE ph.booking_id = b.id AND ph.phase = 'before'),
         (SELECT count(*)::int FROM public.booking_photos ph WHERE ph.booking_id = b.id AND ph.phase = 'after'),
         (SELECT max(e.created_at) FROM public.booking_events e WHERE e.booking_id = b.id AND e.event_type = 'wash_started'),
         b.completed_at,
         (SELECT CASE
                   WHEN ch.event_type = 'rescheduled' THEN jsonb_build_object('kind', 'rescheduled', 'at', ch.created_at,
                          'from_date', ch.event_metadata->>'old_date', 'from_slot', ch.event_metadata->>'old_slot', 'by', ch.event_metadata->>'by')
                   WHEN ch.event_type IN ('cancelled', 'booking_cancelled') THEN jsonb_build_object('kind', 'cancelled', 'at', ch.created_at,
                          'reason', ch.event_metadata->>'reason')
                   ELSE jsonb_build_object('kind', 'reassigned', 'at', ch.created_at)
                 END
            FROM (SELECT e.* FROM public.booking_events e
                   WHERE e.booking_id = b.id AND e.created_at > now() - interval '14 days'
                     AND (e.event_type IN ('rescheduled', 'cancelled', 'booking_cancelled')
                          OR (NOT b.holds AND e.event_type IN ('worker_assigned', 'membership_worker_assigned')))
                   -- newest first; if several events share a timestamp, a move or cancellation wins over a reassignment
                   -- (the original schema's sync trigger also logs a bare 'rescheduled' event; prefer ours, which carries old/new date and who moved it)
                   ORDER BY e.created_at DESC, (e.event_type IN ('rescheduled', 'cancelled', 'booking_cancelled')) DESC, (e.event_metadata ? 'old_date') DESC LIMIT 1) ch)
    FROM base b
    JOIN public.services s ON s.id = b.service_id
    JOIN public.vehicles v ON v.id = b.vehicle_id
    JOIN public.profiles cp ON cp.id = b.customer_profile_id
    LEFT JOIN public.customer_addresses a ON a.id = COALESCE(b.address_id, v.address_id,
         (SELECT d.id FROM public.customer_addresses d WHERE d.customer_profile_id = b.customer_profile_id AND d.is_default LIMIT 1))
    LEFT JOIN public.memberships m ON m.id = b.membership_id
    LEFT JOIN public.membership_requests mr ON mr.id = m.membership_request_id
    LEFT JOIN seq sq ON sq.id = b.id
   WHERE CASE b.bk
           WHEN 'upcoming'  THEN b.scheduled_date <= v_today + v_days
           WHEN 'completed' THEN b.completed_at > now() - interval '30 days'
           WHEN 'changed'   THEN b.updated_at > now() - interval '30 days'
           ELSE true
         END
   ORDER BY b.scheduled_date, b.time_slot, b.created_at;
END $$;
REVOKE ALL ON FUNCTION public.worker_queue(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_queue(integer) TO authenticated;

-- ───────────────────────── step: customer confirmed ─────────────────────────
CREATE OR REPLACE FUNCTION public.worker_confirm_customer(p_booking_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_status public.booking_status;
BEGIN
  IF NOT public.is_worker() THEN RAISE EXCEPTION 'Only authenticated workers can confirm with a customer'; END IF;
  PERFORM app_private.ensure_worker_assignment(p_booking_id, v_worker);

  SELECT status INTO v_status FROM public.bookings WHERE id = p_booking_id;
  IF v_status NOT IN ('worker_assigned', 'worker_called', 'call_not_picked_up') THEN
    RAISE EXCEPTION 'This wash cannot be confirmed now (it is %)', v_status;
  END IF;

  UPDATE public.bookings SET status = 'worker_called', customer_confirmed_at = now(), updated_at = now() WHERE id = p_booking_id;
  UPDATE public.membership_schedule_occurrences o SET status = 'scheduled', updated_at = now()
    FROM public.bookings b WHERE b.id = p_booking_id AND o.id = b.membership_schedule_occurrence_id AND o.status = 'call_not_picked_up';
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id) VALUES (p_booking_id, 'customer_confirmed', v_worker);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.worker_confirm_customer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_confirm_customer(uuid) TO authenticated;

-- ───────────────────────── step: call not picked up ─────────────────────────
-- The wash stays SCHEDULED. Nothing is completed, consumed, charged or refunded; the worker simply tries again
-- (worker_call_customer works from this status) or WASHO moves the wash.
CREATE OR REPLACE FUNCTION public.worker_customer_unavailable(p_booking_id uuid, p_notes text DEFAULT 'Customer did not pick up / unavailable')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_status public.booking_status;
  v_note text := COALESCE(NULLIF(trim(p_notes), ''), 'Customer did not pick up / unavailable');
BEGIN
  IF NOT public.is_worker() OR NOT public.is_current_worker_assignment(p_booking_id) THEN
    RAISE EXCEPTION 'Not authorized for this wash assignment';
  END IF;
  SELECT status INTO v_status FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF v_status = 'in_progress' THEN RAISE EXCEPTION 'The wash has already started. Report the problem as an issue instead.'; END IF;
  IF v_status NOT IN ('worker_assigned', 'worker_called', 'call_not_picked_up') THEN
    RAISE EXCEPTION 'This wash cannot be updated now (it is %)', v_status;
  END IF;

  UPDATE public.bookings
     SET status = 'call_not_picked_up', customer_confirmed_at = NULL, updated_at = now(),
         notes = COALESCE(notes || E'\n', '') || 'Worker report: ' || v_note
   WHERE id = p_booking_id;
  UPDATE public.membership_schedule_occurrences o SET status = 'call_not_picked_up', updated_at = now()
    FROM public.bookings b WHERE b.id = p_booking_id AND o.id = b.membership_schedule_occurrence_id;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'call_not_picked_up', v_worker, jsonb_build_object('notes', v_note, 'wash_completed', false, 'charged', false));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.worker_customer_unavailable(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_customer_unavailable(uuid, text) TO authenticated;

-- ───────────────────────── notes and issues ─────────────────────────
CREATE OR REPLACE FUNCTION public.worker_add_note(p_booking_id uuid, p_note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_note text := trim(COALESCE(p_note, ''));
BEGIN
  IF NOT public.is_worker() OR NOT public.is_current_worker_assignment(p_booking_id) THEN
    RAISE EXCEPTION 'Not authorized for this wash assignment';
  END IF;
  IF char_length(v_note) < 2 THEN RAISE EXCEPTION 'Write a short note first'; END IF;
  IF char_length(v_note) > 1000 THEN RAISE EXCEPTION 'Please keep the note under 1000 characters'; END IF;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'worker_note', v_worker, jsonb_build_object('note', v_note));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.worker_add_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_add_note(uuid, text) TO authenticated;

-- kinds: customer_unavailable | vehicle_not_accessible | no_water_or_power | damage_noticed | safety_concern | other
CREATE OR REPLACE FUNCTION public.worker_report_issue(p_booking_id uuid, p_kind text, p_notes text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_status public.booking_status;
  v_notes text := NULLIF(trim(COALESCE(p_notes, '')), '');
BEGIN
  IF NOT public.is_worker() OR NOT public.is_current_worker_assignment(p_booking_id) THEN
    RAISE EXCEPTION 'Not authorized for this wash assignment';
  END IF;
  IF p_kind NOT IN ('customer_unavailable', 'vehicle_not_accessible', 'no_water_or_power', 'damage_noticed', 'safety_concern', 'other') THEN
    RAISE EXCEPTION 'Unknown issue type';
  END IF;
  IF p_kind <> 'customer_unavailable' AND (v_notes IS NULL OR char_length(v_notes) < 3) THEN
    RAISE EXCEPTION 'Please describe the problem';
  END IF;
  IF v_notes IS NOT NULL AND char_length(v_notes) > 1000 THEN RAISE EXCEPTION 'Please keep the note under 1000 characters'; END IF;

  SELECT status INTO v_status FROM public.bookings WHERE id = p_booking_id;
  IF v_status IN ('cancelled', 'refunded', 'refund_requested') THEN RAISE EXCEPTION 'This wash is %', v_status; END IF;

  -- Customer unavailable before the wash starts is the "not picked up" step: same rules, same status.
  IF p_kind = 'customer_unavailable' AND v_status IN ('worker_assigned', 'worker_called', 'call_not_picked_up') THEN
    RETURN public.worker_customer_unavailable(p_booking_id, COALESCE(v_notes, 'Customer unavailable'));
  END IF;

  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'worker_issue', v_worker, jsonb_build_object('kind', p_kind, 'notes', v_notes, 'status_at_report', v_status));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.worker_report_issue(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.worker_report_issue(uuid, text, text) TO authenticated;

-- ───────────────────────── photos ─────────────────────────
-- Tightened: only while the wash is live (not once completed / cancelled), only into that booking's folder.
CREATE OR REPLACE FUNCTION public.save_booking_photo(p_booking_id uuid, p_phase text, p_photo_type text, p_storage_path text, p_metadata jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_worker uuid := public.current_profile_id();
  v_status public.booking_status;
  v_photo uuid;
BEGIN
  IF NOT public.is_current_worker_assignment(p_booking_id) THEN
    RAISE EXCEPTION 'Not authorized to save photos for this booking';
  END IF;
  SELECT status INTO v_status FROM public.bookings WHERE id = p_booking_id;
  IF v_status NOT IN ('worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress') THEN
    RAISE EXCEPTION 'Photos can only be added while the wash is open (it is %)', v_status;
  END IF;
  IF p_storage_path IS NULL OR left(p_storage_path, length(p_booking_id::text) + 1) <> p_booking_id::text || '/' OR p_storage_path ~ '\.\.' THEN
    RAISE EXCEPTION 'Photo path must be inside this booking''s folder';
  END IF;
  INSERT INTO public.booking_photos (booking_id, worker_profile_id, phase, photo_type, storage_path, metadata)
  VALUES (p_booking_id, v_worker, p_phase, p_photo_type, p_storage_path, COALESCE(p_metadata, '{}'::jsonb))
  RETURNING id INTO v_photo;
  RETURN v_photo;
END $$;
REVOKE ALL ON FUNCTION public.save_booking_photo(uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_booking_photo(uuid, text, text, text, jsonb) TO authenticated;

-- Who may see a wash's photos: its customer, the worker holding it, and admins. (One rule for the website's signed
-- URLs and for anything else that asks.)
CREATE OR REPLACE FUNCTION public.booking_photos_for_viewer(p_booking_id uuid)
RETURNS TABLE (id uuid, phase text, photo_type text, storage_path text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_current_customer_booking(p_booking_id) OR public.is_current_worker_assignment(p_booking_id)) THEN
    RAISE EXCEPTION 'Not found' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT p.id, p.phase, p.photo_type, p.storage_path, p.created_at
                 FROM public.booking_photos p WHERE p.booking_id = p_booking_id ORDER BY p.created_at;
END $$;
REVOKE ALL ON FUNCTION public.booking_photos_for_viewer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.booking_photos_for_viewer(uuid) TO authenticated;

-- ───────────────────────── admin: assignment and rescheduling ─────────────────────────
CREATE OR REPLACE FUNCTION public.admin_assign_worker(p_booking_id uuid, p_worker_profile_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := public.current_profile_id();
  v_status public.booking_status;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_worker_profile_id AND role = 'worker') THEN RAISE EXCEPTION 'Specialist not found'; END IF;
  SELECT status INTO v_status FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF v_status NOT IN ('confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up') THEN
    RAISE EXCEPTION 'A wash that is % cannot be assigned', v_status;
  END IF;

  IF EXISTS (SELECT 1 FROM public.worker_assignments WHERE booking_id = p_booking_id AND is_active AND worker_profile_id = p_worker_profile_id) THEN
    RETURN true;
  END IF;
  UPDATE public.worker_assignments SET is_active = false, unassigned_at = now() WHERE booking_id = p_booking_id AND is_active;
  INSERT INTO public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) VALUES (p_booking_id, p_worker_profile_id, true, now());
  UPDATE public.bookings SET status = 'worker_assigned', customer_confirmed_at = NULL, updated_at = now() WHERE id = p_booking_id;
  INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
  VALUES (p_booking_id, 'worker_assigned', v_admin, jsonb_build_object('worker_id', p_worker_profile_id, 'by', 'admin'));
  RETURN true;
END $$;

-- Assigns a worker to every remaining wash of a membership (from p_from on) and makes them its regular
-- specialist, so washes that are moved later return to the same worker. NULL worker = release them to the pool.
CREATE OR REPLACE FUNCTION public.admin_assign_membership_worker(p_membership_id uuid, p_worker_profile_id uuid, p_from date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := public.current_profile_id();
  v_from date := COALESCE(p_from, (now() AT TIME ZONE 'Asia/Kolkata')::date);
  b record;
  n integer := 0;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memberships WHERE id = p_membership_id) THEN RAISE EXCEPTION 'Membership not found'; END IF;
  IF p_worker_profile_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_worker_profile_id AND role = 'worker') THEN
    RAISE EXCEPTION 'Specialist not found';
  END IF;

  UPDATE public.memberships SET assigned_worker_profile_id = p_worker_profile_id, updated_at = now() WHERE id = p_membership_id;

  FOR b IN
    SELECT id, status FROM public.bookings
     WHERE membership_id = p_membership_id AND scheduled_date >= v_from
       AND status IN ('confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up')
     ORDER BY scheduled_date
     FOR UPDATE
  LOOP
    CONTINUE WHEN p_worker_profile_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.worker_assignments WHERE booking_id = b.id AND is_active AND worker_profile_id = p_worker_profile_id);
    UPDATE public.worker_assignments SET is_active = false, unassigned_at = now() WHERE booking_id = b.id AND is_active;
    IF p_worker_profile_id IS NOT NULL THEN
      INSERT INTO public.worker_assignments (booking_id, worker_profile_id, is_active, assigned_at) VALUES (b.id, p_worker_profile_id, true, now());
    END IF;
    UPDATE public.bookings SET status = CASE WHEN p_worker_profile_id IS NULL THEN 'confirmed'::public.booking_status ELSE 'worker_assigned'::public.booking_status END,
                               customer_confirmed_at = NULL, updated_at = now() WHERE id = b.id;
    INSERT INTO public.booking_events (booking_id, event_type, actor_profile_id, event_metadata)
    VALUES (b.id, 'membership_worker_assigned', v_admin, jsonb_build_object('worker_id', p_worker_profile_id, 'membership_id', p_membership_id));
    n := n + 1;
  END LOOP;

  PERFORM app_private.audit('membership', p_membership_id, 'membership_worker_assigned',
    jsonb_build_object('worker_id', p_worker_profile_id, 'washes_updated', n, 'from', v_from));
  RETURN jsonb_build_object('membership_id', p_membership_id, 'worker_profile_id', p_worker_profile_id, 'washes_updated', n);
END $$;

-- Admin moves a membership wash (customer called WASHO, bad weather, ...). Same rules as the customer's own
-- reschedule except the customer's 2-day notice, and the reason is recorded.
CREATE OR REPLACE FUNCTION public.admin_reschedule_wash(p_booking_id uuid, p_new_date date, p_new_slot public.time_slot, p_reason text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_occ uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  SELECT membership_schedule_occurrence_id INTO v_occ FROM public.bookings WHERE id = p_booking_id;
  IF v_occ IS NULL THEN RAISE EXCEPTION 'Only membership washes can be moved here'; END IF;
  RETURN app_private.reschedule_wash(v_occ, p_new_date, p_new_slot, public.current_profile_id(), NULL, (now() AT TIME ZONE 'Asia/Kolkata')::date, p_reason);
END $$;

REVOKE ALL ON FUNCTION public.admin_assign_worker(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_assign_membership_worker(uuid, uuid, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_reschedule_wash(uuid, date, public.time_slot, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_worker(uuid, uuid) TO authenticated;                          -- is_admin() inside
GRANT EXECUTE ON FUNCTION public.admin_assign_membership_worker(uuid, uuid, date) TO authenticated;         -- is_admin() inside
GRANT EXECUTE ON FUNCTION public.admin_reschedule_wash(uuid, date, public.time_slot, text) TO authenticated; -- is_admin() inside

-- ───────────────────────── admin: refunds ─────────────────────────
-- Refund requests (a cancelled paid wash, or money that arrived but could not be fulfilled) were invisible to admins:
-- the table only had customer policies. WASHO pays the money back in the Razorpay dashboard, then records it here.
DROP POLICY IF EXISTS refunds_admin_read ON public.refunds;
CREATE POLICY refunds_admin_read ON public.refunds FOR SELECT TO authenticated USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.admin_resolve_refund(p_refund_id uuid, p_status public.refund_status, p_provider_refund_id text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old public.refund_status;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Unauthorized: admin access required' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('approved', 'processed', 'failed') THEN RAISE EXCEPTION 'A refund can be marked approved, processed or failed'; END IF;
  IF p_status = 'processed' AND (p_provider_refund_id IS NULL OR char_length(trim(p_provider_refund_id)) < 4) THEN
    RAISE EXCEPTION 'Enter the Razorpay refund id so the payout can be traced';
  END IF;
  SELECT status INTO v_old FROM public.refunds WHERE id = p_refund_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Refund not found'; END IF;
  IF v_old IN ('processed', 'reversed') THEN RAISE EXCEPTION 'This refund is already %', v_old; END IF;
  UPDATE public.refunds SET status = p_status, provider_refund_id = COALESCE(NULLIF(trim(p_provider_refund_id), ''), provider_refund_id), updated_at = now() WHERE id = p_refund_id;
  PERFORM app_private.audit('refund', p_refund_id, 'refund_' || p_status::text, jsonb_build_object('from', v_old, 'provider_refund_id', p_provider_refund_id));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_resolve_refund(uuid, public.refund_status, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_refund(uuid, public.refund_status, text) TO authenticated; -- is_admin() inside
