import { config } from '../config';
import { openAiCompatible, withFailover } from './openai';

/**
 * The one place the server talks to a language model. Everything else in the assistant speaks the small, neutral shape below; `openai.ts` translates it to the chat API that nearly every
 * provider (Google Gemini, Groq, OpenRouter, a model on your own computer) offers. It is a plain function so tests can put a stand-in in its place (as with mail and push): the tests
 * never need a key and can play a model that misbehaves. With no provider set up (or none reachable) simple mode (rules.ts) answers instead.
 */
export interface TextBlock { type: 'text'; text: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown; /** Something the provider asked to have handed back with the call (Gemini 3 does). */ extra?: unknown }
export interface ToolResultBlock { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;
export interface Msg { role: 'user' | 'assistant'; content: Block[] }
export interface ToolDef { name: string; description: string; input_schema: Record<string, unknown> }

export interface LlmRequest { system: string; tools: ToolDef[]; messages: Msg[]; max_tokens: number }
export interface LlmResponse {
  content: (TextBlock | ToolUseBlock)[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  usage?: { input_tokens: number; output_tokens: number };
  /** Which provider answered (for the log, never for the customer). */
  provider?: string;
}
export type Llm = (req: LlmRequest) => Promise<LlmResponse>;

let llm: Llm | null = config.agent.providers.length ? withFailover(config.agent.providers, openAiCompatible) : null;

/** Tests swap in their own. */
export const setLlm = (l: Llm | null) => void (llm = l);

/** Is the assistant switched on (AGENT_ENABLED). It is offered even with no model set up: simple mode (rules.ts) then does the talking. */
export const agentEnabled = (): boolean => config.agent.enabled;

/** Is there a model to ask (a connection is set up, and AGENT_MODE is not "rules")? */
export const modelReady = (): boolean => llm !== null && config.agent.mode !== 'rules';

export function callLlm(req: LlmRequest): Promise<LlmResponse> {
  if (!llm) throw new Error('The assistant has no model connected');
  return llm(req);
}
