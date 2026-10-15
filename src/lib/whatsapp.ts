/** WhatsApp from the admin page: a chat link for a customer's number, with a ready-made first message about the wash. */

/** Digits only, with the country code: 9876543210 and +91 98765 43210 both become 919876543210. */
export const waNumber = (phone: string | null | undefined): string | null => {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith('0')) return `91${d.slice(1)}`;   // 098765 43210, the way a number is dialled inside India
  if (d.length === 12 && d.startsWith('91')) return d;
  return d.length >= 11 && d.length <= 15 ? d : null;
};

/** What kind of wash it is, in words that read after "your" and before "wash": free, membership, or the service ("car body", "bike", "suv deep cleaning"). */
export const washKindWords = (w: { payment_kind?: string | null; booking_type?: string | null; campaign_name?: string | null; price_cents?: number | null; service_name?: string | null }): string => {
  if (w.booking_type === 'membership' || w.payment_kind === 'membership') return 'membership';
  if (w.campaign_name || w.payment_kind === 'free') return 'free';
  const name = (w.service_name ?? '').trim().replace(/\s*wash$/i, '').toLowerCase();
  return name;
};

/** "Hey Asha, this is regarding your car body wash." */
export const waMessage = (customerName: string | null | undefined, kindWords: string): string => {
  const first = (customerName ?? '').trim().split(/\s+/)[0] || 'there';
  return `Hey ${first}, this is regarding your ${kindWords ? `${kindWords} ` : ''}wash.`;
};

export const waLink = (phone: string | null | undefined, text: string): string | null => {
  const n = waNumber(phone);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
};
