/**
 * The connection to the free language-model services (Gemini, Groq, OpenRouter, anything that speaks the common chat API): what is sent, how the answer is read, and how the next
 * service takes over when one runs out of its free allowance. No network and no key: the HTTP call is a stand-in.
 * Run on its own:  npx vitest run backend/tests/agent-openai.test.ts --config vitest.api.config.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fromChatResponse, openAiCompatible, portableSchema, ProviderError, toChatRequest, withFailover, type Provider } from '../src/agent/openai';
import { agentProviders } from '../src/config';
import type { LlmRequest } from '../src/agent/llm';

const provider = (o: Partial<Provider> = {}): Provider => ({ name: 'gemini', baseUrl: 'https://example.test/v1/', apiKey: 'key-123456', model: 'model-x', reasoning: 'low', ...o });

const request: LlmRequest = {
  system: 'You are Woshi.',
  max_tokens: 500,
  tools: [
    {
      name: 'get_catalog',
      description: 'Prices.',
      input_schema: { type: 'object', additionalProperties: false, properties: { vehicle_type: { type: 'string', enum: ['bike', 'car'] }, days: { type: 'integer', minimum: 1, maximum: 21, default: 8 }, size: { type: 'integer', enum: [1, 2] } } },
    },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'call_1', name: 'get_catalog', input: { vehicle_type: 'car' }, extra: { google: { thought_signature: 'abc' } } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"services":[]}' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'get_catalog', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: '{"error":"x"}', is_error: true }, { type: 'text', text: 'again please' }] },
  ],
};

const answer = (message: Record<string, unknown>, finish = 'stop', usage: Record<string, number> = { prompt_tokens: 11, completion_tokens: 4 }) => ({ choices: [{ message, finish_reason: finish }], usage });
const respond = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

describe('what is sent', () => {
  it('system first, tool calls as JSON strings, every tool answer under its call id, and the tools with a plain schema', () => {
    const body = toChatRequest(request, provider()) as any;
    expect(body.model).toBe('model-x');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are Woshi.' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
    expect(body.messages[2]).toMatchObject({ role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_catalog', arguments: '{"vehicle_type":"car"}' } }] });
    expect(body.messages[2].tool_calls[0].extra_content).toEqual({ google: { thought_signature: 'abc' } }); // handed back as the provider asked
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '{"services":[]}' });
    expect(body.messages[4]).toMatchObject({ role: 'assistant', content: '', tool_calls: [{ id: 'call_2', function: { arguments: '{}' } }] });
    expect(body.messages[5]).toEqual({ role: 'tool', tool_call_id: 'call_2', content: '{"error":"x"}' });
    expect(body.messages[6]).toEqual({ role: 'user', content: 'again please' });
    expect(body.tool_choice).toBe('auto');
    expect(body.max_tokens).toBe(500);
    expect(body.temperature).toBeLessThanOrEqual(0.5);
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 'get_catalog', description: 'Prices.', parameters: { type: 'object', properties: { vehicle_type: { type: 'string', enum: ['bike', 'car'] }, days: { type: 'integer' }, size: { type: 'integer' } } } },
    });
  });

  it('thinking effort is sent only for services that take it', () => {
    expect((toChatRequest(request, provider({ reasoning: 'low' })) as any).reasoning_effort).toBe('low');
    expect(toChatRequest(request, provider({ reasoning: 'off' }))).not.toHaveProperty('reasoning_effort');
    expect(toChatRequest(request, provider({ reasoning: '' }))).not.toHaveProperty('reasoning_effort');
  });

  it('no tools: no tool fields at all', () => {
    const body = toChatRequest({ ...request, tools: [] }, provider()) as any;
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });

  it('the schema keeps only what every service accepts, all the way down', () => {
    expect(portableSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string', maxLength: 5, pattern: '^x', enum: ['x', 'y'] } }, n: { type: 'number', enum: [1, 2] } }, required: ['a'] })).toEqual({
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } }, n: { type: 'number' } },
      required: ['a'],
    });
  });
});

describe('how an answer is read', () => {
  it('text, with usage', () => {
    expect(fromChatResponse(answer({ content: 'Hello!' }))).toEqual({ content: [{ type: 'text', text: 'Hello!' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4 } });
  });

  it('tool calls: arguments are parsed, a missing or repeated id is replaced, text before them is kept', () => {
    const r = fromChatResponse(answer({ content: 'One moment.', tool_calls: [
      { id: 'a', function: { name: 'get_catalog', arguments: '{"vehicle_type":"car"}' } },
      { function: { name: 'get_availability', arguments: '' } },
      { id: 'a', function: { name: 'get_availability', arguments: { kind: 'single' } } },
    ] }, 'tool_calls'));
    expect(r.stop_reason).toBe('tool_use');
    expect(r.content[0]).toEqual({ type: 'text', text: 'One moment.' });
    const uses = r.content.filter((b) => b.type === 'tool_use') as { id: string; name: string; input: unknown }[];
    expect(uses.map((u) => u.name)).toEqual(['get_catalog', 'get_availability', 'get_availability']);
    expect(uses[0]).toMatchObject({ id: 'a', input: { vehicle_type: 'car' } });
    expect(uses[1].input).toEqual({}); // an empty argument string is "no arguments"
    expect(uses[2].input).toEqual({ kind: 'single' });
    expect(new Set(uses.map((u) => u.id)).size).toBe(3);
  });

  it('arguments that are not JSON are flagged, not guessed at', () => {
    const r = fromChatResponse(answer({ tool_calls: [{ id: 'z', function: { name: 'get_catalog', arguments: '{"vehicle_type": "ca' } }] }, 'tool_calls'));
    expect((r.content[0] as any).input).toEqual({ __unreadable: true });
  });

  it("a model's inline thinking is never kept", () => {
    expect(fromChatResponse(answer({ content: '<think>they want a car wash, secret plan</think>Sure, which car?' })).content).toEqual([{ type: 'text', text: 'Sure, which car?' }]);
    expect(fromChatResponse(answer({ content: 'Sure.<think>unfinished thought' })).content).toEqual([{ type: 'text', text: 'Sure.' }]);
  });

  it('content as parts, a cut-off answer, a filtered answer', () => {
    expect(fromChatResponse(answer({ content: [{ text: 'Hel' }, { text: 'lo' }] })).content).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(fromChatResponse(answer({ content: 'Half an ans' }, 'length')).stop_reason).toBe('max_tokens');
    expect(fromChatResponse(answer({ content: null }, 'content_filter')).stop_reason).toBe('refusal');
  });

  it('no answer at all is an error, and missing usage counts as zero', () => {
    expect(() => fromChatResponse({ choices: [] })).toThrow(ProviderError);
    expect(() => fromChatResponse(null)).toThrow(ProviderError);
    expect(fromChatResponse({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] }).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe('one service, over HTTP', () => {
  it('posts to /chat/completions with the key, and returns the parsed answer', async () => {
    const fetchImpl = vi.fn(async () => respond(200, answer({ content: 'Hi' })));
    const r = await openAiCompatible(provider(), fetchImpl as any)(request);
    expect(r.content).toEqual([{ type: 'text', text: 'Hi' }]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-123456');
    expect(JSON.parse(init.body as string).model).toBe('model-x');
  });

  it('a model on your own computer needs no key', async () => {
    const fetchImpl = vi.fn(async () => respond(200, answer({ content: 'Hi' })));
    await openAiCompatible(provider({ apiKey: '' }), fetchImpl as any)(request);
    expect((fetchImpl.mock.calls[0] as any)[1].headers).not.toHaveProperty('authorization');
  });

  it('a model that does not take the thinking setting (400) is asked again without it, and never sent it again', async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return bodies.length === 1 ? respond(400, { error: { message: 'Unknown parameter: reasoning_effort is not supported by this model' } }) : respond(200, answer({ content: 'Hi' }));
    });
    const ask = openAiCompatible(provider({ reasoning: 'minimal' }), fetchImpl as any);
    expect((await ask(request)).content).toEqual([{ type: 'text', text: 'Hi' }]);
    expect(bodies[0].reasoning_effort).toBe('minimal');
    expect(bodies[1]).not.toHaveProperty('reasoning_effort');
    await ask(request);
    expect(bodies[2]).not.toHaveProperty('reasoning_effort');
    // a 400 about something else is an error, not a retry
    const other = vi.fn(async () => respond(400, 'messages: bad shape'));
    await expect(openAiCompatible(provider({ reasoning: 'low' }), other as any)(request)).rejects.toMatchObject({ status: 400 });
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('errors carry the status and how long to wait, never the key', async () => {
    const limited = openAiCompatible(provider(), (async () => respond(429, 'rate limited', { 'retry-after': '12' })) as any);
    const err = await limited(request).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ status: 429, retryAfterMs: 12_000 });
    expect(err.message).not.toContain('key-123456');

    const down = await openAiCompatible(provider(), (async () => { throw new TypeError('fetch failed'); }) as any)(request).catch((e) => e);
    expect(down).toMatchObject({ status: 0 });
    expect(down.message).not.toContain('key-123456');

    const junk = await openAiCompatible(provider(), (async () => respond(200, '<html>oops</html>')) as any)(request).catch((e) => e);
    expect(junk).toBeInstanceOf(ProviderError);
  });
});

describe('when one service runs out, the next answers', () => {
  const ok = (text: string) => async () => ({ content: [{ type: 'text' as const, text }], stop_reason: 'end_turn' as const });
  const failing = (status: number, retryAfterMs?: number) => vi.fn(async () => { throw new ProviderError(`x answered ${status}`, status, retryAfterMs); });
  let quiet: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    quiet.mockRestore();
  });

  it('a service out of free allowance (429) is skipped for a while, and the answer says who gave it', async () => {
    const first = failing(429);
    const second = vi.fn(ok('from groq'));
    const llm = withFailover([provider({ name: 'gemini' }), provider({ name: 'groq' })], (p) => (p.name === 'gemini' ? first : second));
    const r = await llm(request);
    expect(r).toMatchObject({ provider: 'groq', content: [{ text: 'from groq' }] });
    await llm(request);
    expect(first).toHaveBeenCalledTimes(1); // not asked again straight away
    expect(second).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(61_000);
    await llm(request);
    expect(first).toHaveBeenCalledTimes(2); // asked again after the pause
  });

  it('waits as long as the service says, up to a limit; a wrong key (401) is left alone for longer', async () => {
    const limited = failing(429, 5 * 60_000);
    const wrongKey = failing(401);
    const llm = withFailover([provider({ name: 'a' }), provider({ name: 'b' }), provider({ name: 'c' })], (p) => (p.name === 'a' ? limited : p.name === 'b' ? wrongKey : ok('c')));
    await llm(request);
    vi.advanceTimersByTime(4 * 60_000);
    await llm(request);
    expect(limited).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60_000);
    await llm(request);
    expect(limited).toHaveBeenCalledTimes(2);
    expect(wrongKey).toHaveBeenCalledTimes(1); // still resting after 6 minutes
    vi.advanceTimersByTime(5 * 60_000);
    await llm(request);
    expect(wrongKey).toHaveBeenCalledTimes(2);
  });

  it('when every service is resting the error is passed up (the customer is told in plain words), and each failure is logged without the conversation', async () => {
    const llm = withFailover([provider({ name: 'a' }), provider({ name: 'b' })], () => failing(500));
    await expect(llm(request)).rejects.toBeInstanceOf(ProviderError);
    await expect(llm(request)).rejects.toThrow(/resting/); // both are paused now
    const logged = quiet.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('x answered 500');
    expect(logged).not.toContain('hello');
    expect(logged).not.toContain('key-123456');
  });

  it('an error that is not from a service (a bug) also moves on rather than breaking the chat', async () => {
    const llm = withFailover([provider({ name: 'a' }), provider({ name: 'b' })], (p) => (p.name === 'a' ? (async () => { throw new Error('boom'); }) : ok('fine')));
    expect((await llm(request)).provider).toBe('b');
  });
});

describe('which services are set up from the environment', () => {
  const names = (env: Record<string, string>) => agentProviders(env as NodeJS.ProcessEnv).map((p) => `${p.name}:${p.model}`);

  it('nothing without a key', () => {
    expect(agentProviders({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('one Gemini key gives two models to try, in order: each model has its own free allowance', () => {
    expect(names({ GEMINI_API_KEY: 'k' })).toEqual(['gemini:gemini-3.5-flash-lite', 'gemini:gemini-3.8-flash']);
    const [first] = agentProviders({ GEMINI_API_KEY: ' k ' } as NodeJS.ProcessEnv);
    expect(first).toMatchObject({ apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', reasoning: 'minimal' });
  });

  it('keys for several services are tried in the order Gemini, Groq, OpenRouter', () => {
    expect(names({ OPENROUTER_API_KEY: 'o', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-x' })).toEqual(['gemini:gemini-x', 'groq:openai/gpt-oss-120b', 'openrouter:openrouter/free']);
  });

  it('AGENT_PROVIDERS picks and orders them; a name with no key is ignored', () => {
    const env = { GEMINI_API_KEY: 'k', GROQ_API_KEY: 'g', GEMINI_MODEL: 'a,b', AGENT_PROVIDERS: 'groq, gemini, openrouter' };
    expect(names(env)).toEqual(['groq:openai/gpt-oss-120b', 'gemini:a', 'gemini:b']);
  });

  it('a custom service (for example Ollama) needs an address and a model, and goes first', () => {
    expect(names({ AGENT_BASE_URL: 'http://localhost:11434/v1', AGENT_MODEL: 'llama3.1', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'g' })).toEqual(['custom:llama3.1', 'gemini:g']);
    expect(names({ AGENT_BASE_URL: 'http://localhost:11434/v1' })).toEqual([]); // no model named: not guessed
    expect(agentProviders({ AGENT_BASE_URL: 'http://localhost:11434/v1', AGENT_MODEL: 'llama3.1' } as NodeJS.ProcessEnv)[0].apiKey).toBe('');
  });
});
