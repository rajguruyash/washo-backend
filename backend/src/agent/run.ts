import crypto from 'crypto';
import type { PoolClient } from 'pg';
import type { Profile } from '../profile';
import { checkInput, checkOutput, cleanData, REFUSAL, retryNote, type OutputContext } from './guards';
import { config } from '../config';
import { callLlm, modelReady, type LlmRequest, type LlmResponse, type Msg, type TextBlock, type ToolResultBlock, type ToolUseBlock } from './llm';
import { ASSISTANT_NAME, buildContext, CANARY, customerMessage, eventMessage, leaksPrompt, SYSTEM_PROMPT } from './prompt';
import { finishRules, freshRules, isCommand, isTap, ruleTurn, type RuleInput } from './rules';
import { MAX_TURNS, modelSpeed, noteCall, peekChat, resetChat, takeTurn, withChat, type Conversation } from './store';
import { addressLineForModel, istToday, prettyDay, refreshHandles, repriceCard, runTool, slotText, TOOLS, vehicleLine, type ToolCtx } from './tools';
import { AgentError, type Bubble, type Card, type ChatResult, type Slot } from './types';

/**
 * One turn of the conversation. The model may ask for tools (read prices, read the customer's vehicles, prepare a card) as often as it needs, up to a limit; its final words are checked
 * by the output guard before the customer sees them. Anything that can go wrong ends in a plain sentence and the booking screens, never in a stack trace and never in a stranger's data.
 */
type Db = <T>(fn: (c: PoolClient) => Promise<T>) => Promise<T>;
export interface Actor { sub: string; profile: Profile; db: Db }

const MAX_ROUNDS = 7;
const MAX_TOKENS = 1500;
export const GREETING_CHIPS = ['Book a single wash', 'Start a membership', 'Add a vehicle', 'Prices', 'How does it work?'];
export const FALLBACK_LINKS = [
  { label: 'Book a single wash', to: '/app/book' },
  { label: 'Start a membership', to: '/app/membership/new' },
];

const firstName = (p: Profile) => cleanData((p.full_name ?? '').trim().split(/\s+/)[0], 30);
const now = () => new Date().toISOString();

export function greeting(p: Profile): string {
  const n = firstName(p);
  return `Hi${n ? ` ${n}` : ''}! I'm ${ASSISTANT_NAME}, WASHO's assistant. I can book a single wash, start a membership, or add your vehicle. What would you like to do?`;
}

/** The chat as the screen should show it (the greeting first when it is new). */
export function history(actor: Actor): { bubbles: Bubble[]; quick_replies: string[] } {
  const c = peekChat(actor.sub);
  const bubbles = c?.display.length ? c.display : [{ role: 'assistant' as const, text: greeting(actor.profile), at: now() }];
  return { bubbles, quick_replies: c?.display.length ? [] : GREETING_CHIPS };
}

export const newChat = (actor: Actor) => resetChat(actor.sub);

// ───────────────────────── the model ─────────────────────────
const turnStart = (m: Msg) => m.role === 'user' && m.content.some((b) => b.type === 'text' && /<customer_message>|<server_event>/.test(b.text));

/** What is sent for older turns is shortened (tool answers cut to a stub, old context blocks dropped): free language-model services count every word against a small daily allowance. The stored history is untouched. */
export function compact(messages: Msg[]): Msg[] {
  const starts = messages.map((m, i) => (turnStart(m) ? i : -1)).filter((i) => i >= 0);
  const keepFrom = starts.length > 3 ? starts[starts.length - 3] : 0;
  if (keepFrom === 0) return messages;
  return messages.map((m, i) =>
    i >= keepFrom
      ? m
      : { ...m, content: m.content.map((b) => (b.type === 'tool_result' && b.content.length > 160 ? { ...b, content: '[earlier answer left out]' } : b.type === 'text' && m.role === 'user' ? { ...b, text: b.text.replace(/<server_context>[\s\S]*?<\/server_context>\n?/, '') } : b)) }
  );
}

