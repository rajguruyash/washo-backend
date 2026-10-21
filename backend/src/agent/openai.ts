import type { Block, Llm, LlmRequest, LlmResponse, TextBlock, ToolUseBlock } from './llm';

/**
 * Talks to any service that speaks the common "chat completions" API with tools: Google Gemini, Groq, OpenRouter, Mistral, Cerebras, a model running on your own computer (Ollama), and
 * more. One implementation covers them all; a provider is just an address, a key and a model name. Several can be listed: when one is out of free allowance (429), down or refusing,
 * the next one answers, so a free tier running dry does not stop the assistant.
 */
export interface Provider {
  name: string;
  baseUrl: string;
  /** Empty for a model on your own computer. */
  apiKey: string;
  model: string;
  /** How hard a "thinking" model may think ('low' keeps answers fast and cheap); empty for models that do not take the setting. */
  reasoning?: string;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number, public retryAfterMs?: number) {
    super(message);
  }
}

// A customer is waiting for each answer: a service that takes longer than this is skipped for a while and the next one asked (or simple mode answers).
const TIMEOUT_MS = 25_000;

/** The parts of a JSON schema every provider accepts. Gemini in particular refuses a few keywords (additionalProperties, numeric limits, enums of numbers); our own checks cover them anyway. */
export function portableSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(portableSchema);
  if (!s || typeof s !== 'object') return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (['additionalProperties', 'minimum', 'maximum', 'minItems', 'maxItems', 'default', 'examples', '$schema', 'minLength', 'maxLength', 'pattern', 'format'].includes(k)) continue;
    if (k === 'enum' && Array.isArray(v) && v.some((x) => typeof x !== 'string')) continue;
    out[k] = k === 'properties' && v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, portableSchema(pv)])) : portableSchema(v);
  }
  return out;
}

const textOf = (blocks: Block[]) => blocks.filter((b): b is TextBlock => b.type === 'text').map((b) => b.text).join('\n');

/** Our neutral request, as the chat API wants it. */
export function toChatRequest(req: LlmRequest, p: Pick<Provider, 'model' | 'reasoning'>): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const calls = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use').map((u) => ({ id: u.id, type: 'function', function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) }, ...(u.extra !== undefined ? { extra_content: u.extra } : {}) }));
      const text = textOf(m.content);
      messages.push({ role: 'assistant', content: text || (calls.length ? '' : '(no text)'), ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      const text = textOf(m.content);
      if (text) messages.push({ role: 'user', content: text });
    }
  }
  return {
    model: p.model,
    messages,
    ...(req.tools.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: portableSchema(t.input_schema) } })), tool_choice: 'auto' } : {}),
    temperature: 0.3,
    max_tokens: req.max_tokens,
    ...(p.reasoning && !['off', 'none'].includes(p.reasoning) ? { reasoning_effort: p.reasoning } : {}),
  };
}

let seq = 0;
const newId = () => `call_${Date.now().toString(36)}_${(seq++).toString(36)}`;

/** The chat API's answer, in our neutral shape. */
export function fromChatResponse(json: any): LlmResponse {
  const choice = json?.choices?.[0];
  if (!choice) throw new ProviderError('The model sent back no answer', 502);
  const msg = choice.message ?? {};
  const raw = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: { text?: string }) => p?.text ?? '').join('') : '';
  // some "thinking" models write their reasoning inline: it is never shown
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
  const seen = new Set<string>();
  const calls: ToolUseBlock[] = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).map((c: any) => {
    let id = typeof c?.id === 'string' && c.id ? c.id : newId();
    if (seen.has(id)) id = newId(); // a provider that hands out the same id twice would confuse the answers
    seen.add(id);
    let input: unknown = c?.function?.arguments;
    if (typeof input === 'string') {
      try { input = input.trim() ? JSON.parse(input) : {}; } catch { input = { __unreadable: true }; }
    }
    return { type: 'tool_use' as const, id, name: String(c?.function?.name ?? ''), input: input ?? {}, ...(c?.extra_content !== undefined ? { extra: c.extra_content } : {}) };
  });
  const finish = String(choice.finish_reason ?? '');
  const stop_reason: LlmResponse['stop_reason'] = finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : calls.length ? 'tool_use' : 'end_turn';
  return {
    content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls],
    stop_reason,
    usage: { input_tokens: Number(json?.usage?.prompt_tokens ?? 0), output_tokens: Number(json?.usage?.completion_tokens ?? 0) },
  };
}

/** One provider, as a function. `fetchImpl` is only different in tests. */
export function openAiCompatible(p: Provider, fetchImpl: typeof fetch = fetch): Llm {
  const url = `${p.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  // a model that does not take the thinking setting says so once (400); after that it is simply not sent
  let dropReasoning = false;
  const post = async (req: LlmRequest): Promise<Response> => {
    try {
      return await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify(toChatRequest(req, { model: p.model, reasoning: dropReasoning ? '' : p.reasoning })),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new ProviderError(`${p.name}/${p.model} could not be reached (${(err as Error).name})`, 0);
    }
  };
  return async (req) => {
    let res = await post(req);
    if (res.status === 400 && p.reasoning && !dropReasoning && /reason|think|effort/i.test(await res.clone().text().catch(() => ''))) {
      dropReasoning = true;
      res = await post(req);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const wait = Number(res.headers.get('retry-after'));
      throw new ProviderError(`${p.name}/${p.model} answered ${res.status}: ${body.replace(/\s+/g, ' ').slice(0, 220)}`, res.status, Number.isFinite(wait) && wait > 0 ? wait * 1000 : undefined);
    }
    return fromChatResponse(await res.json().catch(() => null));
  };
}

/** Tries the providers in order. One that is out of allowance, down or refusing the key is skipped for a while instead of being asked again at once. */
export function withFailover(providers: Provider[], make: (p: Provider) => Llm): Llm {
  const entries = providers.map((p) => ({ p, call: make(p), downUntil: 0 }));
  return async (req) => {
    let last: unknown;
    for (const e of entries) {
      if (e.downUntil > Date.now()) continue;
      try {
        return { ...(await e.call(req)), provider: e.p.name };
      } catch (err) {
        last = err;
        const status = err instanceof ProviderError ? err.status ?? 0 : 0;
        const wait = err instanceof ProviderError ? err.retryAfterMs : undefined;
        // 429: out of free allowance (try again after what the provider says, or a minute); 401/403: a wrong key and 404: a model name that is gone (neither fixes itself: do not keep trying); 5xx or unreachable: a minute; 400: our request
        e.downUntil = Date.now() + (status === 401 || status === 403 || status === 404 ? 10 * 60_000 : status === 429 ? Math.min(wait ?? 60_000, 15 * 60_000) : status === 400 ? 30_000 : 60_000);
        console.error(`Woshi: ${(err as Error).message}${entries.length > 1 ? ' (trying the next provider)' : ''}`);
      }
    }
    throw last ?? new ProviderError('Every model provider is resting for a moment', 503);
  };
}
