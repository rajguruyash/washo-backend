import { Link } from 'react-router-dom';
import {B, Contact, LegalPage, PolicySection, Ul, type Section } from './Legal';
import { LEGAL } from './facts';

const SECTIONS: Section[] = [
  { id: 'accept', title: 'Using WASHO' },
  { id: 'service', title: 'The service' },
  { id: 'account', title: 'Your account' },
  { id: 'booking', title: 'Bookings, prices and payment' },
  { id: 'membership', title: 'Memberships' },
  { id: 'offers', title: 'Free washes and offers' },
  { id: 'changes', title: 'Rescheduling, cancelling and refunds' },
  { id: 'access', title: 'Your vehicle, parking and access' },
  { id: 'photos', title: 'Photos' },
  { id: 'conduct', title: 'How to use the service' },
  { id: 'liability', title: 'Our responsibility' },
  { id: 'ending', title: 'Suspending or closing an account' },
  { id: 'terms-change', title: 'Changes to these terms' },
  { id: 'law', title: 'Governing law' },
  { id: 'contact', title: 'Contact' },
];

/** The rules of using WASHO: bookings, payment, memberships, access to the vehicle, and what each side is responsible for. */
export default function Terms() {
  return (
    <LegalPage
      title="Terms of Service"
      sections={SECTIONS}
      intro={
        <p>
          These terms are the agreement between you and {LEGAL.name} when you use our website ({LEGAL.site}) or our mobile apps (the <B>Service</B>). By creating an account, booking a wash or paying, you agree to them and to our <Link to="/privacy" className="font-semibold text-washo-300 hover:text-white">Privacy Policy</Link>. If you do not agree, please do not use the Service.
        </p>
      }
    >
      <PolicySection n={1} id="accept" title="Using WASHO">
        <p>You must be at least 18 and able to enter into a contract in India. You confirm that the information you give us is true and that you own the vehicle you add, or are allowed by its owner to have it washed.</p>
      </PolicySection>

      <PolicySection n={2} id="service" title="The service">
        <p>{LEGAL.name} washes cars and bikes at the parking spot you give us, in the areas we serve (currently {LEGAL.place}). You can book a single wash or a membership. The washes include what is described for each service on our website and in the app. We may change, add or stop a service or an area, and we will not affect a wash you have already paid for without offering you a fair alternative.</p>
      </PolicySection>

      <PolicySection n={3} id="account" title="Your account">
        <p>You sign in with your mobile number and a one-time code. Keep your phone and your account to yourself: you are responsible for what is done through your account. Tell us at once if you think someone else is using it. Please keep your name, address and vehicle details up to date so the specialist can find you.</p>
      </PolicySection>

      <PolicySection n={4} id="booking" title="Bookings, prices and payment">
        <Ul>
          <li>Prices are shown in rupees before you pay, and the price shown at checkout is the price you pay. Any discount or coupon is shown as its own line.</li>
          <li>You pay online through Razorpay (UPI, cards, net banking or wallets). Your wash or membership is confirmed when the payment succeeds. If you are charged and nothing is booked, we will refund you in full.</li>
          <li>Times are given as windows (morning, afternoon, night), not exact minutes. A specialist usually calls before they arrive.</li>
          <li>A busy day or time window may be full and cannot be booked. WASHO may also be unavailable on some days, and the booking page then shows the next day you can book.</li>
          <li>A vehicle can be washed once a day.</li>
        </Ul>
      </PolicySection>

      <PolicySection n={5} id="membership" title="Memberships">
        <p>A membership is paid for the whole term (1, 3, 6 or 12 months) and gives you a set number of washes each month, scheduled on the days you choose. Its washes can be rescheduled but not cancelled one by one (see section 7). A membership ends at the end of its term, and we may send you a reminder before it does. It does not renew by itself.</p>
      </PolicySection>

      <PolicySection n={6} id="offers" title="Free washes and offers">
        <p>A free wash or other offer has its own conditions, shown on its page (for example who can claim it, how many are available, and how long it is open). It is for the person and vehicle who claim it, cannot be exchanged for money, and ends when its conditions say it does. We may end an offer early if it is misused.</p>
      </PolicySection>

      <PolicySection n={7} id="changes" title="Rescheduling, cancelling and refunds">
        <p>You can reschedule a membership wash from the app. You can cancel a single wash before it starts, and if you paid for it you get your full payment back. The details, including timings, are in our <Link to="/refund-policy" className="font-semibold text-washo-300 hover:text-white">Cancellation &amp; Refunds</Link> policy, which is part of these terms.</p>
      </PolicySection>

      <PolicySection n={8} id="access" title="Your vehicle, parking and access">
        <Ul>
          <li>Please make sure the vehicle is where you said it would be, unlocked if needed, and that the specialist can reach it. If they cannot (the car is not there, the gate is shut), the wash may be marked as missed and we may not be able to repeat it without a new booking.</li>
          <li>Tell us about anything that matters: existing damage, loose parts, a wet-sensitive area. A specialist may decline to wash a vehicle if it is unsafe or if the work could harm it, and will tell you why.</li>
          <li>You allow our specialist to enter your society&rsquo;s parking area to reach your vehicle, and you will arrange any pass or permission your society needs.</li>
        </Ul>
      </PolicySection>

      <PolicySection n={9} id="photos" title="Photos">
        <p>Our specialist photographs your vehicle before and after a wash to show the work and its condition. You and WASHO can see them. You agree to us taking and keeping these photos as described in the Privacy Policy. If you think a photo was taken of something that should not be in it, tell us and we will remove it.</p>
      </PolicySection>

      <PolicySection n={10} id="conduct" title="How to use the service">
        <p>Please do not misuse the Service. In particular, do not give false information, use someone else&rsquo;s account or payment method without permission, try to break or bypass how the Service works, claim an offer you are not entitled to, or be abusive to our specialists or team. A specialist may leave a job if they are threatened or abused.</p>
      </PolicySection>

      <PolicySection n={11} id="liability" title="Our responsibility">
        <p>We take reasonable care and use suitable products and methods. If we damage your vehicle or do a poor job, tell us as soon as you can through Help in the app (with photos if you have them) and we will look into it and put it right, which may mean redoing the wash, a repair or a refund.</p>
        <p>We are not responsible for damage that was already there, wear and tear, or loss we could not reasonably have foreseen. Except for anything the law does not allow us to limit, our total responsibility to you for any one wash or membership is limited to the amount you paid for it. Nothing in these terms limits your rights as a consumer under Indian law.</p>
      </PolicySection>

      <PolicySection n={12} id="ending" title="Suspending or closing an account">
        <p>You can stop using WASHO and delete your account at any time (see <Link to="/delete-account" className="font-semibold text-washo-300 hover:text-white">Delete your account</Link>). We may suspend or close an account that breaks these terms or is used to cheat or harm others, and we will tell you why where we can. Money you are owed for washes we did not do will still be refunded.</p>
      </PolicySection>

      <PolicySection n={13} id="terms-change" title="Changes to these terms">
        <p>We may change these terms. The date at the top shows the latest version. If a change matters to you we will tell you in the app or by email first. A change does not affect a wash you have already paid for. Using the Service after a change means you accept it.</p>
      </PolicySection>

      <PolicySection n={14} id="law" title="Governing law">
        <p>These terms are governed by the laws of India. The courts at Pune, Maharashtra, can hear any dispute about them, without taking away any right you have to go to a consumer forum that has authority over you.</p>
      </PolicySection>

      <PolicySection n={15} id="contact" title="Contact">
        <p>Questions about these terms? Reach us at:</p>
        <Contact />
        <p>{LEGAL.name}, {LEGAL.place}.</p>
      </PolicySection>
    </LegalPage>
  );
}
