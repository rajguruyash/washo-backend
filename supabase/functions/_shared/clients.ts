import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const need = (name: string): string => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`${name} is not configured`);
  return v;
};

/** Service-role client: ONLY for server-side settlement calls. Never expose its key to a browser. */
export const adminClient = (): SupabaseClient => createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'));

/** A client that acts AS THE CALLER, so the database applies RLS and auth.uid() for them. */
export const userClient = (authorization: string): SupabaseClient =>
  createClient(need('SUPABASE_URL'), need('SUPABASE_ANON_KEY'), { global: { headers: { Authorization: authorization } } });

export const razorpayAuth = (): string => 'Basic ' + btoa(`${need('RAZORPAY_KEY_ID')}:${need('RAZORPAY_KEY_SECRET')}`);
export const razorpayKeyId = (): string => need('RAZORPAY_KEY_ID');
export const razorpayKeySecret = (): string => need('RAZORPAY_KEY_SECRET');
export const razorpayWebhookSecret = (): string => Deno.env.get('RAZORPAY_WEBHOOK_SECRET') ?? '';
