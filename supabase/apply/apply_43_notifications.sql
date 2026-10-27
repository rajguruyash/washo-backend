-- WASHO migration 43: Admin -> Notifications (an admin writes a message and it lands in every customer's Notifications in the app). Paste into the Supabase SQL Editor and Run, once. Run this BEFORE 47.
begin;

-- 20261004000043_admin_announcements.sql
-- SAFE / additive and re-runnable. ANNOUNCEMENTS FROM THE ADMIN PAGE. An admin (Super admin, Operations or Marketing: the roles that already manage Campaigns) writes a short
-- message in Admin -> Notifications and it lands in every customer's Notifications in the app (all customers, or only those with a membership that is on). Customers read it
-- through the notifications they already have; nothing about how they read or clear notifications changes.
--
--   notifications.category                    'announcement' is now an allowed category (the existing list is kept as it is)
--   admin_announcements                       one row per message sent: who, what, to whom, how many. Nobody but the functions below can read or write it
--   admin_send_announcement(title, body, audience)   validates, records it, and adds one notification per customer, all or nothing. Refuses the same words sent twice in two minutes
--   admin_announcements_list()                the last 50 messages sent, with who sent them
-- Nothing existing is touched: no customer, wash, payment or earlier notification row changes when this is applied. Archived customers are not sent anything.

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check CHECK (category = ANY (ARRAY[
  'upcoming_wash', 'booking_confirmed', 'worker_assigned', 'wash_started', 'wash_completed', 'payment_successful',
  'membership_expiring', 'membership_approved', 'schedule_changed', 'customer_unavailable', 'announcement']));

CREATE TABLE IF NOT EXISTS public.admin_announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  audience text NOT NULL CHECK (audience IN ('all', 'members')),
  recipients integer NOT NULL DEFAULT 0 CHECK (recipients >= 0),
  sent_by uuid REFERENCES public.profiles(id),
  sent_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_announcements_sent_idx ON public.admin_announcements (sent_at DESC);
ALTER TABLE public.admin_announcements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.admin_announcements FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_send_announcement(p_title text, p_body text, p_audience text DEFAULT 'all') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin uuid := app_private.require_access('campaigns', 'manage');
  v_title text := btrim(COALESCE(p_title, ''));
  v_body text := btrim(COALESCE(p_body, ''));
  v_audience text := COALESCE(NULLIF(btrim(p_audience), ''), 'all');
  v_id uuid;
  v_n integer;
BEGIN
  IF char_length(v_title) NOT BETWEEN 1 AND 80 THEN RAISE EXCEPTION 'Give the notification a title (up to 80 characters)'; END IF;
  IF char_length(v_body) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Write the message (up to 500 characters)'; END IF;
  IF v_audience NOT IN ('all', 'members') THEN RAISE EXCEPTION 'Choose who gets it: everyone, or members'; END IF;
  -- a double tap or a retry must not message every customer twice
  IF EXISTS (SELECT 1 FROM public.admin_announcements a WHERE a.sent_by = v_admin AND a.title = v_title AND a.body = v_body AND a.audience = v_audience AND a.sent_at > now() - interval '2 minutes') THEN
    RAISE EXCEPTION 'This notification was just sent. Wait a couple of minutes before sending the same words again';
  END IF;

  INSERT INTO public.admin_announcements (title, body, audience, sent_by) VALUES (v_title, v_body, v_audience, v_admin) RETURNING id INTO v_id;
  INSERT INTO public.notifications (profile_id, category, title, body, reference_id)
  SELECT p.id, 'announcement', v_title, v_body, v_id
    FROM public.profiles p
   WHERE p.role = 'customer' AND p.archived_at IS NULL
     AND (v_audience = 'all' OR EXISTS (SELECT 1 FROM public.memberships m WHERE m.customer_profile_id = p.id AND m.status = 'active'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.admin_announcements SET recipients = v_n WHERE id = v_id;
  PERFORM app_private.audit('announcement', v_id, 'announcement_sent', jsonb_build_object('title', v_title, 'audience', v_audience, 'recipients', v_n));
  RETURN jsonb_build_object('id', v_id, 'recipients', v_n);
END $$;
REVOKE ALL ON FUNCTION public.admin_send_announcement(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_send_announcement(text, text, text) TO authenticated; -- the role check is inside

CREATE OR REPLACE FUNCTION public.admin_announcements_list() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM app_private.require_access('campaigns', 'view');
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'body', x.body, 'audience', x.audience, 'recipients', x.recipients,
                                        'sent_at', x.sent_at, 'sent_by', (SELECT p.full_name FROM public.profiles p WHERE p.id = x.sent_by)) ORDER BY x.sent_at DESC)
      FROM (SELECT * FROM public.admin_announcements ORDER BY sent_at DESC LIMIT 50) x
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.admin_announcements_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_announcements_list() TO authenticated; -- the role check is inside

commit;
