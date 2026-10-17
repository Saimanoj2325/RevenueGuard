/** Orchestrates one /agents/run: RunContext -> engine session -> validate/repair -> run_finished | run_failed. */
import { buildSystemPrompt, buildUserMessage } from './agents/definitions.js'
import type { HarnessConfig } from './config.js'
import type { FailReason, RunRequest } from './contract.js'
import { Pipeline } from './core/pipeline.js'
import type { RgPlugin } from './core/plugin.js'
import { RunContext } from './core/run-context.js'
import type { ModelClient } from './core/types.js'
import { DshEngine, dshAvailable } from './dsh-adapter.js'
import { BuiltinEngine } from './engine/builtin.js'
import type { Engine, EngineResult } from './engine/types.js'
import type { Logger } from './logger.js'
import { BudgetPlugin } from './plugins/budget.js'
import { EventSink, EventSinkPlugin } from './plugins/event-sink.js'
import { EvidenceGuardPlugin } from './plugins/evidence-guard.js'
import { MockLlmProvider } from './plugins/mock-llm.js'
import { ModelRouter, OpenAICompatProvider, type ModelProvider } from './plugins/model-router.js'
import { OutputSchemaPlugin, repairPrompt } from './plugins/output-schema.js'
import { TOOL_SPEC_MAP, ToolExecutor } from './plugins/rg-tools.js'
import { ToolPolicyPlugin } from './plugins/tool-policy.js'
import { UntrustedContentPlugin } from './plugins/untrusted-content.js'
import type { InvestigationOutputT } from './schemas.js'

export interface RunResponse {
  run_id: string
  case_id: string
  agent: string
  status: 'finished' | 'failed'
  output?: unknown
  reason?: FailReason
  detail?: string
  stop_reason?: string
  errors?: string[]
  repairs: number
  engine: 'dsh' | 'builtin'
  usage: ReturnType<RunContext['usage']>
}

export function buildProviders(cfg: HarnessConfig): ModelProvider[] {
  if (cfg.mockLlm) return [new MockLlmProvider()]
  return cfg.providers.filter((p) => p.enabled).map((p) => new OpenAICompatProvider(p, { temperature: cfg.llmTemperature, maxOutputTokens: cfg.llmMaxOutputTokens }))
}

export class Runner {
  readonly sink: EventSink
  readonly policy: ToolPolicyPlugin
  readonly router: ModelRouter
  readonly pipeline: Pipeline
  readonly output: OutputSchemaPlugin
  private engineName: 'dsh' | 'builtin'
  private engines: Record<'dsh' | 'builtin', Engine> = { dsh: new DshEngine(), builtin: new BuiltinEngine() }
  dshStatus: { ok: boolean; versions?: Record<string, string>; error?: string } = { ok: false, error: 'not checked' }

  constructor(
    readonly cfg: HarnessConfig,
    readonly log: Logger,
    opts: { model?: ModelClient & Partial<ModelRouter>; fetchImpl?: typeof fetch; plugins?: RgPlugin[] } = {},
  ) {
    this.sink = new EventSink(cfg.apiUrl, cfg.hmacSecret, log, cfg.eventsEnabled, opts.fetchImpl)
    this.policy = new ToolPolicyPlugin(log)
    this.router = new ModelRouter(buildProviders(cfg), { timeoutMs: cfg.llmTimeoutMs, breakerThreshold: cfg.breakerFailureThreshold, breakerCooldownMs: cfg.breakerCooldownMs }, log)
    this.model = opts.model ?? this.router
    const executor = new ToolExecutor({ apiUrl: cfg.apiUrl, secret: cfg.hmacSecret, timeoutMs: cfg.toolTimeoutMs, maxResultChars: cfg.maxToolResultChars, fetchImpl: opts.fetchImpl })
    // plugin order = waterfall order: budget gate, policy, stop-rule guard, untrusted wrapping, event sink
    const plugins: RgPlugin[] = opts.plugins ?? [new BudgetPlugin(), this.policy, new EvidenceGuardPlugin(), new UntrustedContentPlugin(TOOL_SPEC_MAP), new EventSinkPlugin()]
    this.pipeline = new Pipeline(plugins, TOOL_SPEC_MAP, executor, (a) => this.policy.visibleTools(a))
    this.output = new OutputSchemaPlugin(cfg.maxRepairRetries)
    this.engineName = cfg.engine
  }

  private model: ModelClient

  get engine(): 'dsh' | 'builtin' {
    return this.engineName
  }

