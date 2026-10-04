-- 20261005000004_cutover_private_photos.sql
-- *** CUTOVER: apply after the mobile apps read photos via signed URLs (createSignedUrl) instead of getPublicUrl. ***
--
-- Photos of customers' vehicles are currently reachable by anyone who has (or guesses) the link, and any signed-in
-- user can list or upload to the bucket. Afterwards:
--   * the bucket is private
--   * a photo is readable only by its booking's customer, the assigned worker, and admins
--   * only the assigned worker can upload, and only into that booking's folder ({booking_id}/...)
-- Existing object paths ({booking_id}/{file}) are unchanged, so nothing has to be moved.

CREATE OR REPLACE FUNCTION app_private.try_uuid(p_text text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN p_text::uuid; EXCEPTION WHEN invalid_text_representation THEN RETURN NULL; END $$;
REVOKE ALL ON FUNCTION app_private.try_uuid(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.try_uuid(text) TO authenticated, service_role;
GRANT USAGE ON SCHEMA app_private TO authenticated; -- needed only to resolve try_uuid() inside the storage policies

UPDATE storage.buckets SET public = false WHERE id = 'wash-photos';

DROP POLICY IF EXISTS wash_photos_authenticated_select ON storage.objects;
DROP POLICY IF EXISTS wash_photos_authenticated_insert ON storage.objects;
DROP POLICY IF EXISTS wash_photos_scoped_select ON storage.objects;
DROP POLICY IF EXISTS wash_photos_assigned_worker_insert ON storage.objects;

CREATE POLICY wash_photos_scoped_select ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'wash-photos' AND (
    public.is_admin()
    OR public.is_current_customer_booking(app_private.try_uuid((storage.foldername(name))[1]))
    OR public.is_current_worker_assignment(app_private.try_uuid((storage.foldername(name))[1]))
  )
);

CREATE POLICY wash_photos_assigned_worker_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'wash-photos' AND public.is_worker()
  AND public.is_current_worker_assignment(app_private.try_uuid((storage.foldername(name))[1]))
);
