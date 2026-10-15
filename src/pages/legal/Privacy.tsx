import { Link } from 'react-router-dom';
import {B, Contact, LegalPage, PolicySection, Rows, Ul, type Section } from './Legal';
import { LEGAL } from './facts';

const SECTIONS: Section[] = [
  { id: 'who', title: 'Who we are' },
  { id: 'collect', title: 'What we collect' },
  { id: 'use', title: 'How we use it' },
  { id: 'share', title: 'Who we share it with' },
  { id: 'specialists', title: 'Our specialists and your privacy' },
  { id: 'cookies', title: 'Cookies, storage and tracking' },
  { id: 'keep', title: 'How long we keep it' },
  { id: 'safe', title: 'How we protect it' },
  { id: 'rights', title: 'Your choices and rights' },
  { id: 'delete', title: 'Deleting your account and data' },
  { id: 'children', title: 'Children' },
  { id: 'transfer', title: 'Where your data is processed' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact and grievances' },
];

/** The privacy policy: what WASHO collects, why, who else touches it, how long it is kept and how to get it deleted. Matches what the website's code actually does. */
export default function Privacy() {
  return (
    <LegalPage
      title="Privacy Policy"
      sections={SECTIONS}
      intro={
        <>
          <p>
            This policy explains what personal information {LEGAL.name} collects when you use our website ({LEGAL.site}) and our mobile apps (together, the <B>Service</B>), why we collect it, who else handles it, how long we keep it, and what you can do about it.
          </p>
          <p>
            In short: we collect what we need to wash your vehicle at your parking spot and take payment for it. <B>We do not sell your personal information, and we do not use it for advertising.</B> You can ask us to delete your account at any time (see section 10).
          </p>
        </>
      }
    >
      <PolicySection n={1} id="who" title="Who we are">
        <p>{LEGAL.name} is a doorstep car and bike washing service in {LEGAL.place}. In this policy, &ldquo;we&rdquo;, &ldquo;us&rdquo; and &ldquo;our&rdquo; mean {LEGAL.name}, which decides why and how your personal information is used (the &ldquo;data fiduciary&rdquo; under India&rsquo;s Digital Personal Data Protection Act, 2023). How to reach us is in section 14.</p>
      </PolicySection>

      <PolicySection n={2} id="collect" title="What we collect">
        <p>We collect only what the Service needs. Most of it comes from you; some is created when you use the Service.</p>
        <Rows
          head={['What', 'Details']}
          rows={[
            ['Account details', <>Your mobile number (it is how you sign in, with a one-time code sent by SMS), your name, and an email address if you give one. Our own staff (specialists and admins) have staff accounts with an email and password.</>],
            ['Address and parking', <>Your society, building or block, flat number, parking spot, and if you add them, the area, city and pincode. A specialist needs this to find your vehicle.</>],
            ['Vehicle details', <>The type (bike, car or SUV), make, model, colour and number plate of the vehicles you add.</>],
            ['Bookings and memberships', <>The services, dates and time windows you book, memberships and the washes in them, notes you add for the specialist, your wash history, and the ratings and reviews you leave.</>],
            ['Payments', <>The amount, status and the payment and order references from our payment provider, Razorpay, and any refund. <B>We do not see or store your card, UPI or bank details:</B> you enter them on Razorpay&rsquo;s secure checkout.</>],
            ['Photos', <>Photos of your vehicle taken by our specialist before and after a wash (they can show the number plate and the place it is parked), and pictures that WASHO attaches to a reply about a complaint.</>],
            ['Messages', <>Complaints you raise in Help, the replies, and what you tell us when you call or message us (including on WhatsApp).</>],
            ['Location (optional)', <>If you tap &ldquo;Use my current location&rdquo; when adding an address, your device shares its location once so we can suggest the address. <B>We do not store the coordinates and we never track your location in the background.</B> We send them to the OpenStreetMap Nominatim service only to turn them into an address.</>],
            ['Technical data', <>Standard server records (your IP address, browser or app type, the pages or actions requested, and the time) used to keep the Service secure and working, and cookies that keep you signed in (section 6).</>],
          ]}
        />
        <p>We do not ask for, and we do not knowingly collect, health information, biometric data, government ID numbers, your contacts, your messages on other apps, or your precise location in the background.</p>
      </PolicySection>

      <PolicySection n={3} id="use" title="How we use it">
        <Ul>
          <li><B>To provide the Service:</B> create and secure your account, send your sign-in code, schedule and carry out washes, show you your photos and history, take payments and refunds, and answer your complaints.</li>
          <li><B>To contact you about your wash or membership:</B> a call, an SMS, an email, an in-app notice or a WhatsApp message, for example to confirm a time, say that a wash was moved, or remind you before a membership ends.</li>
          <li><B>To keep the Service safe and fair:</B> prevent fraud and misuse, limit repeated attempts, and keep records of who did what in our own back-office.</li>
          <li><B>To improve the Service:</B> look at how many washes and memberships there are, how busy each day is, and your ratings, so we can plan our crew and fix problems. This is done on our own records, not with advertising or analytics trackers.</li>
          <li><B>To meet legal duties:</B> keep accounting and tax records, and respond to lawful requests.</li>
        </Ul>
        <p>We use your information because you ask us for the Service (so we need it to carry out the wash), because you agree (for example when you share your location), because we have a genuine business reason that does not override your privacy (security, fraud prevention), or because the law requires it.</p>
      </PolicySection>

      <PolicySection n={4} id="share" title="Who we share it with">
        <p><B>We do not sell your personal information. We do not share it with advertisers or data brokers.</B> We share it only with the people and companies below, and only as much as each needs.</p>
        <Rows
          head={['Who', 'What they do and what they receive']}
          rows={[
            ['Your specialist', <>The name, vehicle, address and parking spot for the wash they are doing, and your mobile number while that wash is live, so they can call you before they arrive (section 5).</>],
            ['Supabase', <>Hosts our database, sign-in and private file storage (your account, bookings and photos).</>],
            ['Render', <>Hosts our website and server.</>],
            ['Razorpay', <>Takes your payment and refunds it. Receives the amount, your name and mobile number or email as needed for the payment, and the payment details you type into its checkout.</>],
            ['2Factor', <>Sends the one-time sign-in code to your mobile number by SMS.</>],
            ['Resend', <>Sends our emails (for example a free-wash confirmation or a membership reminder) to the address you gave.</>],
            ['OpenStreetMap Nominatim', <>Receives the location you choose to share, only to return an address (section 2).</>],
            ['Authorities', <>If the law, a court or a government authority lawfully requires it, or to protect our rights, our customers or the public.</>],
            ['A buyer of the business', <>If WASHO is ever sold or merged, your information may move to the new owner, who must keep to this policy.</>],
          ]}
        />
        <p>The companies above act on our instructions and may use your information only to provide their service to us, except Razorpay, which is also responsible for its own payment records under its own policies.</p>
      </PolicySection>

      <PolicySection n={5} id="specialists" title="Our specialists and your privacy">
        <p>A specialist only sees the washes assigned to them. Your mobile number is shown to them only while a wash is live (not after it is finished, cancelled or taken from them), and the details of a wash that is no longer theirs are hidden. They take photos of your vehicle only to show the work and the condition of the vehicle, and those photos are visible to you and to WASHO.</p>
        <p>If you ask us to chat or call you, a WASHO team member may contact you from our business number about your wash.</p>
      </PolicySection>

      <PolicySection n={6} id="cookies" title="Cookies, storage and tracking">
        <p>We use only the cookies and browser storage the Service needs to work:</p>
        <Ul>
          <li><B>Sign-in cookies</B> (<code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">washo_at</code> and <code className="rounded bg-white/10 px-1.5 py-0.5 text-xs">washo_rt</code>): keep you signed in. They are secure, <em>httpOnly</em> cookies, which scripts cannot read. Staff sign-in also uses a signed cookie to remember the second step.</li>
          <li><B>Browser storage</B> (local and session storage): remembers small choices such as the filters you picked, so they are still there when you come back. It never leaves your device.</li>
          <li><B>Razorpay Checkout</B> loads from Razorpay when you pay, and Razorpay may set its own cookies.</li>
        </Ul>
        <p><B>We do not use advertising cookies, analytics or tracking tools, and we do not track you across other companies&rsquo; websites or apps.</B> We do not use your device&rsquo;s advertising identifier. You can block cookies in your browser, but then you cannot stay signed in.</p>
        <p>Where our mobile app asks for a device permission (for example camera, photos, notifications or location), it does so only for the feature that needs it, and you can refuse or take it back at any time in your phone&rsquo;s settings.</p>
      </PolicySection>

      <PolicySection n={7} id="keep" title="How long we keep it">
        <Rows
          head={['Information', 'How long']}
          rows={[
            ['Account, addresses, vehicles, bookings, photos, messages', <>While your account is open. When you ask us to delete your account we delete or anonymise them within {LEGAL.deletionDays} days (section 10).</>],
            ['Payment, invoice and refund records', <>For as long as the law requires us to keep accounting and tax records in India, which is usually up to 8 years. After you delete your account these are kept without the details that are not needed for that.</>],
            ['Complaints and support messages', <>While your account is open, and afterwards only as long as needed to settle a dispute, and then deleted or anonymised.</>],
            ['Sign-in codes', <>Valid for a few minutes. Our SMS provider may keep delivery records for a short period under its own policy.</>],
            ['Server and security records', <>For a short period, enough to find and fix problems and to prevent abuse.</>],
            ['Backups', <>Copies we keep for recovery are replaced on a regular cycle, so deleted information disappears from them within a short time.</>],
          ]}
        />
      </PolicySection>

      <PolicySection n={8} id="safe" title="How we protect it">
        <Ul>
          <li>Everything is sent over an encrypted (HTTPS) connection.</li>
          <li>Access is limited by role: a customer sees only their own data, a specialist only the washes they hold, and our admins only the parts of the back-office their role allows. Admin sign-in has a second step.</li>
          <li>Our database enforces these rules itself, not only the website. Photos are in private storage and are shown only through short-lived links to the people allowed to see them.</li>
          <li>Card, UPI and bank details never reach our servers: Razorpay handles them under its own security certification.</li>
          <li>Changes made by our team are recorded.</li>
        </Ul>
        <p>No system is perfectly secure. If we ever learn of a breach that affects your information, we will tell you and the authorities as the law requires.</p>
      </PolicySection>

      <PolicySection n={9} id="rights" title="Your choices and rights">
        <p>You can, at any time:</p>
        <Ul>
          <li><B>See and correct</B> your name, email, addresses and vehicles in Account and Vehicles in the app.</li>
          <li><B>Ask for a copy</B> of the personal information we hold about you, or ask us to correct it.</li>
          <li><B>Delete</B> your account and data (section 10).</li>
          <li><B>Withdraw your consent</B> to something you agreed to, such as sharing your location (just do not use the button), or ask us to stop reminder emails.</li>
          <li><B>Complain</B> to us (section 14) and, if you are not satisfied, to the Data Protection Board of India or another authority that applies to you.</li>
        </Ul>
        <p>To use any of these, <Link to="/app/help" className="font-semibold text-washo-300 hover:text-white">raise a request in Help</Link> or contact us (section 14). We may need to confirm it is you before we act, and we will reply within a reasonable time and in any case within the time the law sets.</p>
      </PolicySection>

      <PolicySection n={10} id="delete" title="Deleting your account and data">
        <p>You can delete your WASHO account whenever you like:</p>
        <Ul>
          <li><B>In the app or on the website:</B> sign in, open Account and choose <B>Delete my account</B>.</li>
          <li><B>Without signing in:</B> follow the steps on our <Link to="/delete-account" className="font-semibold text-washo-300 hover:text-white">Delete your account</Link> page.</li>
        </Ul>
        <p>Within {LEGAL.deletionDays} days we delete or anonymise your name, mobile number, email, addresses, vehicles, photos, messages and notifications, and close your sign-in. We keep only what the law requires us to keep (section 7). Deleting your account ends any membership on it, and washes still to come are cancelled (see our <Link to="/refund-policy" className="font-semibold text-washo-300 hover:text-white">Cancellation &amp; Refunds</Link> for money back).</p>
      </PolicySection>

      <PolicySection n={11} id="children" title="Children">
        <p>The Service is for adults who own or look after a vehicle. It is not meant for anyone under 18, and we do not knowingly collect information from children. If you believe a child has given us their information, tell us and we will delete it.</p>
      </PolicySection>

      <PolicySection n={12} id="transfer" title="Where your data is processed">
        <p>Our providers (section 4) run their systems in data centres that may be outside India. Where your information is processed outside India, we rely on providers that protect it to a standard comparable to this policy and to the law that applies to us.</p>
      </PolicySection>

      <PolicySection n={13} id="changes" title="Changes to this policy">
        <p>We may update this policy, for example when we add a feature or a provider. The date at the top shows when it last changed. If a change matters to you (for example a new reason to use your information), we will tell you in the app or by email before it starts. Using the Service after a change means you accept it.</p>
      </PolicySection>

      <PolicySection n={14} id="contact" title="Contact and grievances">
        <p>Questions, requests or a complaint about your privacy? Our Grievance Officer is the {LEGAL.name} team, who will reply as soon as possible:</p>
        <Contact />
        <p>{LEGAL.name}, {LEGAL.place}.</p>
      </PolicySection>
    </LegalPage>
  );
}
