/**
 * A stand-in for the model, for tests and for clicking through the screens without a key. It speaks the assistant's own neutral protocol (text and tool calls), so the whole pipeline
 * around it (tools, guards, cards, limits, payment) is the real one. `friendly` is a small, polite, rule-based assistant that walks the booking flows; the tests write their own
 * policies to play a model that misbehaves on purpose (leaks, lies about prices, claims things are booked, tries other people's handles).
 */
import type { Llm, LlmRequest, LlmResponse } from '../src/agent/llm';

let n = 0;
type Spec = { content: unknown[]; stop_reason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens' };

export const reply = (s: Spec): LlmResponse => ({ content: s.content as LlmResponse['content'], stop_reason: s.stop_reason, usage: { input_tokens: 100, output_tokens: 20 } });

export const say = (text: string): Spec => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
export const call = (name: string, input: Record<string, unknown>): Spec => ({ content: [{ type: 'tool_use', id: `call_${++n}`, name, input }], stop_reason: 'tool_use' });
export const callMany = (...items: [string, Record<string, unknown>][]): Spec => ({ content: items.map(([name, input]) => ({ type: 'tool_use', id: `call_${++n}`, name, input })), stop_reason: 'tool_use' });
export const declined = (): Spec => ({ content: [], stop_reason: 'refusal' });

export interface Seen {
  request: LlmRequest;
  messages: LlmRequest['messages'];
  /** What the customer typed, in order (as the model read it between its tags). */
  said: string[];
  /** The server's facts for this message (the <server_context> block). */
  context: string;
  /** The tool answers since the customer's last message, by tool name. */
  results: Record<string, any>;
  /** The raw tool answers (text) since the customer's last message, in order. */
  raw: { name: string; content: string; isError: boolean }[];
  round: number;
}
export type Policy = (seen: Seen) => Spec | Promise<Spec>;

const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function read(request: LlmRequest, round: number): Seen {
  const messages = request.messages;
  const said: string[] = [];
  let context = '';
  let turnStart = 0;
  messages.forEach((m, i) => {
    if (m.role !== 'user') return;
    for (const b of m.content) {
      if (b.type !== 'text') continue;
      const c = /<customer_message>([\s\S]*?)<\/customer_message>/.exec(b.text);
      const ctx = /<server_context>[\s\S]*?<\/server_context>/.exec(b.text);
      if (c) { said.push(unescape(c[1])); turnStart = i; if (ctx) context = ctx[0]; }
      else if (/<server_event>/.test(b.text)) { turnStart = i; if (ctx) context = ctx[0]; }
    }
  });
  const names = new Map<string, string>();
  const raw: Seen['raw'] = [];
  const results: Record<string, any> = {};
  for (const m of messages.slice(turnStart)) {
    for (const b of m.content) {
      if (m.role === 'assistant' && b.type === 'tool_use') names.set(b.id, b.name);
      if (m.role === 'user' && b.type === 'tool_result') {
        const name = names.get(b.tool_use_id) ?? '?';
        raw.push({ name, content: String(b.content), isError: Boolean(b.is_error) });
        try { results[name] = JSON.parse(String(b.content)); } catch { /* not json */ }
      }
    }
  }
  return { request, messages, said, context, results, raw, round };
}

/** Wraps a policy as the connection the server uses. `calls` records every request (as a snapshot), so a test can look at what the model was sent. */
export function model(policy: Policy): Llm & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const fn = (async (request: LlmRequest) => {
    calls.push(structuredClone(request)); // a snapshot: the server goes on adding to its own list afterwards
    // how many model calls this customer message has already caused = the number of assistant messages since the customer's last message
    const seen = read(request, 0);
    let round = 0;
    for (let i = request.messages.length - 1; i >= 0; i--) {
      const m = request.messages[i];
      if (m.role === 'assistant') round++;
      else if (m.content.some((b) => b.type === 'text' && /<customer_message>|<server_event>/.test(b.text))) break;
    }
    return reply(await policy({ ...seen, round }));
  }) as Llm & { calls: LlmRequest[] };
  fn.calls = calls;
  return fn;
}

// ───────────────────────── the polite, rule-based assistant ─────────────────────────
const DAY: Record<string, number> = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };

/** Asks for a tool answer once; with the answer in hand, carries on. */
const need = (s: Seen, name: string, input: Record<string, unknown>): { have: any } | { ask: Spec } => (s.results[name] !== undefined ? { have: s.results[name] } : { ask: call(name, input) });

/** The saved vehicles named in the server's facts: [{ handle: 'V1', type: 'car' }, ...]. */
const savedVehicles = (context: string) => {
  const line = /saved_vehicles: (.*)/.exec(context)?.[1] ?? 'none';
  return line === 'none' ? [] : line.split('; ').map((v) => ({ handle: v.split(' ')[0], type: /\((bike|car|suv)\)/.exec(v)?.[1] ?? 'car' }));
};

