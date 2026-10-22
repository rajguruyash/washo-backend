import { LEGAL } from '../pages/legal/facts';
import { rupees } from './format';
import type { Catalog } from './types';

/**
 * The questions Woshi answers on the public site, and how a typed question is matched to one. There is NO model here and no network call: every answer is fixed text taken from what the
 * site itself says (the landing page, Terms, Cancellation & Refunds), plus the live rate card for prices when it has loaded. Anything that is not one of these gets a polite "I can only
 * answer questions about WASHO" and the list of questions, so there is nothing to manipulate and nothing it can get wrong that the pages do not already say.
 */
export interface FaqLink { label: string; to: string }

export interface Faq {
  id: string;
  /** What appears as the visitor's question when they tap its button. */
  question: string;
  /** A shorter word or two for the button itself (the buttons are few and small on a phone); the question is used when there is none. */
  chip?: string;
  /** Words or phrases that point to this answer. A phrase matches when every word of it is in the question, in any order; a longer phrase counts for more. A "+" in front marks one that is enough on its own (a plain single word is too vague to answer by itself). */
  keywords: string[];
  answer: (catalog?: Catalog) => string;
  links?: FaqLink[];
}

const phones = LEGAL.phones.join(' or ');

const SIGN_IN: FaqLink = { label: 'Sign in', to: '/login' };
const BUILD: FaqLink = { label: 'Build my membership', to: '/app/membership/new' };
const SERVICES: FaqLink = { label: 'See services', to: '/services' };
const REFUNDS: FaqLink = { label: 'Cancellation & Refunds', to: '/refund-policy' };
const CALL: FaqLink = { label: `Call ${LEGAL.phones[0]}`, to: `tel:${LEGAL.phones[0]}` };
const EMAIL: FaqLink = { label: 'Email us', to: `mailto:${LEGAL.email}` };

/** "Car Body Wash ₹150 · Car Deep Cleaning ₹…": one wash of each service, from the rate card. */
function priceList(catalog?: Catalog): string | null {
  const rows = (catalog?.services ?? []).flatMap((s) => {
    const cents = s.unit_prices?.find((p) => p.vehicle_type === s.vehicle_type)?.price_cents;
    return cents ? [`${s.name} ${rupees(cents)}`] : [];
  });
  return rows.length ? rows.join(' · ') : null;
}

/** How much notice a booking needs, as WASHO has set it (shown only when the rate card has loaded). */
function notice(catalog?: Catalog): string {
  const r = catalog?.booking_rules;
  if (!r) return '';
  const hours = r.on_demand_min_lead_hours;
  const days = r.membership_min_lead_days;
  return ` A single wash needs at least ${hours} hour${hours === 1 ? '' : 's'} of notice and a membership ${days} day${days === 1 ? '' : 's'}.`;
}

