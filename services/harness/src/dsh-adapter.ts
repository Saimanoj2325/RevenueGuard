/**
 * HARNESS_ENGINE=dsh — runs each agent as a real DeepSeek Harness (dsh) agent session.
 *
 * Verified against the published npm packages @deepseek-ai/*@0.2.0-rc.2 (+ @deepseek-ai/cordis@4.0.4):
 * the same in-process Cordis composition dsh's own agent-loop tests use
 *   new Context() + dsh-llm (LlmRuntime) + dsh-session + dsh-session-projection + dsh-system-prompt
 *   + dsh-tools (ToolRuntime) + dsh-agent (AgentRegistry) + dsh-agent-loop (AgentLoop)
 * and RevenueGuard contributes ordinary Cordis plugins on the documented extension points:
 *   model adapter  -> ctx.llm.registerAdapter(['revenueguard'], new RgRouterAdapter())   (LlmAdapter.stream/resolveModel)
 *   tools          -> ctx.tools.register(defineTool({...}))                              (HTTP to API /tools/<name>)
 *   tool policy    -> ctx.on('tools/pre-execute', ...) returning {kind:'deny', reason}
 *   untrusted/guard-> ctx.on('tools/post-execute', ...) returning {kind:'accept', content}
 *   events         -> ctx.on('session/event', ...) for step/start + step/end
 *   driving        -> ctx.agentLoop.create(SessionId, {provider, model}); agent.followup(createUserMessage(...));
 *                     agent.whenIdle(); agent.cancel({kind:'user'}) on budget/time
 *
 * dsh is a developer preview with breaking changes between versions; everything dsh-specific is isolated in
 * this file and loaded with dynamic import(), so the service still runs (builtin engine) if the packages are
 * missing or incompatible. Not used: dsh profiles/bundles launcher (`dsh --profile ...`), dsh-subagent seam
 * (each RevenueGuard agent is an isolated top-level dsh agent session in its own Cordis context instead).
 */
import type { Pipeline } from './core/pipeline.js'
import type { RunContext } from './core/run-context.js'
import type { ChatMessage, ChatToolCall, ModelClient, ToolOutcome, ToolSchemaJson, ToolSpec } from './core/types.js'
import { AllProvidersFailedError } from './plugins/model-router.js'
import type { Engine, EngineResult, EngineSession } from './engine/types.js'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any

interface DshModules {
  Context: Any
  LlmRuntime: Any
  LlmAdapter: Any
  createUserMessage: (m: Any) => Any
  ToolCallId: (s: string) => Any
  SessionStore: Any
  SessionId: (s: string) => Any
  SessionProjectionRegistry: Any
  SystemPrompt: Any
  ToolRuntime: Any
  defineTool: (o: Any) => Any
  AgentRegistry: Any
  AgentLoop: Any
  versions: Record<string, string>
}

let loaded: Promise<DshModules> | undefined

export async function loadDsh(): Promise<DshModules> {
  loaded ??= (async () => {
    const [cordis, llm, session, proj, sp, tools, agent, loop] = await Promise.all([
      import('@deepseek-ai/cordis' as string),
      import('@deepseek-ai/dsh-llm' as string),
      import('@deepseek-ai/dsh-session' as string),
      import('@deepseek-ai/dsh-session-projection' as string),
      import('@deepseek-ai/dsh-system-prompt' as string),
      import('@deepseek-ai/dsh-tools' as string),
      import('@deepseek-ai/dsh-agent' as string),
      import('@deepseek-ai/dsh-agent-loop' as string),
    ])
    const versions: Record<string, string> = {}
    try {
      const { createRequire } = await import('node:module')
      const req = createRequire(import.meta.url)
      for (const p of ['cordis', 'dsh-llm', 'dsh-tools', 'dsh-agent-loop']) versions[p] = req(`@deepseek-ai/${p}/package.json`).version
    } catch {
      /* informational only */
    }
    return {
      Context: cordis.Context,
      LlmRuntime: llm.default ?? llm.LlmRuntime,
      LlmAdapter: llm.LlmAdapter,
      createUserMessage: llm.createUserMessage,
      ToolCallId: llm.ToolCallId,
      SessionStore: session.default,
      SessionId: session.SessionId,
      SessionProjectionRegistry: proj.default,
      SystemPrompt: sp.default,
      ToolRuntime: tools.default,
      defineTool: tools.defineTool,
      AgentRegistry: agent.default,
      AgentLoop: loop.default,
      versions,
    }
  })()
  loaded.catch(() => {
    loaded = undefined
  })
  return loaded
}

export async function dshAvailable(): Promise<{ ok: true; versions: Record<string, string> } | { ok: false; error: string }> {
  try {
    const m = await loadDsh()
    return { ok: true, versions: m.versions }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

// ---------- message / chunk conversion (dsh <-> OpenAI-compatible) ----------

function blocksText(content: Any): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: Any) => b?.type === 'text')
    .map((b: Any) => b.text)
    .join('')
}

