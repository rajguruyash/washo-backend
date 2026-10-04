import { post } from './http';
import type { Order, VerifyResult } from './types';

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (r: any) => void) => void };
  }
}

let scriptPromise: Promise<void> | null = null;
function loadCheckoutScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  scriptPromise ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptPromise = null;
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export class PaymentDismissed extends Error {
  constructor() {
    super('Payment window closed');
  }
}

/**
 * Opens Razorpay Checkout for an order the DATABASE priced, then asks the server to verify. The browser's word is never
 * enough: the edge function checks Razorpay's signature AND Razorpay's own record before anything is activated.
 */
export async function payWithRazorpay(o: {
  order: Order;
  description: string;
  prefill: { name?: string | null; email?: string | null; contact?: string };
  /** Called when Razorpay reports a failed attempt. The modal stays open so the customer can retry or pick another method. */
  onFailed?: (reason: string) => void;
}): Promise<VerifyResult> {
  await loadCheckoutScript();
  return new Promise<VerifyResult>((resolve, reject) => {
    const rzp = new window.Razorpay!({
      key: o.order.key_id,
      order_id: o.order.order_id,
      amount: o.order.amount,
      currency: o.order.currency,
      name: 'WASHO',
      description: o.description,
      prefill: { name: o.prefill.name ?? undefined, email: o.prefill.email ?? undefined, contact: o.prefill.contact ?? o.order.prefill?.contact },
      theme: { color: '#1248B8' },
      modal: { ondismiss: () => reject(new PaymentDismissed()) },
      handler: async (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        try {
          resolve((await post<{ result: VerifyResult }>('/payments/verify', resp)).result);
        } catch (err) {
          reject(err);
        }
      },
    });
    rzp.on('payment.failed', (r: { error?: { description?: string; reason?: string } }) => {
      o.onFailed?.(r?.error?.description || 'The payment did not go through. You can try again.');
    });
    rzp.open();
  });
}