/** The order here is the order of the buttons, and the order that wins a tie. */
export const FAQS: Faq[] = [
  {
    id: 'about',
    question: 'What is WASHO?',
    keywords: ['what is washo', 'who are you', 'about washo', 'about you', 'tell me about', 'what are you', 'who is woshi', 'what is woshi', 'who is washo'],
    answer: () => `WASHO washes cars and bikes right at your parking spot, with no travel and no queues. You can book a single wash or a monthly membership. We currently serve societies in Kharadi, Pune, and I am Woshi, here to answer your questions.`,
    links: [SERVICES, BUILD],
  },
  {
    id: 'how',
    question: 'How does it work?',
    chip: 'How it works',
    keywords: ['+process', '+steps', 'how does it work', 'how does washo', 'how do you work', 'how it works', 'what happens next', 'how to use', '+kaise'],
    answer: () => 'Build a plan or book a single wash, then pay securely online with Razorpay. Your washes are scheduled as soon as the payment is verified. Your specialist calls before every wash, washes your vehicle at your parking spot, and you see the before and after photos.',
    links: [{ label: 'How it works', to: '/#how' }, BUILD],
  },
  {
    id: 'book',
    question: 'How do I book a wash?',
    keywords: ['+book', '+order', 'schedule wash', '+notice', 'in advance', 'same day', 'wash tomorrow', 'wash today', 'get started', 'how start'],
    answer: (c) => `Sign in with your mobile number (we send a one-time code, there is no password), then choose Book a single wash for one wash, or build a membership for regular washing. You pick your vehicle, the day and a time window, and pay online.${notice(c)}`,
    links: [SIGN_IN, BUILD],
  },
  {
    id: 'where',
    question: 'Where do you work?',
    chip: 'Where we work',
    keywords: ['where work', 'where are you', 'where do you', 'where available', '+area', '+location', '+locality', '+pune', '+kharadi', '+society', '+kahan', 'my area', 'near me', '+serve', '+cover', '+deliver'],
    answer: () => 'WASHO currently serves societies in Kharadi, Pune. We come to your own parking spot, so there is nothing to carry and no queue.',
  },
  {
    id: 'prices',
    question: 'What are your prices?',
    chip: 'Prices',
    keywords: ['+price', '+pricing', '+cost', '+rate', '+rates', 'how much', '+charge', '+fee', '+cheap', '+expensive', '+kitna', '+paisa', '+rupees', '+kimat', 'per wash', 'one wash'],
    answer: (c) => {
      const list = priceList(c);
      return `${list ? `One wash costs: ${list}. SUVs use the car Body wash rate and the SUV Deep cleaning rate.` : 'The Services page shows what each wash costs, and you always see the full price before you pay.'} For regular washing a membership is better value: its price is shown live as you build your plan, and a longer plan earns a bigger discount.`;
    },
    links: [SERVICES, BUILD],
  },
  {
    id: 'services',
    question: 'What services do you offer?',
    keywords: ['+services', 'what services', 'offer wash', '+body wash', '+deep clean', 'deep cleaning', '+interior', '+exterior', '+foam', 'what do you do', 'what you do', '+include', 'types of wash', 'kinds of wash', 'what you offer', 'what do you offer'],
    answer: (c) => {
      const names = [...new Set((c?.services ?? []).map((s) => s.name))];
      return `${names.length ? `We offer ${names.join(', ')}.` : 'We offer Body washes and Deep cleans.'} The Services page shows what each one includes.`;
    },
    links: [SERVICES],
  },
  {
    id: 'vehicles',
    question: 'Which vehicles do you wash?',
    keywords: ['+vehicle', '+suv', '+scooter', '+scooty', '+motorcycle', 'two wheeler', 'four wheeler', '+sedan', '+hatchback', '+gaadi', 'do you wash', 'can you wash', 'which car', 'which bike'],
    answer: () => 'Cars, SUVs and bikes. SUVs use the car Body wash rate and the SUV Deep cleaning rate, and a bike has Body washes only.',
    links: [SERVICES],
  },
  {
    id: 'membership',
    question: 'What is a membership?',
    chip: 'Memberships',
    keywords: ['+membership', '+subscription', '+subscribe', '+monthly', '+plan', '+package', 'per month', 'washes month', '+renew', '+renewal', 'how many washes', 'months'],
    answer: () => 'A membership is a monthly plan. You choose how many washes you want each month (4 to 28, any mix of Body washes and Deep cleans; a bike has Body washes only) and the days that suit you, for 1, 3, 6 or 12 months. You pay once, up front, and we schedule your washes automatically. It does not renew by itself: we send you a reminder before it ends.',
    links: [BUILD],
  },
  {
    id: 'windows',
    question: 'What time will you come?',
    keywords: ['+slot', '+timing', 'time window', 'what time', 'when will', 'when do you come', 'when come', '+arrive', '+kab', 'which time', '+morning', '+afternoon', '+night', '+evening', 'time'],
    answer: () => 'You choose a time window when you book: Morning 7:00 to 11:00 AM, Afternoon 12:00 to 4:00 PM, or Night 7:00 to 10:00 PM. Your specialist calls before they arrive.',
  },
  {
    id: 'days',
    question: 'Which days are you available?',
    keywords: ['which days', 'what days', '+sunday', '+weekend', '+holiday', 'working days', '+closed', 'availability', 'days available', 'open days', 'are you open', 'days', 'full'],
    answer: () => 'The booking page shows the days and time windows that are open. WASHO may be closed on some days, and a busy window may be full; the page then shows the next day you can book.',
  },
  {
    id: 'duration',
    question: 'How long does a wash take?',
    keywords: ['how long', '+duration', '+minutes', 'how many minutes', 'takes long', 'time taken', 'time take', 'wash take'],
    answer: (c) => {
      const rows = (c?.services ?? []).flatMap((s) => (s.duration_minutes ? [`${s.name} about ${s.duration_minutes} minutes`] : []));
      return rows.length ? `${rows.join(' · ')}.` : `It depends on the service. Please call ${LEGAL.phones[0]} and we will tell you.`;
    },
    links: [CALL],
  },
  {
    id: 'payment',
    question: 'How do I pay?',
    keywords: ['+upi', '+razorpay', 'razorpay safe', '+paytm', '+phonepe', '+gpay', 'google pay', 'net banking', '+netbanking', '+wallet', 'how pay', 'how to pay', 'payment method', 'payment options', 'pay online', '+payment', 'pay cash', '+cash', 'credit card', 'debit card', 'card'],
    answer: () => 'You pay online through Razorpay (UPI, cards, net banking or wallets). The price you see at checkout is the price you pay, and your wash or membership is confirmed once the payment succeeds. Please never share a card number, UPI PIN or OTP with anyone.',
  },
  {
    id: 'offers',
    question: 'Do you have coupons or offers?',
    keywords: ['+coupon', '+coupons', '+promo', 'promo code', '+offers', '+offer', '+discount', '+discounts', 'free wash', '+navratri', '+cashback', '+deal', '+deals', 'free', 'code'],
    answer: () => 'Sometimes. If you have a coupon code, type it where it says "Have a coupon?" on the payment step of a booking or a plan, or on the booking card in Woshi\'s chat once you are signed in. When WASHO has a free wash or another offer running, you will see a banner at the top of this website.',
  },
  {
    id: 'cancel',
    question: 'Can I cancel or reschedule?',
    chip: 'Cancel or reschedule',
    keywords: ['+cancel', '+cancellation', '+reschedule', '+postpone', 'cancel booking', 'cancel wash', 'cancel my', 'change date', 'change time', 'change slot', 'move wash', 'move my wash', 'shift wash', 'different day', 'another day', 'other day'],
    answer: () => 'A single wash can be cancelled any time before the specialist starts it, with no fee, and if you paid you get the full amount back. A membership wash can be moved to another day inside your membership, free of charge, at least 2 days ahead; membership washes cannot be cancelled one by one.',
    links: [REFUNDS],
  },
  {
    id: 'refund',
    question: 'How do refunds work?',
    keywords: ['+refund', '+refunds', 'money back', 'get money', 'return money', '+refunded', '+deducted', '+debited', 'double charged', '+wapas', 'charged twice', 'charged but', 'was charged'],
    answer: () => 'A refund goes back to the payment method you used, through Razorpay, and usually reaches you 5 to 7 working days after WASHO approves it. If you were charged but nothing was booked, we check it and either complete your booking or refund you in full. A membership that has started is not refundable on request, but contact us if we could not do the washes you paid for.',
    links: [REFUNDS, CALL],
  },
  {
    id: 'rain',
    question: 'What if it rains or you cannot come?',
    keywords: ['+rain', '+raining', '+weather', '+monsoon', 'cannot come', 'cant come', 'no show', 'did not come', 'didnt come', 'not come', '+delayed', 'missed wash', 'specialist late', 'late'],
    answer: () => 'If we cancel or cannot do a wash (for example heavy rain, a day we are closed or no specialist available), we will tell you and you can choose: we move it to a day that suits you, or we refund the full amount for that wash.',
    links: [REFUNDS],
  },
  {
    id: 'access',
    question: 'What if my vehicle is not there?',
    keywords: ['not there', 'not home', 'not available', '+travelling', '+traveling', 'out of town', '+gate', '+locked', '+keys', 'be present', 'be there', 'need to be', '+basement', '+parking', 'car not', 'vehicle not', 'i am away', 'not around'],
    answer: () => 'Please make sure the vehicle is where you said it would be and that the specialist can reach it (unlocked if needed). If they cannot, because the car is not there or the gate is shut, the wash may be marked as missed and we may not be able to repeat it without a new booking, so tell us as soon as you can.',
    links: [CALL],
  },
  {
    id: 'photos',
    question: 'Do I get photos of the wash?',
    keywords: ['+photo', '+photos', '+picture', '+pictures', 'before after', '+proof', '+images'],
    answer: () => 'Yes. Your specialist takes before and after photos of every wash, and you can see them in your account.',
  },
  {
    id: 'safe',
    question: 'Is it safe for my vehicle?',
    keywords: ['+safe', 'safe for', '+paint', '+scratch', '+chemicals', '+microfibre', '+microfiber', '+eco', 'eco friendly', '+products', '+damage', 'water use', 'use water', 'quality', 'harm'],
    answer: () => 'We use microfibre cloths and pH-balanced foam, and a pressure and foam wash that saves water. If anything goes wrong, tell us through Help in your account (photos help) or call us, and we will look into it and put it right, which may mean redoing the wash, a repair or a refund.',
    links: [CALL],
  },
  {
    id: 'team',
    question: 'Who are your specialists?',
    keywords: ['+specialist', '+staff', '+crew', '+worker', 'who washes', 'who wash', 'who will wash', 'who comes', 'who will come', '+verified', '+trusted', 'background check', 'who are the', 'your team'],
    answer: () => 'A verified crew of skilled professionals who are known to your society. Your specialist calls you before the wash.',
  },
  {
    id: 'account',
    question: 'How do I sign in?',
    keywords: ['sign in', '+signin', 'log in', '+login', '+register', '+password', '+otp', 'create account', 'sign up', 'mobile number', 'phone number', 'how login', 'my account', 'account'],
    answer: () => 'You sign in with your mobile number and a one-time code, so there is no password to remember. It takes a minute, and then you can book, pay and see all your washes.',
    links: [SIGN_IN],
  },
  {
    id: 'delete',
    question: 'How do I delete my account?',
    keywords: ['delete account', 'delete my account', 'remove account', 'close account', 'delete data', 'delete my data', 'my data', '+privacy', 'personal data', 'remove my data'],
    answer: () => `Sign in, open Account, scroll to Delete my account and confirm. We finish the deletion within ${LEGAL.deletionDays} days of your request. The Delete your account page explains what is removed.`,
    links: [{ label: 'Delete your account', to: '/delete-account' }, { label: 'Privacy Policy', to: '/privacy' }],
  },
  {
    id: 'contact',
    question: 'How can I contact you?',
    chip: 'Contact us',
    keywords: ['+contact', '+whatsapp', '+email', '+sampark', 'phone number', 'talk to', 'speak to', '+human', '+complaint', '+complain', 'customer care', 'customer service', 'your number', 'call you', 'contact number', 'reach you', 'get in touch', 'owner', 'support', 'help'],
    answer: () => `Call ${phones}, or email ${LEGAL.email}. We are in ${LEGAL.place.split(',').slice(0, 2).join(',')}. If you are signed in, you can also raise a complaint under Help in your account.`,
    links: [CALL, EMAIL],
  },
];

