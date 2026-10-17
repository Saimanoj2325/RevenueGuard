import type { AgentName } from '../contract.js'

/** OpenAI-compatible chat message: the neutral format both engines and the model router speak. */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array'
export interface ToolParam {
  type: ParamType
  description: string
  required?: boolean
  enum?: string[]
}

/** A RevenueGuard tool as registered by the tool plugin (engine-neutral). */
export interface ToolSpec {
  name: string
  description: string
  params: Record<string, ToolParam>
  /** result can contain customer/external text -> untrusted-content plugin wraps it */
  external: boolean
}

export interface ToolSchemaJson {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ToolCallReq {
  id: string
  name: string
  args: Record<string, unknown>
}

/** Normalised result of one tool call after the API (or a policy denial). */
export interface ToolOutcome {
  ok: boolean
  data: unknown
  evidence_node_ids: string[]
  /** model-facing text; post-tool plugins may rewrite it */
  text: string
  denied?: boolean
  error?: string
  untrusted_flag?: boolean
  latency_ms?: number
}

export interface ModelUsage {
  input_tokens: number
  output_tokens: number
}

export interface ModelResponse {
  content: string | null
  tool_calls: ChatToolCall[]
  usage: ModelUsage
  provider: string
  model: string
  latency_ms: number
  cost_inr: number
  /** providers tried and failed before this one succeeded */
  fallbacks: { provider: string; error: string }[]
}

export interface ModelRequest {
  messages: ChatMessage[]
  tools: ToolSchemaJson[]
  signal: AbortSignal
  agent: AgentName
  maxOutputTokens?: number
}

/** Model adapter seam (the router implements it; the mock LLM is one provider behind it). */
export interface ModelClient {
  chat(req: ModelRequest): Promise<ModelResponse>
}
