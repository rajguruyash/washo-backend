import { config } from '../config';
import type { Msg } from './llm';
import { AgentError, type Bubble, type Card } from './types';

/**
 * Everything Woshi remembers about a chat lives HERE, on the server, keyed by who is signed in. The screen only ever sends the customer's new words: it cannot hand the model an earlier
 * "assistant" message, a tool answer or a card of its own making, so nobody can forge the history the model reads. A chat is forgotten after 45 idle minutes (or when the server restarts);
 * the model is then simply started fresh.
 */
const IDLE_MS = 45 * 60_000;
const MAX_CHATS = 2000;
/** Messages in one chat before it is closed (a very long chat costs more and drifts). */
export const MAX_TURNS = 40;

/**
 * What the model may name. It never sees or writes a database id: vehicles and addresses are V1, V2... and A1, A2... (rebuilt from the database every turn), services are S1, S2... (given
 * out by get_catalog). The server turns a handle back into the real id, and still checks that it is this customer's. A model cannot invent, mangle or guess an id that works.
 */
export interface Handles {
  vehicles: Map<string, string>;
  addresses: Map<string, string>;
  services: Map<string, string>;
  serviceOf: Map<string, string>;
}

/**
 * "Simple mode": when no language model can be reached, Woshi guides the customer with fixed questions and tappable answers instead (rules.ts). This is where it remembers how far along
 * the customer is. It is held only here, on the server, like the rest of the chat.
 */
export interface RuleState {
  /** Why simple mode is answering: 'down' = the model could not be reached (or is too slow), so say so; 'tap' = the customer tapped one of the buttons, which needs no model at all. */
  reason: 'down' | 'tap';
  flow: 'single' | 'membership' | 'vehicle' | 'address' | null;
  /** The question last asked (which answer is expected next). */
  step: string;
  /** What the customer has chosen so far in this flow. */
  data: Record<string, any>;
  /** The tappable answers offered with the last question, so the next message can be matched to one. */
  opts: { label: string; value: string }[];
  /** The last question's words, to repeat it when an answer is not understood. */
  prompt: string;
  /** A booking set aside while the customer adds a vehicle or an address, to carry on with afterwards. */
  resume: { flow: 'single' | 'membership'; data: Record<string, any> } | null;
  /** When the model was last found unreachable: after a few minutes, between flows, the model is tried again. */
  since: number;
  announced: boolean;
}

export interface Conversation {
  /** The model's own history (older tool answers are shortened when it is sent: see run.ts). */
  messages: Msg[];
  handles: Handles;
  /** What the screen shows. */
  display: Bubble[];
  turns: number;
  touched: number;
  /** One request at a time per customer. */
  busy: boolean;
  /** Every price and percentage a tool returned in this chat: an answer may only state these (guards.ts). */
  amounts: Set<number>;
  percents: Set<number>;
  /** Cards shown in this chat (so the server can tell a card from a forgery). */
  cards: Map<string, Card>;
  /** Things the server verified in the database that the model has not been told yet. */
  verified: string[];
  /** Events already handled (a payment reported twice must not be answered twice). */
  seen: Set<string>;
  /** Set while the model cannot be reached (see RuleState). */
  rules: RuleState | null;
}

const chats = new Map<string, Conversation>();

const fresh = (): Conversation => ({ messages: [], handles: { vehicles: new Map(), addresses: new Map(), services: new Map(), serviceOf: new Map() }, display: [], turns: 0, touched: Date.now(), busy: false, amounts: new Set(), percents: new Set(), cards: new Map(), verified: [], seen: new Set(), rules: null });

function sweep() {
  const cutoff = Date.now() - IDLE_MS;
  for (const [k, c] of chats) if (c.touched < cutoff && !c.busy) chats.delete(k);
  if (chats.size > MAX_CHATS) {
    const oldest = [...chats].filter(([, c]) => !c.busy).sort((a, b) => a[1].touched - b[1].touched).slice(0, chats.size - MAX_CHATS);
    for (const [k] of oldest) chats.delete(k);
  }
}

