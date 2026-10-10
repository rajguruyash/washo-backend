// Supabase Auth "Send SMS" hook -> 2Factor. Supabase generates the OTP, stores it and checks it later; this function only delivers the
// code Supabase hands it, through the approved 2Factor template. It is NOT an OTP system of its own.
//
// Deploy with JWT verification OFF (Supabase calls a hook with a Standard Webhooks signature, not a user's token):
//   supabase functions deploy send-sms-hook --no-verify-jwt --project-ref <ref>
// Secrets (Supabase dashboard -> Edge Functions -> Secrets, or `supabase secrets set`; never in Git, never in the website's .env):
//   TWOFACTOR_API_KEY        your 2Factor API key
//   SEND_SMS_HOOK_SECRET     the "v1,whsec_..." secret shown when the hook is created under Auth -> Hooks
//   TWOFACTOR_OTP_TEMPLATE   optional, defaults to WASHO_LOGIN_OTP
// The hook is project-wide: once it is switched on in Auth -> Hooks, EVERY phone code of this Supabase project (website and mobile app)
// is delivered through here. Until then this function is inert.
import { ReplayGuard } from '../_shared/sms.ts';
import { handleSendSmsHook } from './handler.ts';

const replay = new ReplayGuard();

Deno.serve((req: Request) =>
  handleSendSmsHook(req, {
    getenv: (name) => Deno.env.get(name),
    fetchFn: (input, init) => fetch(input, init),
    nowMs: () => Date.now(),
    log: (level, event, fields) => console[level === 'info' ? 'log' : level](JSON.stringify({ fn: 'send-sms-hook', event, ...fields })),
    replay,
  }),
);