export function dshMessagesToChat(messages: Any[], system?: string): ChatMessage[] {
  const out: ChatMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    switch (m.role) {
      case 'system': {
        const text = blocksText(m.content)
        if (text) out.push({ role: 'system', content: text })
        break
      }
      case 'user':
      case 'developer':
        out.push({ role: 'user', content: blocksText(m.content) })
        break
      case 'assistant': {
        const text = blocksText(m.content)
        const calls: ChatToolCall[] = (Array.isArray(m.content) ? m.content : [])
          .filter((b: Any) => b?.type === 'tool-call')
          .map((b: Any) => ({ id: String(b.id), type: 'function' as const, function: { name: b.name, arguments: typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {}) } }))
        out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) })
        break
      }
      case 'tool':
        out.push({ role: 'tool', tool_call_id: String(m.toolCallId), content: blocksText(m.content) })
        break
      default:
        break
    }
  }
  return out
}

function dshToolsToChat(tools: Any[] | undefined): ToolSchemaJson[] {
  return (tools ?? []).map((t: Any) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
}

function specToDshParams(spec: ToolSpec): Record<string, Any> {
  const params: Record<string, Any> = {}
  for (const [k, p] of Object.entries(spec.params)) {
    const base = p.type === 'object' || p.type === 'array' ? { type: 'json' } : { type: p.type, ...(p.enum ? { enum: p.enum } : {}) }
    params[k] = { ...base, description: p.description, ...(p.required ? { required: true } : {}) }
  }
  return params
}

// ---------- engine ----------

const PROVIDER_ROUTE = 'revenueguard'

export class DshEngine implements Engine {
  readonly name = 'dsh' as const

  async open(run: RunContext, deps: { pipeline: Pipeline; model: ModelClient; systemPrompt: string; maxOutputTokens: number }): Promise<EngineSession> {
    const dsh = await loadDsh()
    const { pipeline, model } = deps
    const ctx = new dsh.Context()

    await ctx.plugin(dsh.LlmRuntime)
    await ctx.plugin(dsh.SessionStore)
    await ctx.plugin(dsh.SessionProjectionRegistry)
    await ctx.plugin(dsh.SystemPrompt, { personaPrefix: deps.systemPrompt, includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(dsh.ToolRuntime)
    await ctx.plugin(dsh.AgentRegistry)
    await ctx.plugin(dsh.AgentLoop, { agents: [], maxParallelToolCalls: 1 })

    let lastError: { reason: 'llm_unavailable' | 'error'; detail: string } | undefined
    let toolCallsThisStep = 0
    let stepOpen = false

    // (a) model adapter plugin: the RevenueGuard router behind dsh's LlmAdapter seam
    class RgRouterAdapter extends dsh.LlmAdapter {
      resolveModel(provider: string, modelId: string) {
        return Promise.resolve({ provider, id: modelId, name: modelId })
      }
      async *stream(options: Any): AsyncIterable<Any> {
        const gate = pipeline.gateModel(run)
        if (gate) throw new Error(`rg_stop:${gate.stop}:${gate.detail}`)
        pipeline.step(run, 'start')
        stepOpen = true
        toolCallsThisStep = 0
        const signal: AbortSignal = options.signal ? AbortSignal.any([options.signal, run.signal]) : run.signal
        let res
        try {
          res = await model.chat({
            messages: dshMessagesToChat(options.messages ?? [], options.system),
            tools: dshToolsToChat(options.tools),
            signal,
            agent: run.agent,
            maxOutputTokens: deps.maxOutputTokens,
            remainingMs: run.budget.max_seconds * 1000 - run.elapsedMs,
          } as Parameters<ModelClient['chat']>[0])
        } catch (err) {
          if (!run.signal.aborted) {
            lastError = err instanceof AllProvidersFailedError ? { reason: 'llm_unavailable', detail: err.message } : { reason: 'error', detail: (err as Error).message }
          }
          throw err
        }
        pipeline.afterModel(run, res)
        let index = 0
        if (res.content) {
          yield { type: 'block-start', index, blockType: 'text' }
          yield { type: 'text-delta', index, text: res.content }
          yield { type: 'block-end', index, block: { type: 'text', text: res.content } }
          index++
        }
        for (const tc of res.tool_calls) {
          const id = dsh.ToolCallId(tc.id)
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: tc.function.name, argumentsDelta: tc.function.arguments }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: tc.function.name, arguments: tc.function.arguments || '{}' } }
          index++
        }
        yield { type: 'usage', usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } }
        yield { type: 'finish', reason: { kind: res.tool_calls.length ? 'tool-calls' : 'stop' } }
      }
    }
    await ctx.plugin({
      name: 'revenueguard-model-adapter',
      inject: ['llm'],
      apply(c: Any) {
        c.llm.registerAdapter([PROVIDER_ROUTE], new RgRouterAdapter())
      },
    })

    // (b) RevenueGuard tool plugin: only this agent's allow-listed tools are registered
    const rawOutcomes = new Map<string, ToolOutcome>()
    await ctx.plugin({
      name: 'revenueguard-tools',
      inject: ['tools'],
      apply(c: Any) {
        for (const spec of pipeline.toolsFor(run.agent)) {
          c.tools.register(
            dsh.defineTool({
              name: spec.name,
              description: spec.description,
              parameters: specToDshParams(spec),
              output: { schema: { type: 'json' }, render: (_a: Any, v: Any) => [{ type: 'text', text: JSON.stringify(v) }] },
              async execute(args: Any, exec: Any) {
                const callId = String(exec.callId)
                const outcome = await pipeline.execute(run, { id: callId, name: spec.name, args: { ...args } }, exec.signal)
                rawOutcomes.set(callId, outcome)
                return JSON.parse(JSON.stringify({ ok: outcome.ok, data: outcome.data ?? null, evidence_node_ids: outcome.evidence_node_ids, ...(outcome.error ? { error: outcome.error } : {}) }))
              },
            }),
          )
        }
      },
    })

    // (c) tool-policy (+ evidence guard) on the tools/pre-execute waterfall
    await ctx.plugin({
      name: 'revenueguard-tool-policy',
      apply(c: Any) {
        c.on('tools/pre-execute', async (exec: Any, next: () => Promise<Any>) => {
          const call = { id: String(exec.callId), name: String(exec.name), args: { ...(exec.arguments ?? {}) } }
          const d = await pipeline.pre(run, call)
          if (d.kind === 'deny') {
            rawOutcomes.set(call.id, pipeline.deniedOutcome(d.reason))
            return { kind: 'deny', reason: d.reason }
          }
          return next()
        })
      },
    })

    // (d) untrusted-content + evidence-guard + tool_result events on tools/post-execute
    await ctx.plugin({
      name: 'revenueguard-post-execute',
      apply(c: Any) {
        c.on('tools/post-execute', async (exec: Any, result: Any, next: () => Promise<Any>) => {
          const callId = String(exec.callId)
          const call = { id: callId, name: String(exec.name), args: { ...(exec.arguments ?? {}) } }
          const raw =
            rawOutcomes.get(callId) ??
            ({ ok: !result.isError, data: null, evidence_node_ids: [], text: blocksText(result.content), ...(result.isError ? { error: blocksText(result.content) } : {}) } as ToolOutcome)
          rawOutcomes.delete(callId)
          toolCallsThisStep++
          const final = await pipeline.post(run, call, raw)
          if (result.isError) return next()
          return { kind: 'accept', content: [{ type: 'text', text: final.text }] }
        })
      },
    })

    // (f) step events from the durable session log
    await ctx.plugin({
      name: 'revenueguard-step-events',
      apply(c: Any) {
        c.on('session/event', (_s: Any, ev: Any) => {
          if (ev?.type === 'step/end' && stepOpen) {
            stepOpen = false
            pipeline.step(run, 'end', toolCallsThisStep)
          }
        })
      },
    })

    const agent = await ctx.agentLoop.create(dsh.SessionId(`rg-${run.runId}`), { provider: PROVIDER_ROUTE, model: 'router', maxTokens: deps.maxOutputTokens })
    const onAbort = () => {
      try {
        agent.cancel({ kind: 'user' })
      } catch {
        /* already idle */
      }
    }
    run.signal.addEventListener('abort', onAbort, { once: true })

    return {
      async send(userText: string): Promise<EngineResult> {
        lastError = undefined
        const firstSeq = agent.session.seq
        agent.followup(dsh.createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }))
        await agent.whenIdle()
        const events: Any[] = agent.session.snapshotEvents().slice(firstSeq)
        let text: string | null = null
        let endReason: Any
        for (const ev of events) {
          if (ev.type === 'assistant/message') {
            const t = blocksText(ev.data?.message?.content)
            if (t) text = t
          }
          if (ev.type === 'turn/end') endReason = ev.data?.reason
        }
        if (run.stop) return { text: null, stopped: { reason: run.stop.reason, detail: run.stop.detail } }
        if (lastError) return { text: null, error: lastError }
        if (endReason && endReason.kind && endReason.kind !== 'completed') {
          return { text: null, error: { reason: 'error', detail: `dsh turn ended: ${endReason.kind}${endReason.error?.message ? ` (${endReason.error.message})` : ''}` } }
        }
        return { text }
      },
      async dispose() {
        run.signal.removeEventListener('abort', onAbort)
        try {
          await ctx.scope?.dispose?.()
        } catch {
          /* best effort */
        }
      },
    }
  }
}
