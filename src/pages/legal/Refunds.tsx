import { Link } from 'react-router-dom';
import {B, Contact, LegalPage, PolicySection, Rows, Ul, type Section } from './Legal';
import { LEGAL } from './facts';

const SECTIONS: Section[] = [
  { id: 'single', title: 'A single wash' },
  { id: 'membership', title: 'A membership' },
  { id: 'free', title: 'A free wash' },
  { id: 'us', title: 'When WASHO cannot do your wash' },
  { id: 'charged', title: 'Charged but nothing booked' },
  { id: 'how', title: 'How a refund is paid' },
  { id: 'contact', title: 'Contact' },
];

/** Cancelling, rescheduling and getting money back, as the website actually works. */
export default function Refunds() {
  return (
    <LegalPage
      title="Cancellation & Refund Policy"
      sections={SECTIONS}
      intro={
        <>
          <p>This policy says how to move or cancel a wash and when you get your money back. It is part of our <Link to="/terms" className="font-semibold text-washo-300 hover:text-white">Terms of Service</Link>.</p>
          <p><B>In short:</B> cancel a single wash before it starts and you get <B>all</B> your money back. A membership&rsquo;s washes can be moved but not cancelled one by one. If we cannot do a wash, you can move it or get your money back.</p>
        </>
      }
    >
      <PolicySection n={1} id="single" title="A single wash">
        <Ul>
          <li><B>Cancel:</B> open the booking in the app or on the website and cancel it, any time <em>before the specialist starts the wash</em>. There is no cut-off time and no cancellation fee.</li>
          <li><B>Refund:</B> if you paid, we refund the <B>full amount you paid</B>. Cancelling raises the refund request for you straight away; WASHO then approves it and sends it to your original payment method.</li>
          <li><B>After it starts:</B> a wash that is in progress or finished cannot be cancelled. If you are unhappy with it, tell us through Help and we will put it right (see our Terms, section 11).</li>
          <li><B>Missed wash:</B> if the specialist could not reach your vehicle (it was not there, the gate was shut), the wash may be marked as missed. Please tell us as soon as you can; we will look at it fairly.</li>
        </Ul>
      </PolicySection>

      <PolicySection n={2} id="membership" title="A membership">
        <Ul>
          <li><B>Reschedule:</B> you can move any wash of your membership to another day inside your membership, at least 2 days ahead, from the membership page. There is no charge for this, and your other washes stay as they are.</li>
          <li><B>No single-wash cancelling:</B> a membership is paid for its whole term, so its washes cannot be cancelled one by one.</li>
          <li><B>Refunds:</B> a membership that has started is not refundable on request. If you think you should get money back (for example, we could not do the washes you paid for, or you are moving away), contact us. We look at each case fairly and, where we owe you, we refund the washes that were not done.</li>
        </Ul>
      </PolicySection>

      <PolicySection n={3} id="free" title="A free wash">
        <p>There is nothing to refund. If you cancel a free wash while the offer is still open, you can claim it again. A free wash that is missed may use up the offer, as the offer&rsquo;s page says.</p>
      </PolicySection>

      <PolicySection n={4} id="us" title="When WASHO cannot do your wash">
        <p>If we cancel or cannot do a wash (for example heavy rain, a day we are closed, or no specialist available), we will tell you and you can choose: we move it to a day that suits you, or we refund the <B>full amount</B> for that wash.</p>
      </PolicySection>

      <PolicySection n={5} id="charged" title="Charged but nothing booked">
        <p>If money left your account and the wash or membership was not created (for example your payment went through but the page closed), we will check it and either complete your booking or refund the full amount. You do not need to do anything, but if you are worried, contact us with the time and amount.</p>
      </PolicySection>

      <PolicySection n={6} id="how" title="How a refund is paid">
        <Rows
          rows={[
            ['Where it goes', <>Back to the payment method you used (the same UPI app, card or bank account), through Razorpay.</>],
            ['How long', <>Once WASHO approves the refund it usually reaches you in 5 to 7 working days, depending on your bank or UPI app.</>],
            ['How much', <>The full amount you paid for the wash. Any coupon you used stays applied, so you get back what you actually paid.</>],
            ['Not received?', <>Check with your bank first, then contact us with the wash reference (it looks like WSH-ABC123) and we will trace it with Razorpay.</>],
          ]}
        />
      </PolicySection>

      <PolicySection n={7} id="contact" title="Contact">
        <p>To cancel something we cannot cancel for you in the app, or to ask about a refund:</p>
        <Contact />
        <p>You can also raise it in <Link to="/app/help" className="font-semibold text-washo-300 hover:text-white">Help</Link> in the app. {LEGAL.name}, {LEGAL.place}.</p>
      </PolicySection>
    </LegalPage>
  );
}