  async init(): Promise<void> {
    if (this.cfg.engine !== 'dsh') return
    const st = await dshAvailable()
    this.dshStatus = st.ok ? { ok: true, versions: st.versions } : { ok: false, error: st.error }
    if (!st.ok) {
      if (!this.cfg.engineFallback) throw new Error(`HARNESS_ENGINE=dsh but dsh packages failed to load: ${st.error}`)
      this.log.warn({ error: st.error }, 'dsh packages unavailable; falling back to builtin engine')
      this.engineName = 'builtin'
    }
  }

  async run(req: RunRequest): Promise<RunResponse> {
    const budget = { ...this.cfg.defaultBudget, ...(req.budget ?? {}) }
    const emit = this.sink.emitter({ runId: req.run_id, caseId: req.case_id, correlationId: req.correlation_id, agent: req.agent })
    const run = new RunContext(req.run_id, req.case_id, req.correlation_id, req.agent, req.input, budget, emit)
    const disarm = BudgetPlugin.armTimer(run)
    const engine = this.engines[this.engineName]
    const systemPrompt = buildSystemPrompt(req.agent, this.pipeline.systemRules(req.agent))
    let repairs = 0
    let session
    const finish = (r: Omit<RunResponse, 'run_id' | 'case_id' | 'agent' | 'repairs' | 'engine' | 'usage'>): RunResponse => {
      const resp: RunResponse = { run_id: req.run_id, case_id: req.case_id, agent: req.agent, ...r, repairs, engine: engine.name, usage: run.usage() }
      if (r.status === 'finished') emit('run_finished', { output: r.output, ...(r.stop_reason ? { stop_reason: r.stop_reason } : {}), usage: resp.usage, engine: engine.name, repairs })
      else emit('run_failed', { reason: r.reason, detail: r.detail, ...(r.errors ? { errors: r.errors } : {}), usage: resp.usage, engine: engine.name, repairs })
      return resp
    }
    try {
      session = await engine.open(run, { pipeline: this.pipeline, model: this.model, systemPrompt, maxOutputTokens: this.cfg.llmMaxOutputTokens })
      let result: EngineResult = await session.send(buildUserMessage(req.agent, req.case_id, req.input, budget))
      for (;;) {
        if (result.stopped) return finish(this.onStopped(run, result.stopped))
        if (result.error) return finish({ status: 'failed', reason: result.error.reason, detail: result.error.detail })
        const v = this.output.validate(run, result.text)
        if (v.ok) {
          const out = v.output as Record<string, unknown>
          return finish({ status: 'finished', output: out, ...(req.agent === 'investigation' ? { stop_reason: String(out.stop_reason) } : {}) })
        }
        if (repairs >= this.output.maxRepairs) {
          return finish({ status: 'failed', reason: 'invalid_output', detail: `output failed validation after ${repairs} repair attempts`, errors: v.errors })
        }
        repairs += 1
        run.repairing = true
        this.log.info({ run_id: run.runId, agent: run.agent, attempt: repairs, errors: v.errors }, 'output invalid; requesting repair')
        result = await session.send(repairPrompt(req.agent, v.errors, repairs, this.output.maxRepairs))
      }
    } catch (err) {
      this.log.error({ err, run_id: req.run_id }, 'run crashed')
      if (run.stop) return finish(this.onStopped(run, { reason: run.stop.reason, detail: run.stop.detail }))
      return finish({ status: 'failed', reason: 'error', detail: (err as Error).message })
    } finally {
      disarm()
      await session?.dispose().catch(() => {})
      await this.sink.flush(3000)
    }
  }

  /**
   * Budget/cancel stop. The investigation schema has stop_reason "budget", so code (not the model) builds an
   * honest partial output from the recorded tool log. Other agents have no budget outcome -> run_failed "budget".
   */
  private onStopped(run: RunContext, s: { reason: string; detail: string }): Omit<RunResponse, 'run_id' | 'case_id' | 'agent' | 'repairs' | 'engine' | 'usage'> {
    if (s.reason === 'budget' && run.agent === 'investigation') {
      const out: InvestigationOutputT = {
        steps: run.toolLog
          .filter((t) => !t.denied)
          .map((t) => ({ tool: t.tool, why: 'Recorded by the harness: budget exhausted before the agent produced its final answer.', added_evidence: t.evidence_node_ids.length > 0, evidence_node_ids: t.evidence_node_ids })),
        findings: [`Investigation stopped by budget: ${s.detail}. Gap not confirmed closed; needs human review.`],
        stop_reason: 'budget',
        conflict: false,
      }
      return { status: 'finished', output: out, stop_reason: 'budget', detail: s.detail }
    }
    return { status: 'failed', reason: s.reason === 'budget' ? 'budget' : 'cancelled', detail: s.detail }
  }
}
