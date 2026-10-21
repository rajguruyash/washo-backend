import { cleanData } from './guards';
import type { Actor } from './run';
import type { Conversation, RuleState } from './store';
import { istToday, refreshHandles, runTool, SLOTS, type AddressRow, type ToolCtx, type VehicleRow } from './tools';
import type { Card, ChatResult } from './types';

/**
 * SIMPLE MODE. When no language model can be reached (every free service is out of allowance or down, none is set up, or AGENT_MODE=rules), Woshi does not stop: it guides the customer with
 * fixed questions and tappable answers, in plain code, with no model at all. It books exactly as the model does, and only through the same tools: the same rules about days, windows, plans
 * and prices, the same server-built card, the same slide to pay. So it can do nothing the model cannot, and it says only fixed sentences plus numbers and names that the tools returned
 * (it never repeats what the customer typed, except into a card for them to check).
 */
export type RuleInput = { text: string } | { saved: 'vehicle' | 'address' };

type Opt = { label: string; value: string };
interface Env { actor: Actor; conv: Conversation; st: RuleState; ctx: ToolCtx; vs: VehicleRow[]; as: AddressRow[]; handoff: boolean }
type Reply = ChatResult;

export const freshRules = (reason: 'down' | 'tap' = 'down'): RuleState => ({ reason, flow: null, step: 'menu', data: {}, opts: [], prompt: '', resume: null, since: Date.now(), announced: reason === 'tap' });

/** A booking was paid: simple mode goes back to its menu (and the model is tried again after a while). */
export function finishRules(conv: Conversation) {
  const r = conv.rules;
  if (!r) return;
  r.flow = null;
  r.step = 'menu';
  r.data = {};
  r.opts = [];
  r.prompt = '';
  r.resume = null;
}

const SIMPLE_NOTE = "My smart replies are unavailable right now, so I'll guide you step by step with simple options.";
const MENU: Opt[] = ['Book a single wash', 'Start a membership', 'Add a vehicle', 'Prices', 'How does it work?', 'Contact WASHO'].map((l) => ({ label: l, value: l }));
const START_OVER: Opt = { label: 'Start over', value: '__menu' };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_WORDS: [RegExp, number][] = [[/\bsun(day)?\b/, 0], [/\bmon(day)?\b/, 1], [/\btue(s|sday)?\b/, 2], [/\bwed(nesday)?\b/, 3], [/\bthu(r|rs|rsday)?\b/, 4], [/\bfri(day)?\b/, 5], [/\bsat(urday)?\b/, 6]];
const CONTACT = 'Call 8668890147 or 9172792929, or email contact.washo@gmail.com.';
const TROUBLE = 'I could not check that just now. Please try again in a moment, or use the Book and Plans screens.';

const norm = (t: string) => t.toLowerCase().normalize('NFKC').replace(/[&]/g, ' ').replace(/[^a-z0-9ऀ-ॿ\s]/g, ' ').replace(/\s+/g, ' ').trim();
const parseDays = (t: string): number[] => [...new Set(DAY_WORDS.filter(([re]) => re.test(t)).map(([, n]) => n))];
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const withStartOver = (opts: Opt[]) => [...opts, START_OVER];

