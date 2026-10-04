-- 20261004000008_service_rpc_wrappers.sql
-- SAFE / additive. Supabase edge functions reach the database through PostgREST, which only exposes the
-- `public` schema. The payment functions live in the private `app_private` schema on purpose, so these thin
-- wrappers make them callable by the SERVICE ROLE (and the Render API role) and nobody else.
-- Customers, workers and anonymous visitors get "permission denied".

CREATE OR REPLACE FUNCTION public.svc_attach_provider_order(p_payment_id uuid, p_provider_order_id text, p_expected_profile_id uuid DEFAULT NULL)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT app_private.attach_provider_order(p_payment_id, p_provider_order_id, p_expected_profile_id);
$$;

CREATE OR REPLACE FUNCTION public.svc_settle_payment(
  p_provider_order_id text, p_provider_payment_id text, p_amount_cents integer, p_currency text,
  p_provider_status text, p_expected_profile_id uuid DEFAULT NULL, p_source text DEFAULT 'api')
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT app_private.settle_payment(p_provider_order_id, p_provider_payment_id, p_amount_cents, p_currency, p_provider_status, p_expected_profile_id, p_source);
$$;

CREATE OR REPLACE FUNCTION public.svc_profile_id_for_auth_user(p_auth_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.profiles WHERE auth_user_id = p_auth_user_id AND role = 'customer';
$$;

REVOKE ALL ON FUNCTION public.svc_attach_provider_order(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.svc_settle_payment(text, text, integer, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.svc_profile_id_for_auth_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.svc_attach_provider_order(uuid, text, uuid) TO service_role, washo_api;
GRANT EXECUTE ON FUNCTION public.svc_settle_payment(text, text, integer, text, text, uuid, text) TO service_role, washo_api;
GRANT EXECUTE ON FUNCTION public.svc_profile_id_for_auth_user(uuid) TO service_role, washo_api;
