import { useState } from 'react';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../state/auth';
import { ApiError } from './http';
import { PaymentDismissed, payWithRazorpay } from './razorpay';
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
    try {
      const order = await getOrder();
      const result = await payWithRazorpay({ order, description, prefill: { name: user?.full_name, email: user?.email, contact: user?.phone ?? undefined } });
      await refresh();
      if (result.status === 'unfulfilled') {
        toast.error('We received your payment but could not finish the booking. WASHO has been alerted and will refund or fix it.');
        return null;
      }
      return result;
    } catch (err) {
      if (err instanceof PaymentDismissed) toast.error('Payment cancelled. You can try again any time.');
      else toast.error(err instanceof ApiError || err instanceof Error ? err.message : 'Payment failed. Please try again.');
      return null;
    } finally {
      setPaying(false);
    }
  };
  return { pay, paying };
}