/** Exactly what is sent to the model (also used by the one-call check in scripts/agent-live.ts). */
export function agentRequest(messages: Msg[]): LlmRequest {
  return { system: SYSTEM_PROMPT, tools: TOOLS, messages: compact(messages), max_tokens: MAX_TOKENS };
}

async function ask(actor: Actor, conv: Conversation): Promise<LlmResponse> {
  try {
    const r = await callLlm(agentRequest(conv.messages));
    noteCall(actor.sub, (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0));
    return r;
  } catch (err) {
    // the provider layer has already logged which service said what (never the conversation)
    console.error(`Woshi could not get an answer from any model: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    throw new AgentError(503, 'model_unavailable', 'I am having trouble right now. You can still book from the Book and Plans screens, and I will be back soon.', 'unavailable');
  }
}

const textOf = (m: LlmResponse) => m.content.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
const toolUses = (m: LlmResponse) => m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');

// ───────────────────────── what the model is told about this moment ─────────────────────────
async function facts(actor: Actor, conv: Conversation) {
  // V1, V2... and A1, A2... mean these rows for as long as this message is being answered (rebuilt every turn)
  const { vs, as } = await refreshHandles(actor.db, conv.handles);
  const verified = conv.verified.splice(0);
  return buildContext({
    now: new Date(),
    firstName: firstName(actor.profile),
    hasMobile: Boolean(actor.profile.phone),
    vehicles: vs.map((v, i) => vehicleLine(`V${i + 1}`, v)),
    addresses: as.map((a, i) => addressLineForModel(`A${i + 1}`, a)),
    verified,
  });
}

const decline = (conv: Conversation, text: string, quick: string[] = GREETING_CHIPS.slice(0, 3), notice?: ChatResult['notice']): ChatResult => ({ reply: text, cards: [], quick_replies: quick, notice });

function remember(conv: Conversation, userText: string | null, r: ChatResult) {
  const at = now();
  if (userText) conv.display.push({ role: 'user', text: userText, at });
  conv.display.push({ role: 'assistant', text: r.reply, cards: r.cards.length ? r.cards : undefined, at });
  if (conv.display.length > 80) conv.display.splice(0, conv.display.length - 80);
}

// ───────────────────────── a turn that uses the model ─────────────────────────
/** Is the model usable right now (set up, not switched to rules only, not answering too slowly)? */
const modelUsable = () => modelReady() && Date.now() >= modelSpeed.slowUntil;

/** Should this message be answered by simple mode (rules.ts) and not by the model? `text` is what the customer typed (none for "I saved it"). */
function inSimpleMode(conv: Conversation, text?: string): boolean {
  if (!modelUsable()) {
    conv.rules ??= freshRules('down'); // no model set up, AGENT_MODE=rules, or the model has been answering too slowly: simple mode
    return true;
  }
  const r = conv.rules;
  // a booking in progress stays where it is
  if (r && r.flow !== null) return true;
  // the model was unreachable a moment ago: simple mode, then the model is tried again after a few minutes
  if (r && r.reason === 'down') {
    if (Date.now() - r.since <= config.agent.retryModelMs) return true;
    conv.rules = null;
  }
  // a tap on one of the buttons, or a short command in words, needs no model: the fixed rules answer at once
  if (config.agent.rulesFirst && text !== undefined && (isTap(text) || isCommand(text))) {
    if (!conv.rules || conv.rules.reason !== 'tap') conv.rules = freshRules('tap');
    return true;
  }
  return false;
}

/** null = the rules handed the customer's own words over to the model. */
async function viaRules(actor: Actor, conv: Conversation, input: RuleInput, handoff = modelUsable() && config.agent.rulesFirst): Promise<ChatResult | null> {
  const result = await ruleTurn(actor, conv, input, { handoff });
  if (!result) {
    conv.rules = null;
    return null;
  }
  remember(conv, null, result);
  console.info(JSON.stringify({ evt: 'agent_turn', who: crypto.createHash('sha256').update(actor.sub).digest('hex').slice(0, 8), provider: 'rules', outcome: 'ok' }));
  return result;
}

const LIMIT_CODES = new Set(['slow_down', 'daily_limit', 'agent_resting']);

async function converse(actor: Actor, conv: Conversation, tail: string, input: RuleInput): Promise<ChatResult> {
  let counted = false; // this message has already been counted as one answered by the rules
  if (inSimpleMode(conv, 'text' in input ? input.text : undefined)) {
    takeTurn(actor.sub, 'rules');
    counted = true;
    const r = await viaRules(actor, conv, input);
    if (r) return r;
  }
  try {
    takeTurn(actor.sub, 'model');
  } catch (err) {
    if (err instanceof AgentError && LIMIT_CODES.has(err.code)) {
      // the model's allowance for this customer (or for the whole day) is used up: the buttons and fixed questions still work, so the customer is never sent away
      if (!counted) takeTurn(actor.sub, 'rules');
      conv.rules ??= freshRules('down');
      conv.rules.announced = true;
      const r = (await viaRules(actor, conv, input, false)) as ChatResult;
      const note = err.code === 'daily_limit' ? 'That is all the typed chatting I can do today, but the simple options below still work.' : err.code === 'agent_resting' ? 'My smart replies are resting for today, but the simple options below still work.' : 'You are sending messages quickly, so I will keep to simple options for a few minutes.';
      return { ...r, reply: `${note} ${r.reply}` };
    }
    throw err;
  }
  const t0 = Date.now();
  try {
    return await viaModel(actor, conv, tail, input);
  } finally {
    const took = Date.now() - t0;
    if (config.agent.slowTurnMs > 0 && took > config.agent.slowTurnMs) {
      // a customer should not wait this long for every message: simple mode answers for a few minutes, then the model gets another go
      modelSpeed.slowUntil = Date.now() + config.agent.slowRestMs;
      console.warn(`Woshi: a message took ${Math.round(took / 1000)}s to answer; simple mode for the next ${Math.round(config.agent.slowRestMs / 60_000)} minutes`);
    }
  }
}

async function viaModel(actor: Actor, conv: Conversation, tail: string, input: RuleInput): Promise<ChatResult> {
  const started = Date.now();
  if (conv.turns >= MAX_TURNS) {
    // a very long chat costs more and drifts: begin again, and say so to the model so it does not pretend to remember
    conv.messages = [];
    conv.turns = 0;
    conv.verified.push('This chat was restarted to keep it short; the customer\'s earlier choices in it are forgotten.');
  }
  const ctxText = await facts(actor, conv);
  // if the model cannot be reached at all, this turn is taken back so the chat is exactly as it was before it
  const mark = conv.messages.length;
  conv.messages.push({ role: 'user', content: [{ type: 'text', text: `${ctxText}\n${tail}` }] });
  conv.turns++;

  const tctx: ToolCtx = {
    db: actor.db, sub: actor.sub, now: new Date(), today: istToday(new Date()), handles: conv.handles,
    amounts: conv.amounts, percents: conv.percents, cards: [], quick: [],
    keepCard: (c: Card) => void conv.cards.set(c.id, c),
  };
  const outCtx: OutputContext = { amounts: conv.amounts, percents: conv.percents, canary: CANARY, leaks: leaksPrompt };
  const used: string[] = [];
  let tokens = 0;
  let retried = false;
  let provider = '';
  const log = (outcome: string) =>
    console.info(JSON.stringify({ evt: 'agent_turn', who: crypto.createHash('sha256').update(actor.sub).digest('hex').slice(0, 8), provider, tools: used, tokens, ms: Date.now() - started, outcome }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let m: LlmResponse;
    try {
      m = await ask(actor, conv);
    } catch (err) {
      conv.messages.length = mark;
      conv.turns = Math.max(0, conv.turns - 1);
      if (err instanceof AgentError && err.code === 'model_unavailable') {
        // no model could be reached: this turn is taken back from the model's history, and simple mode answers instead of an error
        console.warn('Woshi: no model reachable, answering in simple mode');
        conv.rules = freshRules('down');
        return (await viaRules(actor, conv, input)) as ChatResult;
      }
      throw err;
    }
    tokens += (m.usage?.input_tokens ?? 0) + (m.usage?.output_tokens ?? 0);
    provider = m.provider ?? provider;
    conv.messages.push({ role: 'assistant', content: m.content.length ? m.content : [{ type: 'text', text: '(no text)' }] });

    if (m.stop_reason === 'refusal') {
      log('model_declined');
      return decline(conv, REFUSAL, undefined, 'declined');
    }

    const uses = toolUses(m);
    if (uses.length && m.stop_reason === 'tool_use') {
      const results: ToolResultBlock[] = [];
      for (const u of uses) {
        used.push(u.name);
        const r = await runTool(u.name, u.input, tctx);
        results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, ...(r.isError ? { is_error: true } : {}) });
      }
      conv.messages.push({ role: 'user', content: results });
      continue;
    }
    if (uses.length) {
      // the answer was cut off in the middle of asking for a tool: do not act on half a request
      log('cut_off');
      conv.messages.push({ role: 'user', content: [{ type: 'text', text: '<server_context>Your last reply was cut off. Answer again, briefly.</server_context>' }] });
      continue;
    }

    const verdict = checkOutput(textOf(m), outCtx);
    if (verdict.ok) {
      const result: ChatResult = { reply: verdict.text, cards: tctx.cards, quick_replies: tctx.quick };
      remember(conv, null, result);
      log('ok');
      return result;
    }
    if (!verdict.retry) {
      // keys, the hidden word, somebody's phone number: never shown, and the chat is wiped
      log(`blocked_${verdict.reason}`);
      conv.messages = [];
      conv.turns = 0;
      return decline(conv, REFUSAL);
    }
    if (retried) {
      log(`withheld_${verdict.reason}`);
      const fallback = 'I want to be exact, so let me not guess here. Please tell me again what you would like to do, or use the Book and Plans screens.';
      conv.messages.push({ role: 'user', content: [{ type: 'text', text: '<server_context>The customer was shown a standard message instead of your last draft.</server_context>' }] });
      conv.messages.push({ role: 'assistant', content: [{ type: 'text', text: fallback }] });
      const result = decline(conv, fallback, GREETING_CHIPS.slice(0, 3));
      result.cards = tctx.cards;
      remember(conv, null, result);
      return result;
    }
    retried = true;
    conv.messages.push({ role: 'user', content: [{ type: 'text', text: `<server_context>${retryNote(verdict.reason)}</server_context>` }] });
  }
  log('too_many_rounds');
  const result = decline(conv, 'That took more steps than it should. Please try again, or use the Book and Plans screens.');
  remember(conv, null, result);
  return result;
}

// ───────────────────────── what the customer typed ─────────────────────────
export async function chat(actor: Actor, raw: unknown): Promise<ChatResult> {
  const verdict = checkInput(raw);
  return withChat(actor.sub, async (conv) => {
    if (!verdict.ok) {
      // never reaches the model; a plain answer, and it still counts against the customer's limit (so it cannot be used to hammer the server)
      takeTurn(actor.sub);
      const r = decline(conv, verdict.reply, verdict.reason === 'exfil' || verdict.reason === 'injection' ? GREETING_CHIPS.slice(0, 3) : []);
      if (verdict.reason !== 'empty') remember(conv, typeof raw === 'string' ? cleanData(raw, 200) || '…' : null, r);
      console.info(JSON.stringify({ evt: 'agent_turn', who: crypto.createHash('sha256').update(actor.sub).digest('hex').slice(0, 8), outcome: `refused_${verdict.reason}` }));
      return r;
    }
    const result = await converse(actor, conv, customerMessage(verdict.text), { text: verdict.text });
    // the customer's words are shown as they typed them (cleaned), added before the answer
    const answer = conv.display.pop();
    conv.display.push({ role: 'user', text: verdict.text, at: now() });
    if (answer) conv.display.push(answer);
    return result;
  });
}

// ───────────────────────── what the customer did on a card ─────────────────────────
export type AgentEvent =
  | { type: 'vehicle_saved'; vehicle_id: string; card_id?: string }
  | { type: 'address_saved'; address_id: string; card_id?: string }
  | { type: 'paid'; kind: 'single' | 'membership'; id: string; card_id?: string }
  | { type: 'payment_cancelled' };

const READ_VEHICLE = `SELECT vehicle_type::text AS vehicle_type, make, model FROM public.vehicles WHERE is_active AND id = $1`;
const READ_ADDRESS = `SELECT society_name FROM public.customer_addresses a WHERE (to_jsonb(a) ->> 'archived_at') IS NULL AND id = $1`;
const READ_BOOKING = `
  SELECT b.reference_code, b.status::text AS status, b.scheduled_date, b.time_slot::text AS time_slot, s.name AS service_name, v.make, v.model, v.registration_number
    FROM public.bookings b JOIN public.services s ON s.id = b.service_id JOIN public.vehicles v ON v.id = b.vehicle_id
   WHERE b.id = $1 AND b.created_at > now() - interval '3 hours'`;
const READ_MEMBERSHIP = `
  SELECT m.status, m.duration_months,
         (SELECT count(*)::int FROM public.bookings b WHERE b.membership_id = m.id AND b.status <> 'cancelled') AS washes,
         (SELECT b.scheduled_date FROM public.bookings b WHERE b.membership_id = m.id AND b.status NOT IN ('completed', 'cancelled') ORDER BY b.scheduled_date, b.time_slot LIMIT 1) AS first_wash,
         (SELECT b.time_slot::text FROM public.bookings b WHERE b.membership_id = m.id AND b.status NOT IN ('completed', 'cancelled') ORDER BY b.scheduled_date, b.time_slot LIMIT 1) AS first_slot
    FROM public.memberships m WHERE m.id = $1 AND m.created_at > now() - interval '3 hours'`;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE = new Set(['pending', 'confirmed', 'worker_assigned', 'worker_called', 'call_not_picked_up', 'in_progress', 'completed']);

export async function event(actor: Actor, ev: AgentEvent): Promise<ChatResult> {
  return withChat(actor.sub, async (conv) => {
    const idOf = 'vehicle_id' in ev ? ev.vehicle_id : 'address_id' in ev ? ev.address_id : 'id' in ev ? ev.id : '';
    if (ev.type !== 'payment_cancelled' && !uuid.test(idOf)) throw new AgentError(400, 'bad_event', 'That did not look right.');
    const key = `${ev.type}:${idOf}`;
    if (ev.type !== 'payment_cancelled' && conv.seen.has(key)) return { reply: '', cards: [], quick_replies: [] };

    if (ev.type === 'payment_cancelled') {
      const r: ChatResult = {
        reply: "That payment was not completed, so nothing is booked yet. If you were charged, the booking will show under Washes shortly, or WASHO will refund it. Would you like to change anything or try again?",
        cards: [],
        quick_replies: ['Try again', 'Change the time', 'Not now'],
      };
      remember(conv, null, r);
      return r;
    }

    if (ev.type === 'paid') {
      // Believe the database, not the screen: look the booking up as this customer.
      const text = await actor.db(async (c) => {
        if (ev.kind === 'single') {
          const b = (await c.query(READ_BOOKING, [ev.id])).rows[0];
          if (!b || !LIVE.has(b.status)) return null;
          return { say: `Payment received and your wash is booked: ${cleanData(b.service_name, 60)} for ${cleanData([b.make, b.model].filter(Boolean).join(' '), 60)} on ${prettyDay(b.scheduled_date)}, ${slotText(b.time_slot as Slot)}. Reference ${cleanData(b.reference_code, 30)}. Your specialist will call you before the wash. You can see it under Washes.`, note: `Single wash booked (reference ${b.reference_code}).` };
        }
        const m = (await c.query(READ_MEMBERSHIP, [ev.id])).rows[0];
        if (!m || m.status !== 'active') return null;
        return { say: `Payment received and your membership is active: ${m.washes} washes over ${m.duration_months} month${m.duration_months > 1 ? 's' : ''}${m.first_wash ? `, the first on ${prettyDay(m.first_wash)}, ${slotText(m.first_slot as Slot)}` : ''}. Your specialist will call you before each wash. You can see it under Plans.`, note: `Membership started (${m.washes} washes).` };
      });
      conv.seen.add(key);
      const used = ev.card_id ? conv.cards.get(ev.card_id) : undefined;
      if (text && used) used.done = 'paid';
      const r: ChatResult = text
        ? { reply: text.say, cards: [], quick_replies: ['Book another wash', 'Add a vehicle', 'Thanks!'] }
        : { reply: "I could not confirm that booking yet. If you were charged, it will appear under Washes in a moment, or WASHO will refund it. You can also call 8668890147.", cards: [], quick_replies: [] };
      if (text) {
        conv.verified.push(text.note);
        finishRules(conv); // a booking made in simple mode is finished: back to the menu
      }
      remember(conv, null, r);
      return r;
    }

    // a vehicle or an address was saved: look it up, then let the model carry on with the booking
    const row = await actor.db(async (c) => (await c.query(ev.type === 'vehicle_saved' ? READ_VEHICLE : READ_ADDRESS, [idOf])).rows[0]);
    if (!row) throw new AgentError(404, 'not_found', 'I could not find that. Please try again.');
    conv.seen.add(key);
    const saved = ev.card_id ? conv.cards.get(ev.card_id) : undefined;
    if (saved) saved.done = 'saved';
    // the model is told as little as it needs: the last four characters of a plate, the society and nothing of the flat
    const what = ev.type === 'vehicle_saved' ? `vehicle ${cleanData([row.make, row.model].filter(Boolean).join(' '), 60)} (${row.vehicle_type})` : `address in ${cleanData(row.society_name, 60)}`;
    return converse(actor, conv, eventMessage(`The customer saved this ${what}; it is now on their account. Carry on with what they were doing.`), { saved: ev.type === 'vehicle_saved' ? 'vehicle' : 'address' });
  });
}

/**
 * The customer typed a coupon code on a pay card, or took it off (`code` null). The server prices the card again (the database says in plain words if the code cannot be used) and hands
 * back the card as it now stands; the screen swaps it in. Only a card of this chat that is still open can be changed, and the payment itself checks the coupon once more.
 */
export async function couponOnCard(actor: Actor, cardId: string, code: string | null): Promise<{ card: Card }> {
  return withChat(actor.sub, async (conv) => {
    const card = conv.cards.get(cardId);
    if (!card || (card.type !== 'single_wash' && card.type !== 'membership')) throw new AgentError(404, 'no_card', 'I could not find that booking card. Ask Woshi to show it again.');
    if (card.done) throw new AgentError(409, 'card_done', 'That one is already paid.');
    if (new Date(card.expires_at).getTime() < Date.now()) throw new AgentError(410, 'card_expired', 'This card has expired, because prices and free days can change. Ask Woshi to show it again.');
    await repriceCard({ db: actor.db, sub: actor.sub, amounts: conv.amounts, percents: conv.percents }, card, code);
    // the model is told, so it never quotes the old total
    const total = `₹${card.total_cents / 100}`;
    conv.verified.push(card.pay.coupon ? `The customer applied coupon ${cleanData(card.pay.coupon, 30)} on the booking card; the card's total is now ${total}.` : `The customer took the coupon off the booking card; the card's total is now ${total}.`);
    return { card };
  });
}

/** For the screens: is the assistant on, and what to say first. */
export function status(profile: Profile) {
  return { name: ASSISTANT_NAME, greeting: greeting(profile), quick_replies: GREETING_CHIPS, fallback_links: FALLBACK_LINKS, max_chars: 600 };
}