export const friendly: Policy = (s) => {
  const said = s.said;
  const last = (said.at(-1) ?? '').toLowerCase();
  const start = [...said.keys()].reverse().find((i) => /single wash|membership/i.test(said[i]));
  const flow = start === undefined ? null : /membership/i.test(said[start]) ? 'membership' : 'single';
  const answers = start === undefined ? [] : said.slice(start + 1);
  const chips = (choices: string[], text: string): Spec => (s.results.show_quick_replies !== undefined ? say(text) : call('show_quick_replies', { choices }));

  if (!flow) {
    if (/price|cost|how much/.test(last)) {
      const c = need(s, 'get_catalog', {});
      if ('ask' in c) return c.ask;
      const list = (c.have.services as { name: string; price_rupees: Record<string, number> }[]).slice(0, 4).map((x) => `${x.name} from ₹${Math.min(...Object.values(x.price_rupees))}`).join(', ');
      return say(`Here are some of our washes: ${list}.`);
    }
    if (/add.*vehicle|my (car|bike)/.test(last)) {
      const reg = /\b([A-Za-z]{2}\s?\d{2}\s?[A-Za-z]{1,3}\s?\d{4})\b/.exec(said.join(' '));
      const type = /bike|activa|scooter/i.test(said.join(' ')) ? 'bike' : 'car';
      if (reg || /creta|activa|swift/i.test(said.join(' ')))
        return s.results.propose_vehicle ? say('Please check the details on the card and tap Save.') : call('propose_vehicle', { vehicle_type: type, make: 'Hyundai', model: 'Creta', color: 'White', ...(reg ? { registration_number: reg[1] } : {}) });
      return say('Sure. What type is it (car, bike or SUV), and the make and model?');
    }
    return say('I can book a single wash or start a membership, or add your vehicle. What would you like?');
  }

  const v = savedVehicles(s.context)[0];
  if (!v) return say('You have no vehicle saved yet. Tell me its type, make and model and I will add it.');
  const catalog = need(s, 'get_catalog', { vehicle_type: v.type });
  if ('ask' in catalog) return catalog.ask;
  const services = catalog.have.services as { service: string; name: string; kind: string }[];

  if (flow === 'single') {
    if (answers.length === 0) return chips(services.map((x) => x.name).slice(0, 4), 'Which service would you like?');
    const service = services.find((x) => answers[0].toLowerCase().includes(x.name.toLowerCase())) ?? services[0];
    const av = need(s, 'get_availability', { kind: 'single' });
    if ('ask' in av) return av.ask;
    const days = av.have.days_with_open_windows as { date: string; label: string; open_windows: string[] }[];
    const options = days.slice(0, 3).map((d) => ({ d, text: `${d.label} · ${d.open_windows[0]}` }));
    if (answers.length === 1) return chips(options.map((o) => o.text.replace(/ · (\w)/, (_, c) => ` · ${c.toUpperCase()}`)), 'Which day and time suits you?');
    const pick = options.find((o) => answers[1].toLowerCase() === o.text.toLowerCase()) ?? options[0];
    return s.results.propose_single_wash
      ? say(s.results.propose_single_wash.error ? `Sorry: ${s.results.propose_single_wash.message}` : 'Here it is. Slide to pay when you are ready.')
      : call('propose_single_wash', { vehicle: v.handle, service: service.service, date: pick.d.date, window: pick.d.open_windows[0] });
  }

  // membership
  if (answers.length === 0) return chips(['4 washes a month', '8 washes a month'], 'How many washes a month would you like?');
  const washes = Number(/(\d+)/.exec(answers[0])?.[1] ?? 4);
  if (answers.length === 1) return chips(washes > 4 ? ['Mon and Thu', 'Tue and Fri'] : ['Monday', 'Saturday'], 'Which weekdays suit you?');
  const weekdays = [...new Set(answers[1].toLowerCase().match(/[a-z]+/g)?.map((w) => DAY[w]).filter((x) => x !== undefined) ?? [])];
  if (answers.length === 2) return chips(['1 month', '3 months', '6 months'], 'For how long?');
  const months = Number(/(\d+)/.exec(answers[2])?.[1] ?? 1);
  const av = need(s, 'get_availability', { kind: 'membership' });
  if ('ask' in av) return av.ask;
  if (answers.length === 3) return chips(['Morning', 'Afternoon', 'Night'], 'Which time window?');
  const window = (/(morning|afternoon|night)/i.exec(answers[3])?.[1] ?? 'morning').toLowerCase();
  return s.results.propose_membership
    ? say(s.results.propose_membership.error ? `Sorry: ${s.results.propose_membership.message}` : 'Here is your plan. Slide to pay when you are ready.')
    : call('propose_membership', { vehicle: v.handle, body: washes, deep: 0, weekdays, months, window, start_date: av.have.earliest_start_date });
};