/** How many slips (a letter added, missed or changed, or two neighbours swapped) separate two words: vehichle, sinlge. */
function slips(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
const KEYWORDS = ['vehicle', 'vehicles', 'membership', 'single', 'booking', 'price', 'prices', 'contact', 'scooter', 'monthly', 'subscription', 'support', 'refund', 'reschedule', 'complaint', 'thanks', 'hello', 'another'];
/** A word of five letters or more that is one or two slips away from a word we look for is read as that word. */
const fixTypos = (t: string) =>
  t
    .split(' ')
    .map((w) => (w.length < 5 || KEYWORDS.includes(w) ? w : KEYWORDS.find((k) => Math.abs(k.length - w.length) <= 2 && slips(w, k) <= (w.length >= 7 ? 2 : 1)) ?? w))
    .join(' ');

// ───────────────────────── what kind of vehicle someone means ─────────────────────────
const SUV_WORDS = /\b(suv|suvs|xuv\w*|scorpio|fortuner|thar|innova|harrier|safari|hector|bolero|ertiga)\b/;
const BIKE_WORDS = /\b(bike|bikes|scooter|scooty|motorcycle|moped|two wheeler|activa|chetak|splendor|pulsar|jupiter|ntorq|access|bullet|classic|duke|apache|fascino|dio|hunter|shine|unicorn)\b/;
const CAR_WORDS = /\b(car|cars|sedan|hatchback|swift|baleno|i20|nexon|punch|creta|city|verna|dzire|wagon ?r|alto|polo|seltos|brezza)\b/;
const vehicleKind = (t: string): 'bike' | 'car' | 'suv' | null => (SUV_WORDS.test(t) ? 'suv' : BIKE_WORDS.test(t) ? 'bike' : CAR_WORDS.test(t) ? 'car' : null);
/** Words that say what a vehicle is or fill a sentence, so that "type bike model chetak" leaves just "chetak". */
const FILLER = new Set(['type', 'model', 'make', 'name', 'is', 'my', 'a', 'an', 'the', 'it', 'its', 'of', 'i', 'have', 'want', 'add', 'new', 'and', 'called', 'named', 'vehicle', 'bike', 'bikes', 'car', 'cars', 'suv', 'scooter', 'motorcycle', 'sedan', 'hatchback', 'two', 'wheeler']);
const COLOURS = ['White', 'Black', 'Silver', 'Grey', 'Red', 'Blue'];
const MAKES: Record<string, string[]> = {
  bike: ['Honda Activa', 'TVS Jupiter', 'Bajaj Chetak', 'Royal Enfield Classic'],
  car: ['Maruti Swift', 'Hyundai Creta', 'Tata Nexon', 'Hyundai i20'],
  suv: ['Mahindra XUV700', 'Toyota Fortuner', 'Mahindra Thar', 'Tata Harrier'],
};

/** The buttons the rules offer from the start (and after a payment): a message that is exactly one of them needs no model. */
const TAPS = new Set([...MENU.map((o) => norm(o.label)), 'book another wash', 'thanks']);
export const isTap = (text: string): boolean => TAPS.has(norm(text));

/** A short command the rules follow ("add vehichle", "single wash", "prices"): up to four words that mean one of the things the menu offers. Longer sentences are the model's. */
export const isCommand = (text: string): boolean => {
  const t = fixTypos(norm(text));
  return t.split(' ').length <= 4 && intentOf(t) !== null;
};

/** The tappable answer this text means, if exactly one (the full label, or a clear part of it). */
function pick(opts: Opt[], text: string): Opt | undefined {
  const t = norm(text);
  if (!t) return undefined;
  const exact = opts.find((o) => norm(o.label) === t || norm(o.value) === t);
  if (exact) return exact;
  const hits = opts.filter((o) => {
    const l = norm(o.label);
    return l.length >= 3 && (t.includes(l) || (t.length >= 3 && l.includes(t)));
  });
  return hits.length === 1 ? hits[0] : undefined;
}

function say(st: RuleState, reply: string, opts: Opt[] = [], cards: Card[] = [], step = st.step): Reply {
  st.step = step;
  st.opts = opts;
  st.prompt = reply;
  return { reply, cards, quick_replies: opts.map((o) => o.label) };
}

const toMenu = (env: Env, reply = 'What would you like to do?'): Reply => {
  env.st.flow = null;
  env.st.data = {};
  env.st.resume = null;
  return say(env.st, reply, MENU, [], 'menu');
};

type Called = { ok: true; data: any } | { ok: false; code: string; message: string };
async function call(env: Env, name: string, input: Record<string, unknown>): Promise<Called> {
  const r = await runTool(name, input, env.ctx);
  let body: any = {};
  try { body = JSON.parse(r.content); } catch { /* not JSON */ }
  return r.isError ? { ok: false, code: String(body.error ?? 'unavailable'), message: String(body.message ?? '') } : { ok: true, data: body };
}

const vehicleLabel = (v: VehicleRow) => {
  const tail = v.registration_number.replace(/[^A-Za-z0-9]/g, '').slice(-4).toUpperCase();
  return `${cleanData([v.make, v.model].filter(Boolean).join(' '), 30)}${tail ? ` · ${tail}` : ''}`;
};

// ───────────────────────── what the customer can ask for ─────────────────────────
type Intent = 'single' | 'membership' | 'vehicle' | 'prices' | 'info' | 'contact' | 'help' | 'thanks' | 'hello';
function intentOf(t: string): Intent | null {
  if (/\b(cancel|refund|reschedul|complain|complaint|rating|review|invoice|receipt)\w*\b/.test(t) && !/^cancel$/.test(t)) return 'help';
  if (/\bmembership|monthly|subscription|\bplan\b|\bplans\b/.test(t)) return 'membership';
  if (/(add|new|save|register)\b.{0,15}\b(vehicles?|car|bike|scooter|activa|suv)\b|\bmy (car|bike|vehicle)\b/.test(t)) return 'vehicle';
  if (/\bprices?\b|\bcost|\brates?\b|\bcharges?\b|\bhow much\b|\bfees?\b/.test(t)) return 'prices';
  if (/how (does|do|is).{0,20}(work|it)|how it works|what is washo|what do you do/.test(t)) return 'info';
  if (/\bcontact\b|\bcall\b|\bphone\b|\bsupport\b|\bhelp\b|\bemail\b|\bnumber\b/.test(t)) return 'contact';
  if (/\bsingle\b|\bone time\b|\bbook\b|\bwash\b|\bclean\b|\bbooking\b|\banother\b/.test(t)) return 'single';
  if (/\bthank|\bthanks\b|\bok(ay)?\b|\bgreat\b|\bbye\b/.test(t)) return 'thanks';
  if (/^(hi|hello|hey|hii+|namaste|namaskar)\b/.test(t)) return 'hello';
  return null;
}

// ───────────────────────── entry points ─────────────────────────
/** `handoff`: a model is available, so words the rules do not understand are given back (null) instead of answered with the question again. */
export async function ruleTurn(actor: Actor, conv: Conversation, input: RuleInput, o: { handoff?: boolean } = {}): Promise<ChatResult | null> {
  const st = (conv.rules ??= freshRules());
  const ctx: ToolCtx = {
    db: actor.db, sub: actor.sub, now: new Date(), today: istToday(new Date()), handles: conv.handles,
    amounts: conv.amounts, percents: conv.percents, cards: [], quick: [],
    keepCard: (c: Card) => void conv.cards.set(c.id, c),
  };
  let r: Reply | null;
  try {
    const { vs, as } = await refreshHandles(actor.db, conv.handles);
    const env: Env = { actor, conv, st, ctx, vs, as, handoff: Boolean(o.handoff) };
    r = 'saved' in input ? await onSaved(env, input.saved) : await onText(env, input.text);
  } catch (err) {
    console.error('Woshi simple mode failed:', err instanceof Error ? err.message : err);
    r = toMenu({ actor, conv, st, ctx, vs: [], as: [], handoff: false }, TROUBLE);
  }
  if (r === null) return null;
  if (!st.announced) r = { ...r, reply: `${SIMPLE_NOTE} ${r.reply}` }; // said once, at the start of simple mode
  st.announced = true;
  return r;
}

async function onText(env: Env, text: string): Promise<Reply | null> {
  const { st } = env;
  const t = fixTypos(norm(text));
  if (!t) return again(env);
  if (/^(menu|main menu|start over|restart|reset|cancel|back|home|stop|exit)$/.test(t)) return toMenu(env);
  if (st.flow || st.step === 'done') {
    const r = await answer(env, text, t);
    if (r) return r;
  }
  const intent = intentOf(t);
  if (intent) return begin(env, intent);
  if (!st.flow && st.step === 'menu') {
    const chosen = pick(MENU, text);
    if (chosen) return begin(env, intentOf(norm(chosen.label)) ?? 'hello');
  }
  // the customer typed something the rules do not follow: with a model available it is theirs to answer (this booking is set aside)
  // (never in the middle of a booking: that carries on with its question and buttons)
  if (env.handoff && st.reason === 'tap' && !st.flow) return null;
  return again(env);
}

/** What was not understood: the question again, with its answers to tap. */
function again(env: Env): Reply {
  const { st } = env;
  if (!st.prompt || st.step === 'menu') return toMenu(env, "I can only follow the options below in simple mode. What would you like to do?");
  return say(st, `Please tap one of the options. ${st.prompt.replace(/^Please tap one of the options\. /, '')}`, st.opts, [], st.step);
}

async function begin(env: Env, intent: Intent): Promise<Reply> {
  const { st } = env;
  switch (intent) {
    case 'single':
    case 'membership':
      st.flow = intent;
      st.data = {};
      st.resume = null;
      return advance(env);
    case 'vehicle':
      st.flow = 'vehicle';
      st.data = {};
      st.resume = null;
      return askVehicleType(env);
    case 'prices':
      return prices(env);
    case 'info':
      return toMenu(env, `WASHO washes your car or bike where it is parked, in the societies of Kharadi, Pune. Pick a day and a time window (${SLOTS.map((s) => `${s.label} ${s.hours}`).join(', ')}); a specialist calls before every wash and takes before and after photos. A membership is paid once, up front, and its washes are scheduled for you. What would you like to do?`);
    case 'contact':
      return toMenu(env, `${CONTACT} What else can I do for you?`);
    case 'help':
      return toMenu(env, `Cancelling, rescheduling, refunds, ratings and complaints are in the Washes and Help sections of the app, or by phone. ${CONTACT}`);
    case 'thanks':
      return toMenu(env, "You're welcome! Anything else?");
    default:
      return toMenu(env, 'Hi! What would you like to do?');
  }
}

async function prices(env: Env): Promise<Reply> {
  const c = await call(env, 'get_catalog', {});
  if (!c.ok) return toMenu(env, TROUBLE);
  const lines = (c.data.services as { name: string; price_rupees: Record<string, number> }[])
    .slice(0, 8)
    .map((s) => `• ${s.name}: ${Object.entries(s.price_rupees).map(([t, p]) => `${t} ₹${p}`).join(', ')}`);
  const disc = Object.entries((c.data.membership?.length_discount_percent ?? {}) as Record<string, number>).filter(([, p]) => p > 0).map(([m, p]) => `${m} months ${p}% off`);
  return toMenu(env, `${lines.join('\n')}${disc.length ? `\nMembership discounts for a longer plan: ${disc.join(', ')}.` : ''}\nWhat would you like to do?`);
}

// ───────────────────────── a vehicle or an address, added from the chat ─────────────────────────
function askVehicleType(env: Env): Reply {
  const opts = withStartOver(['Car', 'Bike', 'SUV'].map((l) => ({ label: l, value: l.toLowerCase() })));
  return say(env.st, 'What type of vehicle is it? Tap one, or type it (car, bike or SUV).', opts, [], 'vtype');
}

function askVehicleName(env: Env, note = ''): Reply {
  const opts = withStartOver((MAKES[env.st.data.vtype] ?? MAKES.car).map((l) => ({ label: l, value: l })));
  return say(env.st, note + 'Tap your vehicle, or type its make and model (for example Hyundai Creta). You will type the registration number on the card.', opts, [], 'vname');
}

/** "Hyundai Creta" becomes make Hyundai and model Creta; one word is the model. Then the colour is asked: it helps the specialist find the vehicle. */
function takeVehicleName(env: Env, raw: string): Reply | null {
  const words = cleanData(raw, 60).split(' ').filter((w) => w && !FILLER.has(norm(w))); // "type bike model chetak" is just "chetak"
  if (!words.length) return null;
  const [make, model] = words.length > 1 ? [words[0], words.slice(1).join(' ')] : ['', words[0]];
  Object.assign(env.st.data, { make, model });
  return say(env.st, 'What colour is it? Tap one, or type it. It helps our specialist find your vehicle.', withStartOver(COLOURS.map((l) => ({ label: l, value: l }))), [], 'vcolour');
}

function setAsideFor(env: Env, flow: 'vehicle' | 'address') {
  const { st } = env;
  if (st.flow === 'single' || st.flow === 'membership') st.resume = { flow: st.flow, data: st.data };
  st.flow = flow;
  st.data = {};
}

function askSociety(env: Env): Reply {
  setAsideFor(env, 'address');
  return say(env.st, 'Before you pay I need to know where to come. Please type the name of your society or building.', [START_OVER], [], 'society');
}

async function onSaved(env: Env, kind: 'vehicle' | 'address'): Promise<Reply> {
  const { st } = env;
  const back = st.resume;
  st.resume = null;
  if (back) {
    st.flow = back.flow;
    st.data = back.data;
    const r = await advance(env);
    return { ...r, reply: `Saved. ${r.reply}` };
  }
  return toMenu(env, `Your ${kind} is saved. What would you like to do next?`);
}

// ───────────────────────── asking the next question of a booking ─────────────────────────
async function advance(env: Env): Promise<Reply> {
  const { st, vs } = env;
  const d = st.data;
  if (!d.vehicle) {
    if (vs.length === 0) {
      setAsideFor(env, 'vehicle');
      return say(st, 'You have no vehicle saved yet. What type of vehicle is it?', withStartOver(['Car', 'Bike', 'SUV'].map((l) => ({ label: l, value: l.toLowerCase() }))), [], 'vtype');
    }
    if (vs.length === 1) {
      d.vehicle = 'V1';
      d.vtype = vs[0].vehicle_type;
    } else {
      return say(st, 'Which vehicle is this for?', withStartOver(vs.slice(0, 6).map((v, i) => ({ label: vehicleLabel(v), value: `V${i + 1}` }))), [], 'vehicle');
    }
  }
  return st.flow === 'single' ? advanceSingle(env) : advanceMembership(env);
}

async function advanceSingle(env: Env): Promise<Reply> {
  const { st } = env;
  const d = st.data;
  if (!d.service) {
    const c = await call(env, 'get_catalog', { vehicle_type: d.vtype });
    if (!c.ok) return toMenu(env, TROUBLE);
    const services = (c.data.services as { service: string; name: string; price_rupees: Record<string, number> }[]).slice(0, 6);
    if (!services.length) return toMenu(env, 'No services are available for that vehicle right now. Please try again later.');
    const opts = services.map((s) => ({ label: `${s.name} (₹${s.price_rupees[d.vtype] ?? Object.values(s.price_rupees)[0]})`, value: s.service }));
    return say(st, 'Which service would you like?', withStartOver(opts), [], 'service');
  }
  if (!d.date) {
    const a = await call(env, 'get_availability', { kind: 'single' });
    if (!a.ok) return toMenu(env, TROUBLE);
    const days = (a.data.days_with_open_windows as { date: string; label: string; open_windows: string[] }[]).slice(0, 5);
    if (!days.length) return toMenu(env, `No days are open in the next few days. Please try again later, or ${CONTACT.charAt(0).toLowerCase()}${CONTACT.slice(1)}`);
    d.days = days;
    return say(st, 'Which day suits you?', withStartOver(days.map((x) => ({ label: x.label, value: x.date }))), [], 'date');
  }
  if (!d.window) {
    const day = (d.days as { date: string; label: string; open_windows: string[] }[]).find((x) => x.date === d.date);
    const open = day?.open_windows ?? [];
    if (open.length === 1) d.window = open[0];
    else return say(st, `Which time on ${day?.label ?? 'that day'}?`, withStartOver(open.map((w) => ({ label: windowLabel(w), value: w }))), [], 'window');
  }
  if (env.as.length === 0) return askSociety(env);
  const r = await call(env, 'propose_single_wash', { vehicle: d.vehicle, service: d.service, date: d.date, window: d.window });
  if (!r.ok) return failed(env, r);
  return say(st, 'Here is your booking, with the exact price. Slide to pay when you are ready.', [{ label: 'Change the time', value: '__time' }, START_OVER], env.ctx.cards, 'done');
}

const windowLabel = (w: string) => {
  const s = SLOTS.find((x) => x.id === w);
  return s ? `${s.label} (${s.hours})` : w;
};

async function advanceMembership(env: Env): Promise<Reply> {
  const { st } = env;
  const d = st.data;
  if (d.washes === undefined) {
    const opts = [4, 8, 12].map((n) => ({ label: `${n} washes a month`, value: String(n) }));
    return say(st, 'How many washes a month would you like? Choose one, or type a number from 4 to 28.', withStartOver(opts), [], 'washes');
  }
  if (d.deep === undefined) {
    if (d.vtype === 'bike') d.deep = 0; // a bike has Body washes only
    else {
      const opts = [{ label: 'Body washes only', value: '0' }, ...[1, 2, 4].filter((n) => n <= d.washes).map((n) => ({ label: `${n} Deep clean${n > 1 ? 's' : ''} a month`, value: String(n) }))];
      return say(st, 'Would you like some Deep cleans mixed in?', withStartOver(opts), [], 'deep');
    }
  }
  if (!d.avail) {
    const a = await call(env, 'get_availability', { kind: 'membership' });
    if (!a.ok) return toMenu(env, TROUBLE);
    d.avail = { earliest: a.data.earliest_start_date, label: a.data.earliest_start_label, open: (a.data.open_weekdays as { weekday: number }[]).map((w) => w.weekday), notOn: a.data.windows_not_available };
  }
  const need = Math.max(1, Math.ceil((d.washes as number) / 4));
  if (!d.weekdays) {
    const open: number[] = d.avail.open;
    if (!open.length) return toMenu(env, 'WASHO has no working days open for memberships right now. Please check back soon.');
    const sugg: Opt[] = [];
    for (let off = 0; off < 3; off++) {
      const days = [...new Set(Array.from({ length: need }, (_, j) => open[(Math.floor((j * open.length) / need) + off) % open.length]))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
      if (days.length === need) {
        const label = days.map((x) => WEEKDAYS[x].slice(0, 3)).join(' & ');
        if (!sugg.some((o) => o.label === label)) sugg.push({ label, value: days.join(',') });
      }
    }
    const text = need === 1 ? 'Which day of the week should we wash on? Tap one, or type it.' : `${d.washes} washes a month need at least ${need} different weekdays. Tap a choice, or type the days you want (for example Mon and Thu).`;
    return say(st, text, withStartOver(sugg), [], 'weekdays');
  }
  if (!d.months) {
    const c = await call(env, 'get_catalog', { vehicle_type: d.vtype });
    const pct = c.ok ? ((c.data.membership?.length_discount_percent ?? {}) as Record<string, number>) : {};
    const opts = [1, 3, 6, 12].map((m) => ({ label: `${m} month${m > 1 ? 's' : ''}${pct[m] > 0 ? ` (${pct[m]}% off)` : ''}`, value: String(m) }));
    return say(st, 'For how long? A longer plan gets a bigger discount.', withStartOver(opts), [], 'months');
  }
  if (!d.window) {
    const days = (d.weekdays as number[]).map((x) => WEEKDAYS[x]);
    const blocked = new Set((d.avail.notOn as { window: string; not_on: string[] }[]).filter((w) => w.not_on.some((n) => days.includes(n))).map((w) => w.window));
    const open = SLOTS.filter((s) => !blocked.has(s.id));
    if (!open.length) {
      d.weekdays = undefined;
      return say(st, 'No time window works on all those days. Please choose different weekdays.', withStartOver([]), [], 'weekdays');
    }
    return say(st, 'Which time window?', withStartOver(open.map((s) => ({ label: windowLabel(s.id), value: s.id }))), [], 'window');
  }
  if (env.as.length === 0) return askSociety(env);
  const r = await call(env, 'propose_membership', { vehicle: d.vehicle, body: d.washes - d.deep, deep: d.deep, weekdays: d.weekdays, months: d.months, window: d.window, start_date: d.avail.earliest });
  if (!r.ok) return failed(env, r);
  return say(st, `Here is your plan, with the exact price. It starts from ${d.avail.label} at the earliest. Slide to pay when you are ready.`, [{ label: 'Change the days', value: '__time' }, START_OVER], env.ctx.cards, 'done');
}

/** A tool refused: say why in plain words (the tools' own messages are written for a model), and go back to the question that fixes it. */
async function failed(env: Env, r: { code: string; message: string }): Promise<Reply> {
  const { st } = env;
  const d = st.data;
  switch (r.code) {
    case 'closed_day':
    case 'window_not_open':
    case 'date_out_of_range':
      d.date = undefined;
      d.window = undefined;
      return withNote('That day or time is not open any more.', await advance(env));
    case 'plan_does_not_fit':
    case 'weekday_closed':
    case 'window_off_on_weekday':
    case 'too_few_weekdays':
      d.weekdays = undefined;
      d.window = undefined;
      d.avail = undefined;
      return withNote('That plan does not fit on those days.', await advance(env));
    case 'start_too_soon':
      d.avail = undefined;
      return withNote('The start date has moved.', await advance(env));
    case 'no_address':
      return askSociety(env);
    case 'booking_paused':
      return toMenu(env, 'Booking is paused for a little while. Please check back soon.');
    case 'service_not_for_vehicle':
    case 'unknown_service':
      d.service = undefined;
      return advance(env);
    default:
      return toMenu(env, TROUBLE);
  }
}

const withNote = (note: string, r: Reply): Reply => ({ ...r, reply: `${note} ${r.reply}` });

// ───────────────────────── the customer's answer to the last question ─────────────────────────
/** null = this was not an answer to the question (the customer may be asking for something else). */
async function answer(env: Env, raw: string, t: string): Promise<Reply | null> {
  const { st, vs } = env;
  const d = st.data;
  const chosen = pick(st.opts, raw);
  if (chosen?.value === START_OVER.value) return toMenu(env);

  switch (st.step) {
    case 'vtype': {
      // a tap on a button names only the type; anything typed may also carry the model ("type bike model chetak")
      const tapped = st.opts.find((o) => norm(o.label) === t || norm(o.value) === t);
      const kind = tapped?.value ?? vehicleKind(t);
      if (!kind) return null; // not a type: the question is asked again, with its buttons
      d.vtype = kind;
      const name = tapped ? [] : cleanData(raw, 60).split(' ').filter((w) => w && !FILLER.has(norm(w)));
      return name.length ? takeVehicleName(env, name.join(' ')) : askVehicleName(env);
    }
    case 'vname':
      return isTap(raw) ? null : takeVehicleName(env, raw); // a menu button typed here means something else
    case 'vcolour': {
      const colour = cleanData(raw, 30);
      if (!colour || colour === '[hidden]') return null;
      const { vtype, make, model } = d;
      const r = await call(env, 'propose_vehicle', { vehicle_type: vtype, ...(make ? { make } : {}), model, color: colour });
      if (!r.ok) return askVehicleName(env, 'I could not use that vehicle. ');
      return say(st, 'Here is the vehicle card. Type the registration number on it and tap Save.', [START_OVER], env.ctx.cards, 'vcard');
    }
    case 'society': {
      const name = cleanData(raw, 80);
      if (name.length < 2 || name === '[hidden]') return null;
      const r = await call(env, 'propose_address', { society_name: name });
      if (!r.ok) return say(st, 'I could not use that. Please type just the name of your society or building.', [START_OVER], [], 'society');
      return say(st, 'Here is the address card. Fill in your block, flat and parking spot, then tap Save.', [START_OVER], env.ctx.cards, 'acard');
    }
    case 'vehicle': {
      if (!chosen) return null;
      d.vehicle = chosen.value;
      d.vtype = vs[Number(chosen.value.slice(1)) - 1]?.vehicle_type ?? 'car';
      return advance(env);
    }
    case 'service': {
      if (!chosen) return null;
      d.service = chosen.value;
      return advance(env);
    }
    case 'date': {
      let hit = chosen;
      if (!hit) {
        const days = d.days as { date: string; label: string }[];
        const want = /\btoday\b/.test(t) ? env.ctx.today : /\btomorrow\b/.test(t) ? new Date(Date.parse(`${env.ctx.today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : null;
        const wd = parseDays(t)[0];
        const day = days.find((x) => (want && x.date === want) || (wd !== undefined && weekdayOf(x.date) === wd));
        if (day) hit = { label: day.label, value: day.date };
      }
      if (!hit) return null;
      d.date = hit.value;
      d.window = undefined;
      return advance(env);
    }
    case 'window': {
      const win = chosen ?? SLOTS.map((s) => ({ label: s.label, value: s.id })).find((s) => new RegExp(`\\b${s.label.toLowerCase()}\\b`).test(t));
      if (!win) return null;
      d.window = win.value;
      return advance(env);
    }
    case 'washes': {
      const n = Number(/\b(\d{1,2})\b/.exec(t)?.[1]);
      if (!Number.isFinite(n)) return null;
      if (n < 4 || n > 28) return say(st, 'A membership has from 4 to 28 washes a month. How many would you like?', st.opts, [], 'washes');
      d.washes = n;
      return advance(env);
    }
    case 'deep': {
      if (/\b(body|none|no|only)\b/.test(t) && !/\d/.test(t)) d.deep = 0;
      else {
        const n = Number(/\b(\d{1,2})\b/.exec(t)?.[1]);
        if (!Number.isFinite(n)) return null;
        if (n > d.washes) return say(st, `You asked for ${d.washes} washes a month in all, so at most ${d.washes} can be Deep cleans. How many Deep cleans?`, st.opts, [], 'deep');
        d.deep = n;
      }
      return advance(env);
    }
    case 'weekdays': {
      const days = chosen ? chosen.value.split(',').map(Number) : parseDays(t);
      if (!days.length) return null;
      const need = Math.max(1, Math.ceil(d.washes / 4));
      const open: number[] = d.avail.open;
      const shut = days.filter((x) => !open.includes(x));
      if (shut.length) return say(st, `WASHO does not work on ${shut.map((x) => WEEKDAYS[x]).join(', ')}. Please choose other days.`, st.opts, [], 'weekdays');
      if (days.length < need) return say(st, `${d.washes} washes a month need at least ${need} different weekdays. Please choose ${need} or more.`, st.opts, [], 'weekdays');
      d.weekdays = days;
      d.window = undefined;
      return advance(env);
    }
    case 'months': {
      const m = Number(/\b(\d{1,2})\b/.exec(t)?.[1]);
      if (![1, 3, 6, 12].includes(m)) return null;
      d.months = m;
      return advance(env);
    }
    case 'done': {
      if (chosen?.value === '__time' || /\bchange\b/.test(t)) {
        if (st.flow === 'single') { d.date = undefined; d.window = undefined; }
        else { d.weekdays = undefined; d.window = undefined; }
        return advance(env);
      }
      if (/\b(try again|retry|again)\b/.test(t)) return advance(env); // everything is chosen: a fresh card with fresh prices
      if (/\bnot now\b/.test(t)) return toMenu(env);
      return null;
    }
    default:
      return null; // 'menu', 'vcard', 'acard': waiting for the customer to use a card, or to ask for something
  }
}