export function chatFor(sub: string): Conversation {
  sweep();
  let c = chats.get(sub);
  if (!c) chats.set(sub, (c = fresh()));
  c.touched = Date.now();
  return c;
}

export const peekChat = (sub: string): Conversation | undefined => chats.get(sub);

/** Forget this customer's chat (they asked for a new one, or it was closed). A chat that is in the middle of an answer is left to finish. */
export function resetChat(sub: string) {
  const c = chats.get(sub);
  if (c?.busy) return;
  chats.delete(sub);
}

/** Runs `fn` with this customer's chat held, so a second request from the same customer waits no turn: it is told to wait a moment. */
export async function withChat<T>(sub: string, fn: (c: Conversation) => Promise<T>): Promise<T> {
  const c = chatFor(sub);
  if (c.busy) throw new AgentError(409, 'busy', 'One moment: I am still answering your last message.');
  c.busy = true;
  try {
    return await fn(c);
  } finally {
    c.busy = false;
    c.touched = Date.now();
  }
}

// ───────────────────────── limits ─────────────────────────
const FIVE_MIN = 5 * 60_000;
interface Usage { stamps: number[]; day: string; messages: number; tokens: number; rStamps: number[]; rMessages: number }
const usage = new Map<string, Usage>();
let globalDay = '';
let globalCalls = 0;

const dayKey = () => new Date().toISOString().slice(0, 10);

/**
 * Counts one customer message and refuses it when the customer, or the whole assistant, has had enough for now. `kind` 'rules' is a message answered by the fixed rules (no model, so
 * no free allowance is spent): it has its own, much larger limit and is not held back when the model's allowance is used up.
 */
export function takeTurn(sub: string, kind: 'model' | 'rules' = 'model'): void {
  const today = dayKey();
  if (globalDay !== today) { globalDay = today; globalCalls = 0; }
  let u = usage.get(sub);
  if (!u || u.day !== today) usage.set(sub, (u = { stamps: [], day: today, messages: 0, tokens: 0, rStamps: [], rMessages: 0 }));
  const cutoff = Date.now() - FIVE_MIN;
  if (kind === 'rules') {
    u.rStamps = u.rStamps.filter((t) => t > cutoff);
    if (u.rStamps.length >= config.agent.rulesPer5Min || u.rMessages >= config.agent.rulesPerDay) throw new AgentError(429, 'slow_down', 'You are sending messages very quickly. Please wait a few minutes and try again.', 'limit');
    u.rStamps.push(Date.now());
    u.rMessages++;
    return;
  }
  if (globalCalls >= config.agent.callsPerDay) throw new AgentError(503, 'agent_resting', 'Woshi is resting for today. You can still book from the Book and Plans screens.', 'limit');
  u.stamps = u.stamps.filter((t) => t > cutoff);
  if (u.stamps.length >= config.agent.messagesPer5Min) throw new AgentError(429, 'slow_down', 'You are sending messages very quickly. Please wait a few minutes and try again.', 'limit');
  if (u.messages >= config.agent.messagesPerDay || u.tokens >= config.agent.tokensPerDay) throw new AgentError(429, 'daily_limit', 'That is all the chatting I can do today. You can still book from the Book and Plans screens, and I will be back tomorrow.', 'limit');
  u.stamps.push(Date.now());
  u.messages++;
  if (usage.size > 20_000) usage.clear();
}

/** One call to the model happened. */
export function noteCall(sub: string, tokens: number) {
  globalCalls++;
  const u = usage.get(sub);
  if (u) u.tokens += tokens;
}

/** Is the model answering too slowly right now? Shared by every customer: it is the model that is slow, not one chat. */
export const modelSpeed = { slowUntil: 0 };

/** For tests. */
export function forgetEverything() {
  modelSpeed.slowUntil = 0;
  chats.clear();
  usage.clear();
  globalCalls = 0;
  globalDay = '';
}
