-- 20261005000003_cutover_worker_privacy.sql
-- *** CUTOVER: apply after the worker app reads the pool via worker_pool() and no longer selects
--     bookings/profiles/vehicles/addresses directly. ***
--
-- Today ANY worker can read every customer's name, phone, address, vehicles, bookings, events and photos.
-- After this migration a worker sees:
--   * the POOL: only date, slot, service, vehicle type and the society/area  (no name, phone, flat or plate)
--   * full details ONLY for bookings they have claimed (the existing assignment-scoped policies)

DROP POLICY IF EXISTS profiles_worker_select ON public.profiles;
DROP POLICY IF EXISTS vehicles_worker_all_select ON public.vehicles;
DROP POLICY IF EXISTS addresses_worker_select ON public.customer_addresses;
DROP POLICY IF EXISTS bookings_worker_pool_select ON public.bookings;
DROP POLICY IF EXISTS booking_events_worker_select ON public.booking_events;
DROP POLICY IF EXISTS booking_photos_worker_select ON public.booking_photos;
DROP POLICY IF EXISTS assignments_worker_all_select ON public.worker_assignments;

-- Admins keep full read through the existing *_admin_all policies. Assigned workers keep access through
-- profiles_worker_assigned_customer_select / vehicles_worker_assignment_select / booking*_read / assignments_worker_scope.
-- Addresses had no assigned-worker policy of their own, so add one:
DROP POLICY IF EXISTS addresses_worker_assigned_select ON public.customer_addresses;
CREATE POLICY addresses_worker_assigned_select ON public.customer_addresses FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.bookings b JOIN public.worker_assignments wa ON wa.booking_id = b.id
     WHERE b.customer_profile_id = customer_addresses.customer_profile_id
       AND wa.worker_profile_id = public.current_profile_id() AND wa.is_active AND public.is_worker()
  )
);

-- The pool (worker_pool()) and the worker's own queue (worker_queue()) ship in the SAFE set
-- (migrations/20261004000009_worker_workflow.sql), because they only add functions.
