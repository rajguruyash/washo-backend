-- 20261004000048_worker_pool_details.sql
-- SAFE / re-runnable. A specialist looking at an UNCLAIMED wash (the Available tab) now sees what the job is before deciding to claim it: what the service includes and how long it takes,
-- the vehicle (type, make, model, colour), the society and BUILDING, the parking spot, and the time the customer wants it finished by. Until now the pool showed only the date, window,
-- service name, vehicle type, society, area and city.
--
-- Still NOT shown until the specialist claims the wash (the privacy rule for the pool is otherwise unchanged): the customer's name, mobile number, flat number, the vehicle's number plate,
-- and the customer's notes. Those appear in the specialist's own queue once the wash is theirs (worker_queue), exactly as before.
--
-- worker_pool() returns more columns, and a function cannot change its result columns in place, so it is dropped and created again with the same name, argument and grant. The columns it
-- always had keep their names, order and meaning, so a caller that reads those still works; the new ones are added at the end. No table, no row and no other function is touched.

DROP FUNCTION IF EXISTS public.worker_pool(integer);

CREATE FUNCTION public.worker_pool(p_days integer DEFAULT 14)
RETURNS TABLE (
  booking_id uuid, scheduled_date date, time_slot public.time_slot, booking_type public.booking_type,
  service_name text, vehicle_type public.vehicle_type, society_name text, area_locality text, city text,
  building_block text, vehicle_make text, vehicle_model text, vehicle_color text, parking_location text, target_completion_time text,
  wash_kind text, duration_minutes integer, service_includes jsonb
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_worker() AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Only workers can view the pool' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT b.id, b.scheduled_date, b.time_slot, b.booking_type, s.name, v.vehicle_type,
         COALESCE(a.society_name, va.society_name), COALESCE(a.area_locality, va.area_locality), COALESCE(a.city, va.city),
         COALESCE(a.building_block, va.building_block), v.make, v.model, v.color,
         COALESCE(NULLIF(btrim(b.parking_location), ''), NULLIF(btrim(v.parking_location), ''), NULLIF(btrim(a.parking_location), ''), NULLIF(btrim(va.parking_location), '')),
         NULLIF(btrim(b.target_completion_time::text), ''),
         s.wash_kind::text, s.duration_minutes, s.includes
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
