-- 20261004000041_support_pictures.sql
-- SAFE / additive and re-runnable. PICTURES IN A COMPLAINT. An admin with the support role can add pictures (up to 4) to a reply in Admin -> Support, and the customer sees them
-- in that reply on their own complaint page. Nothing existing is touched: no complaint, message or customer row changes when this is applied.
--
--   support_attachments                       one row per picture: which complaint, which message (empty until the reply is sent), who added it, where the file is
--   admin_support_add_attachment(...)         records a picture for a complaint BEFORE the file is stored (the website stores the file only if this succeeds, in the same
--                                             transaction, so a picture without a row or a row without a file cannot be left behind). Support role, complaint not closed.
--   admin_support_reply_with_pictures(...)    the reply (admin_support_reply, unchanged) and the pictures that go with it, all or nothing
--   my_support_ticket(id)                     (replaced) each message also lists its pictures
--   admin_support_get(id)                     (replaced) the same for the admin
-- A picture is only ever reachable through the website, which asks these functions first (a customer gets only their own complaint's pictures, and only the ones that were
-- sent with a reply) and then makes a short-lived link. The files live in the same private bucket as wash photos, in a folder named after the complaint.

CREATE TABLE IF NOT EXISTS public.support_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  message_id uuid REFERENCES public.support_messages(id) ON DELETE CASCADE,   -- NULL until the reply it goes with is sent
  uploaded_by uuid NOT NULL REFERENCES public.profiles(id),
  from_admin boolean NOT NULL,
  storage_path text NOT NULL UNIQUE,
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 20971520),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_attachments_ticket_idx ON public.support_attachments (ticket_id, created_at);
CREATE INDEX IF NOT EXISTS support_attachments_message_idx ON public.support_attachments (message_id);
ALTER TABLE public.support_attachments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.support_attachments FROM PUBLIC, anon, authenticated;

-- Record a picture. The file's path must be in the complaint's own folder and start with "support-" (so it can never point at a wash photo).
CREATE OR REPLACE FUNCTION public.admin_support_add_attachment(p_ticket uuid, p_path text, p_content_type text, p_bytes integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('support', 'manage');
  v_t public.support_tickets%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  IF v_t.status = 'closed' THEN RAISE EXCEPTION 'This complaint is closed'; END IF;
  IF p_path IS NULL OR char_length(p_path) > 200 OR p_path !~ ('^' || p_ticket::text || '/support-[A-Za-z0-9._-]+$') THEN RAISE EXCEPTION 'That is not a valid picture'; END IF;
  IF (SELECT count(*) FROM public.support_attachments WHERE ticket_id = p_ticket) >= 40 THEN RAISE EXCEPTION 'This complaint already has as many pictures as it can hold'; END IF;
  IF (SELECT count(*) FROM public.support_attachments WHERE ticket_id = p_ticket AND uploaded_by = v_me AND message_id IS NULL) >= 8 THEN
    RAISE EXCEPTION 'Send your reply before adding more pictures';
  END IF;
  INSERT INTO public.support_attachments (ticket_id, uploaded_by, from_admin, storage_path, content_type, bytes)
  VALUES (p_ticket, v_me, true, p_path, p_content_type, p_bytes) RETURNING id INTO v_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.admin_support_add_attachment(uuid, text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_support_add_attachment(uuid, text, text, integer) TO authenticated;

-- The reply as admin_support_reply always was, with up to 4 of the pictures the same admin added to this complaint. If any picture is not theirs, not this complaint's, or
-- already sent, nothing is sent at all.
CREATE OR REPLACE FUNCTION public.admin_support_reply_with_pictures(p_id uuid, p_message text, p_status text, p_attachment_ids uuid[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_access('support', 'manage');
  v_ids uuid[] := ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(p_attachment_ids, ARRAY[]::uuid[])) x);
  v_msg uuid;
  n integer;
BEGIN
  IF cardinality(v_ids) > 4 THEN RAISE EXCEPTION 'Add up to 4 pictures to one reply'; END IF;
  PERFORM public.admin_support_reply(p_id, p_message, p_status);
  IF cardinality(v_ids) = 0 THEN RETURN true; END IF;
  SELECT m.id INTO v_msg FROM public.support_messages m WHERE m.ticket_id = p_id AND m.from_admin AND m.author_profile_id = v_me ORDER BY m.created_at DESC, m.id LIMIT 1;
  UPDATE public.support_attachments SET message_id = v_msg
   WHERE id = ANY (v_ids) AND ticket_id = p_id AND message_id IS NULL AND uploaded_by = v_me AND from_admin;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> cardinality(v_ids) THEN RAISE EXCEPTION 'One of the pictures could not be found. Add it again'; END IF;
  PERFORM app_private.audit('support_ticket', p_id, 'support_pictures_sent', jsonb_build_object('pictures', n));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.admin_support_reply_with_pictures(uuid, text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_support_reply_with_pictures(uuid, text, text, uuid[]) TO authenticated;

-- Migration 27's two readers, with each message's pictures added. Nothing else about them changes.
CREATE OR REPLACE FUNCTION public.my_support_ticket(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := app_private.require_customer();
  v_t public.support_tickets%ROWTYPE;
BEGIN
  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_id AND customer_profile_id = v_me;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  RETURN jsonb_build_object(
    'ticket', jsonb_build_object('id', v_t.id, 'reference_code', v_t.reference_code, 'category', v_t.category, 'subject', v_t.subject, 'status', v_t.status,
                                 'created_at', v_t.created_at, 'booking_id', v_t.booking_id,
                                 'booking_reference', (SELECT b.reference_code FROM public.bookings b WHERE b.id = v_t.booking_id)),
    'messages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'from_admin', m.from_admin, 'body', m.body, 'created_at', m.created_at,
                   'attachments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'storage_path', a.storage_path, 'content_type', a.content_type) ORDER BY a.created_at, a.id)
                                              FROM public.support_attachments a WHERE a.message_id = m.id), '[]'::jsonb)) ORDER BY m.created_at), '[]'::jsonb)
                   FROM public.support_messages m WHERE m.ticket_id = v_t.id));
END $$;

CREATE OR REPLACE FUNCTION public.admin_support_get(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t public.support_tickets%ROWTYPE;
BEGIN
  PERFORM app_private.require_access('support', 'view');
  SELECT * INTO v_t FROM public.support_tickets WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Complaint not found'; END IF;
  RETURN jsonb_build_object(
    'ticket', jsonb_build_object('id', v_t.id, 'reference_code', v_t.reference_code, 'category', v_t.category, 'subject', v_t.subject, 'status', v_t.status,
                                 'created_at', v_t.created_at, 'booking_id', v_t.booking_id,
                                 'booking_reference', (SELECT b.reference_code FROM public.bookings b WHERE b.id = v_t.booking_id),
                                 'customer_id', v_t.customer_profile_id,
                                 'customer_name', (SELECT full_name FROM public.profiles WHERE id = v_t.customer_profile_id),
                                 'customer_phone', (SELECT phone FROM public.profiles WHERE id = v_t.customer_profile_id)),
    'messages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'from_admin', m.from_admin, 'body', m.body, 'created_at', m.created_at,
                   'author', (SELECT full_name FROM public.profiles WHERE id = m.author_profile_id),
                   'attachments', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'storage_path', a.storage_path, 'content_type', a.content_type) ORDER BY a.created_at, a.id)
                                              FROM public.support_attachments a WHERE a.message_id = m.id), '[]'::jsonb)) ORDER BY m.created_at), '[]'::jsonb)
                   FROM public.support_messages m WHERE m.ticket_id = v_t.id));
END $$;
