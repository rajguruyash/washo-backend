import { useState } from 'react';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../state/auth';
import { ApiError } from './http';
import { PaymentDismissed, payWithRazorpay, recoverPayment } from './razorpay';
import { useRefreshAll } from './queries';
import type { Order, VerifyResult } from './types';

/**
 * Opens Razorpay for an order and reports the outcome. Returns the verified result, or null if the customer closed the window
 * or something failed (the reason has already been shown).
 */
export function usePay() {
  const { user } = useAuth();
  const toast = useToast();
  const refresh = useRefreshAll();
  const [paying, setPaying] = useState(false);

  const pay = async (getOrder: () => Promise<Order>, description: string): Promise<VerifyResult | null> => {
    setPaying(true);
    let order: Order | null = null;
    // Whatever way the payment was recorded (verified here, or found afterwards), the customer ends up in the same place.
    const finish = async (result: VerifyResult): Promise<VerifyResult | null> => {
      await refresh();
      if (result.status === 'unfulfilled') {
        toast.error('We received your payment but could not finish the booking. WASHO has been alerted and will refund or fix it.');
        return null;
      }
      return result;
    };
    try {
      order = await getOrder();
      const result = await payWithRazorpay({ order, description, prefill: { name: user?.full_name, email: user?.email, contact: user?.phone ?? undefined }, onFailed: (reason) => toast.error(reason) });
      return await finish(result);
    } catch (err) {
      // "Closed" does not always mean "not paid": the customer may have paid in Google Pay and come back to a window that never heard.
      // Ask Razorpay before saying it was cancelled.
      if (order && err instanceof PaymentDismissed) {
        const found = await recoverPayment(order.payment_id);
        if (found) return await finish(found);
      }
      if (err instanceof PaymentDismissed) toast.error('Payment cancelled. You can try again any time.');
      else toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Payment failed. Please try again.');
      return null;
    } finally {
      setPaying(false);
    }
  };
  return { pay, paying };
}
