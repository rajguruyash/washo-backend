import { Resend } from 'resend';
import { config } from './config';

const resend = config.email.resendKey ? new Resend(config.email.resendKey) : null;

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface RequestSummary {
  reference_code: string;
  frequency_per_week: number;
  duration_months: number;
  vehicle_type: string;
  vehicle_model: string;
  registration_number: string;
  customer: string | null;
  phone: string | null;
}

/** Tells WASHO a membership request is waiting for a quote. Best-effort: a mail failure never affects the customer. */
export async function notifyAdminOfRequest(r: RequestSummary): Promise<void> {
  if (!resend) return;
  try {
    await resend.emails.send({
      from: config.email.from,
      to: [config.email.adminEmail],
      subject: `New membership request · ${r.reference_code}`,
      html: `
        <div style="font-family:Arial,sans-serif;padding:24px;color:#0f172a;background:#f8fafc;border-radius:12px;max-width:520px">
          <h2 style="color:#1248B8;margin:0 0 8px">Membership request waiting for a quote</h2>
          <table style="width:100%;font-size:14px;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#64748b">Reference</td><td><strong>${esc(r.reference_code)}</strong></td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Customer</td><td>${esc(r.customer)} ${esc(r.phone)}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Vehicle</td><td>${esc(r.vehicle_type)} · ${esc(r.vehicle_model)} · ${esc(r.registration_number)}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b">Plan</td><td>${esc(r.frequency_per_week)} wash(es) a week for ${esc(r.duration_months)} month(s)</td></tr>
          </table>
          <p style="font-size:13px;color:#64748b">Open the WASHO admin console to review and quote.</p>
        </div>`,
    });
  } catch (err) {
    console.error('Admin notification email failed:', err);
  }
}
