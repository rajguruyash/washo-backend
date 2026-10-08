import { useNeedsPhone } from '../lib/useNeedsPhone';
import { PhoneEntry } from './PhoneEntry';

/**
 * The last step of a booking, for someone who signed in with their email: a mobile number is compulsory before paying (a specialist rings
 * before every wash). Ten digits, +91, saved: no code. Once it is saved this disappears and the payment slider wakes up. Nothing is shown
 * to anyone who signed in with their number.
 */
export function PayPhoneGate({ what = 'pay' }: { what?: 'pay' | 'claim' }) {
  const needs = useNeedsPhone();
  if (!needs) return null;
  return (
    <div id="pay-phone" className="glass mt-5 border-warn/30 p-5" role="group" aria-label="Mobile number needed">
      <PhoneEntry
        compact
        intro={`You signed in with your email, so we need a mobile number before you ${what}. Your specialist rings you before every wash.`}
      />
    </div>
  );
}
