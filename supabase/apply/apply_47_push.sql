-- WASHO migration 47: device push tokens (instant push to a closed app). Paste into the Supabase SQL Editor and Run, once. Needs migrations up to 43 (Notifications) applied first.
begin;

-- 20261004000047_device_push_tokens.sql
-- SAFE / additive and re-runnable. PUSH TO A CLOSED APP (Firebase Cloud Messaging). The mobile app asks Android for its Firebase "device token" and hands it to WASHO after sign-in; when an
-- admin sends a notification (Admin -> Notifications, migration 43) the server also pushes it to the phones of the customers who got it, so it arrives at once even when the app is closed.
--
--   device_tokens                              one row per phone: the token, whose it is, when it was last seen. Nobody but the functions below can read or write it
--   register_device_token(token, platform, app_version)   the signed-in person's phone: saved, or moved to this person if the phone changed hands. A person keeps their 5 newest phones
--   unregister_device_token(token)             on sign-out: this phone stops getting that person's messages
--   admin_announcement_push_targets(id)        for the server, as the admin who just sent it: the title, the message and the tokens of the customers who received it (Campaigns access)
--   admin_forget_device_tokens(tokens)         for the server: tokens Firebase says no longer exist (app uninstalled) are removed
-- Nothing existing is touched: no customer, wash, payment or notification row changes when this is applied. Without a Firebase key on the server nothing is pushed and everything works as before.

CREATE TABLE IF NOT EXISTS public.device_tokens (
  token text PRIMARY KEY CHECK (char_length(token) BETWEEN 20 AND 4096),
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  platform text NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
  app_version text CHECK (app_version IS NULL OR char_length(app_version) <= 40),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_tokens_profile_idx ON public.device_tokens (profile_id, last_seen_at DESC);
ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_tokens FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.register_device_token(p_token text, p_platform text DEFAULT 'android', p_app_version text DEFAULT NULL) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := public.current_profile_id();
  v_token text := btrim(COALESCE(p_token, ''));
  v_platform text := COALESCE(NULLIF(btrim(p_platform), ''), 'android');
  v_version text := NULLIF(btrim(COALESCE(p_app_version, '')), '');
BEGIN
  IF v_me IS NULL OR NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_me AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'Unauthorized: sign in first' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_token) NOT BETWEEN 20 AND 4096 OR v_token ~ '\s' THEN RAISE EXCEPTION 'That is not a valid device token'; END IF;
  IF v_platform NOT IN ('android', 'ios') THEN RAISE EXCEPTION 'Platform must be android or ios'; END IF;
  IF v_version IS NOT NULL AND char_length(v_version) > 40 THEN v_version := left(v_version, 40); END IF;

  -- the same phone signed in as someone else now belongs to that person, so the last person's messages stop arriving on it
  INSERT INTO public.device_tokens (token, profile_id, platform, app_version) VALUES (v_token, v_me, v_platform, v_version)
  ON CONFLICT (token) DO UPDATE SET profile_id = EXCLUDED.profile_id, platform = EXCLUDED.platform, app_version = EXCLUDED.app_version, last_seen_at = now();

  -- a person keeps their 5 newest phones
  DELETE FROM public.device_tokens d
   WHERE d.profile_id = v_me
     AND d.token IN (SELECT t.token FROM public.device_tokens t WHERE t.profile_id = v_me ORDER BY t.last_seen_at DESC, t.token OFFSET 5);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.register_device_token(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_token(text, text, text) TO authenticated; -- the caller's own profile is read inside

CREATE OR REPLACE FUNCTION public.unregister_device_token(p_token text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_me uuid := public.current_profile_id();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Unauthorized: sign in first' USING ERRCODE = '42501'; END IF;
  DELETE FROM public.device_tokens WHERE token = btrim(COALESCE(p_token, '')) AND profile_id = v_me;   -- only your own phone
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.unregister_device_token(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unregister_device_token(text) TO authenticated; -- the caller's own profile is read inside

CREATE OR REPLACE FUNCTION public.admin_announcement_push_targets(p_announcement_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE a public.admin_announcements%ROWTYPE;
BEGIN
  PERFORM app_private.require_access('campaigns', 'manage');
  SELECT * INTO a FROM public.admin_announcements WHERE id = p_announcement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That notification no longer exists'; END IF;
  RETURN jsonb_build_object(
    'title', a.title,
    'body', a.body,
    'devices', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('token', d.token, 'notification_id', n.id))
        FROM public.notifications n
        JOIN public.device_tokens d ON d.profile_id = n.profile_id
        JOIN public.profiles p ON p.id = n.profile_id
       WHERE n.reference_id = a.id AND n.category = 'announcement' AND p.archived_at IS NULL), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.admin_announcement_push_targets(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_announcement_push_targets(uuid) TO authenticated; -- the role check is inside

CREATE OR REPLACE FUNCTION public.admin_forget_device_tokens(p_tokens text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  PERFORM app_private.require_access('campaigns', 'manage');
  IF p_tokens IS NULL OR cardinality(p_tokens) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_tokens) > 5000 THEN RAISE EXCEPTION 'Too many tokens at once'; END IF;
  DELETE FROM public.device_tokens WHERE token = ANY (p_tokens);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.admin_forget_device_tokens(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_forget_device_tokens(text[]) TO authenticated; -- the role check is inside

commit;