/** The buttons shown to begin with, and after an answer (without the question just answered). */
const START = ['how', 'prices', 'membership', 'where', 'cancel', 'contact'];
export const startingQuestions = (except?: string): Faq[] => START.filter((id) => id !== except).map((id) => FAQS.find((f) => f.id === id)!);

export const byId = (id: string): Faq | undefined => FAQS.find((f) => f.id === id);

// ───────────────────────── matching ─────────────────────────
/** A small stemmer applied to both the question and the keywords, so "washes", "washing" and "wash", or "cancelled" and "cancel", meet. */
const stem = (word: string): string => {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (/(ches|shes|xes|sses|zes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  if (/([b-df-hj-np-tv-z])\1$/.test(w)) w = w.slice(0, -1);
  return w;
};

const tokens = (text: string): string[] =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(stem);

/** Each keyword as its stems, and what a match is worth: its number of words, or 2 for a "+" keyword (enough on its own). Keywords that come to the same stems ("book", "booking") are one. */
const KEYS = new Map(
  FAQS.map((f) => {
    const own = new Map<string, { t: string[]; worth: number }>();
    for (const k of f.keywords) {
      const strong = k.startsWith('+');
      const t = tokens(strong ? k.slice(1) : k);
      const worth = strong ? Math.max(2, t.length) : t.length;
      const key = t.join(' ');
      if (t.length && (own.get(key)?.worth ?? 0) < worth) own.set(key, { t, worth });
    }
    return [f.id, [...own.values()]];
  })
);

/** How well each question fits what was typed (0 = not at all), best first. */
export function rank(text: string): { faq: Faq; score: number }[] {
  const words = new Set(tokens(text));
  return FAQS.map((faq, order) => ({ faq, order, score: KEYS.get(faq.id)!.reduce((n, k) => (k.t.length && k.t.every((w) => words.has(w)) ? n + k.worth : n), 0) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ faq, score }) => ({ faq, score }));
}

export interface FaqReply {
  text: string;
  links?: FaqLink[];
  /** Buttons to offer next. */
  next: Faq[];
}

/** The reply to a question that was tapped (so it is exactly that one). */
export const answerFor = (faq: Faq, catalog?: Catalog): FaqReply => ({ text: faq.answer(catalog), links: faq.links, next: startingQuestions(faq.id) });

const GREETING = /^(hi+|hello+|hey+|hola|namaste|namaskar|good (morning|afternoon|evening)|yo|hii+)$/;
const THANKS = /^(thanks?|thank you|thx|ty|ok|okay|cool|great|nice|awesome|got it|fine|perfect|alright)( (thanks?|you|a lot|so much))?$/;
const QUIET = new Set(['woshi', 'washo', 'there', 'bro', 'dear', 'sir', 'madam', 'team']);

/**
 * What to say to something typed. A clear match gets its answer; two equally good matches (or only a weak one) get "did you mean" with those questions as buttons; a greeting or thanks gets a
 * friendly word; anything else gets the plain statement that this is all Woshi can help with here, and the questions he can answer.
 */
export function replyTo(input: string, catalog?: Catalog): FaqReply {
  // "hi" and "thanks" are whole messages, so they are recognised first ("good morning" is not a question about the morning window)
  const plain = input.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w && !QUIET.has(w)).join(' ');
  if (GREETING.test(plain)) return { text: "Hi! I'm Woshi. I can answer questions about WASHO: our services, prices, memberships and how booking works. Tap a question below or type your own.", next: startingQuestions() };
  if (THANKS.test(plain)) return { text: "You're welcome! Is there anything else you would like to know about WASHO?", next: startingQuestions() };

  const ranked = rank(input);
  const best = ranked[0];
  if (best && best.score >= 2 && (!ranked[1] || ranked[1].score < best.score)) return answerFor(best.faq, catalog);
  if (best) {
    // a tie at the top, or only a weak match: offer the likely ones instead of guessing
    const top = ranked.filter((r) => r.score === best.score).slice(0, 3);
    return { text: top.length === 1 ? 'Did you mean this one?' : 'I am not sure which one you mean. Is it one of these?', next: top.map((r) => r.faq) };
  }
  return { text: `I can only answer questions about WASHO, like our services, prices, memberships and how booking works. Tap one below, or call us on ${phones}.`, links: [CALL], next: startingQuestions() };
}
