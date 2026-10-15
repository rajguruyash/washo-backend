import { Link } from 'react-router-dom';
import { ButtonLink } from '../../components/ui/Button';
import {B, Contact, LegalPage, PolicySection, Rows, Ul, type Section } from './Legal';
import { LEGAL } from './facts';

const SECTIONS: Section[] = [
  { id: 'how', title: 'How to delete your account' },
  { id: 'what', title: 'What is deleted' },
  { id: 'kept', title: 'What we keep, and why' },
  { id: 'some', title: 'Deleting only some of your data' },
];

/** The public page that says how to delete a WASHO account and what that does. The Google Play and App Store listings link here. */
export default function DeleteAccount() {
  return (
    <LegalPage
      title="Delete your WASHO account"
      sections={SECTIONS}
      intro={
        <>
          <p>You can ask us to delete your {LEGAL.name} account and the personal information in it whenever you like. This page says how, and exactly what happens.</p>
          <p className="pt-1"><ButtonLink to="/login?next=%2Fapp%2Faccount%23delete">Sign in to delete my account</ButtonLink></p>
        </>
      }
    >
      <PolicySection n={1} id="how" title="How to delete your account">
        <Rows
          rows={[
            ['In the app or on the website', <>Sign in, open <B>Account</B>, scroll to <B>Delete my account</B> and confirm. We receive your request straight away and tell you when it is done.</>],
            ['If you cannot sign in', <>Email us from the address on your account, or call us, and give the mobile number registered with WASHO. We confirm it is you (for example by sending a code to that number) before we delete anything. <Contact /></>],
          ]}
        />
        <p>We finish the deletion within {LEGAL.deletionDays} days of your request.</p>
      </PolicySection>

      <PolicySection n={2} id="what" title="What is deleted">
        <p>When we delete your account we delete or anonymise:</p>
        <Ul>
          <li>your name, mobile number and email, and your sign-in;</li>
          <li>your saved addresses, parking spots and vehicles, including number plates;</li>
          <li>the photos taken of your vehicle and the pictures we attached to your complaints;</li>
          <li>your complaints, messages and notifications.</li>
        </Ul>
        <p>Any wash still to come is cancelled (a paid single wash is refunded in full, see <Link to="/refund-policy" className="font-semibold text-washo-300 hover:text-white">Cancellation &amp; Refunds</Link>), and an active membership ends. If you have a membership with washes left, please contact us before you delete so we can sort out money you may be owed.</p>
      </PolicySection>

      <PolicySection n={3} id="kept" title="What we keep, and why">
        <Ul>
          <li><B>Payment, invoice and refund records:</B> the law requires us to keep accounting and tax records, usually for up to 8 years. We keep only what is needed for that (the amount, date and payment reference), without your other details.</li>
          <li><B>Anything needed to settle a dispute or stop fraud:</B> only while it is needed, and then it is deleted.</li>
          <li><B>Backups:</B> copies kept for recovery are replaced on a regular cycle, so your deleted data disappears from them soon afterwards.</li>
        </Ul>
        <p>We never use what we keep for marketing. Our <Link to="/privacy" className="font-semibold text-washo-300 hover:text-white">Privacy Policy</Link> has the full picture.</p>
      </PolicySection>

      <PolicySection n={4} id="some" title="Deleting only some of your data">
        <p>You do not have to delete your whole account to remove something. You can delete a vehicle or an address in the app (Vehicles and Account), and you can ask us to erase specific photos or complaints by writing to us. <Contact /></p>
      </PolicySection>
    </LegalPage>
  );
}
