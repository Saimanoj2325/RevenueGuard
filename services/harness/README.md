# harness — RevenueGuard agent runtime on DeepSeek Harness (dsh)

Node 22 + TypeScript service (port **3100**). The API calls `POST /agents/run`; the harness runs one of the four
agents (triage, evidence, investigation, resolution) with only its allow-listed read-only tools, streams progress
to the API, validates the final JSON against the contract schema and returns it.

## Two engines — which is which

| `HARNESS_ENGINE` | What runs | Status |
|---|---|---|
| `dsh` (default) | A real **DeepSeek Harness agent session** per run: `@deepseek-ai/cordis` Context + dsh core plugins (`dsh-llm`, `dsh-session`, `dsh-session-projection`, `dsh-system-prompt`, `dsh-tools`, `dsh-agent`, `dsh-agent-loop`). The dsh agent loop drives steps; RevenueGuard plugs in as Cordis plugins (see below). All dsh code is isolated in `src/dsh-adapter.ts`, loaded by dynamic `import()`. | **Verified** against npm `@deepseek-ai/*@0.2.0-rc.2` + `cordis@4.0.4` (all tests run on it) |
| `builtin` | `src/engine/builtin.ts`: a small loop implementing the same plugin interfaces (model → tools → pre/post hooks → repeat). | Verified (same test suite) |

If `dsh` is requested but the packages fail to load, the service falls back to `builtin` and logs a warning
(`HARNESS_ENGINE_FALLBACK=false` makes that fatal). `GET /health` shows `engine`, `engine_requested`, and the dsh versions it loaded.

dsh is in **developer preview with breaking changes**. The dsh packages are pinned exactly (`optionalDependencies`).
The GitHub `master` is already ahead of npm (`0.2.1-alpha.x`). Check `src/dsh-adapter.ts` before you bump them.

### dsh APIs: confirmed vs assumed
Confirmed by running them (probe script, then this service's tests, on 0.2.0-rc.2):
- `new Context()` with `ctx.plugin(LlmRuntime | SessionStore | SessionProjectionRegistry | SystemPrompt | ToolRuntime | AgentRegistry | AgentLoop)`. This is the in-process composition dsh's own `agent-loop` tests use.
- `SystemPrompt` config `{personaPrefix, includeHarnessIdentity:false, includeRuntimeContext:false}`.
- `class extends LlmAdapter { resolveModel(); async *stream(GenerateOptions) }` emitting `StreamChunk`s (`block-start`, `text-delta`, `tool-call-delta`, `block-end`, `usage`, `finish{kind:'stop'|'tool-calls'}`), then `ctx.llm.registerAdapter(['revenueguard'], adapter)`.
- `ctx.tools.register(defineTool({name, description, parameters, output:{schema:{type:'json'}, render}, execute(args, exec)}))`.
- `ctx.on('tools/pre-execute', (exec, next) => {kind:'deny', reason} | next())`. It also fires for tool names that are not registered, so the policy plugin sees and logs those too.
- `ctx.on('tools/post-execute', (exec, result, next) => {kind:'accept', content:[…]})` to replace model-facing content.
- `ctx.on('session/event', …)` with `step/start`, `step/end`, `assistant/message`, `turn/end` events.
- `ctx.agentLoop.create(SessionId, {provider, model, maxTokens})`, `agent.followup(createUserMessage({content, source:{kind:'user'}}))`, `agent.whenIdle()`, `agent.session.seq` / `snapshotEvents()`, `agent.cancel({kind:'user'})`.
- Throwing from `LlmAdapter.stream()` ends the turn. The harness uses this to enforce budget stops.

Not used, or assumed:
- **Launcher.** This service does not use the dsh launcher, profiles or bundles (`dsh --profile …`, `cordis.patch.yml`). The docs class direct in-process mounting as "not a Harness application launcher", so we use the same composition dsh's tests use. A packaged dsh *bundle* for RevenueGuard would be the next step.
- **Subagents.** We do not use the `ctx.subagents` seam. Each RevenueGuard agent is an **isolated top-level dsh agent session in its own Cordis context**, per run, with only its allow-listed tools registered. The contract calls these "dsh subagents". In practice the API's orchestrator is the parent.
- **Cleanup.** `ctx.scope.dispose()` is called best-effort on run end. Its exact semantics were not checked.
- **Output tokens.** Model calls are non-streaming (`stream:false`) against the providers. The adapter re-emits each response as one dsh chunk sequence.

## Endpoints
- `POST /agents/run` (**HMAC**). Body as in the contract: `{run_id, case_id, correlation_id, agent, input, budget?}`. Missing budget fields fall back to `DEFAULT_MAX_*` (8 steps / 40k tokens / 120 s / ₹5). Response:
  `{run_id, case_id, agent, status:"finished"|"failed", output?, reason?:"invalid_output"|"budget"|"llm_unavailable"|"cancelled"|"error", detail?, stop_reason?, errors?, repairs, engine, usage:{steps, model_calls, input_tokens, output_tokens, cost_inr, elapsed_ms, providers}}`.
  - Calls are idempotent on `run_id`: a repeat returns the cached result with `replayed:true`.
  - `MAX_CONCURRENT_RUNS` (8) caps parallel runs; extra calls get 429.
- `GET /health`: engine, dsh versions, providers and breaker states, event delivery counts.
- `GET /agents`: the allow-lists.
- `GET /policy/denials`: recent policy denials.
- `GET /runs/:id/events`: events kept in memory, for debugging.

Events go to `POST {API_URL}/internal/agent-events` (HMAC): `{run_id, case_id, type, agent, data, ts}` plus the extras `correlation_id` and `seq`.
- Types: `step_started`, `model_call` (provider, model, latency, tokens, cost_inr, fallback_from), `tool_call`, `tool_result` (ok, denied, reason, evidence_node_ids, untrusted_flag), `step_finished`, `run_finished` (output, stop_reason, usage), `run_failed` (reason, detail, errors).
- Events are delivered in order with retries. They are flushed (up to 3 s) before `/agents/run` responds.

## Plugins (`src/plugins/`, interface in `src/core/plugin.ts`, which mirrors the dsh hooks)
- **(a) `model-router.ts`: model adapter.**
  - OpenAI-compatible `/chat/completions` router. Order is NIM (`NIM_MODEL` = auto: first working model from a built-in list; a 404 moves to the next), then Groq (`GROQ_MODEL`), then Ollama (`OLLAMA_MODEL`). Change the order with `LLM_PROVIDER_ORDER`.
  - A provider is enabled when its key is set. Ollama is on unless `OLLAMA_DISABLED=true`.
  - Each provider has a circuit breaker: it opens after `CB_FAILURE_THRESHOLD` (3) failures and goes half-open after `CB_COOLDOWN_MS` (30 s).
  - Per-call timeout is `LLM_TIMEOUT_MS`, capped by the run's remaining time.
  - A cancelled run does not trip the breaker.
  - INR cost per call uses `*_COST_INR_PER_MTOK_IN/OUT`. The defaults are **assumed** placeholders (NIM 25/100, Groq 13/63, Ollama 0). Set real ones.
  - If every provider fails, the run fails with `run_failed` `llm_unavailable`.
- **(b) `rg-tools.ts`: RevenueGuard tools.**
  - The contract's 18 tools. Each is `POST {API_URL}/tools/<name>` with body `{case_id, correlation_id, args}` and headers HMAC, `X-RG-Agent`, `X-RG-Run-Id`, `X-Correlation-Id`.
  - **Argument names are this service's proposal**; the API owns final semantics, and extra args pass through.
  - A 403 from the API is surfaced as a denial.
- **(c) `tool-policy.ts`: tool policy.**
  - Enforces the per-agent allow-lists from the contract. Only allowed tools are shown to the model.
  - Every call is re-checked. Anything else is denied, logged, and emitted as `tool_result{denied:true}`.
  - Write-tool patterns (`zoho_create*`, `whatsapp_send`, `gmail_send`, …) are always denied, even if an allow-list is misconfigured.
- **(d) `untrusted-content.ts`: untrusted content.**
  - Results from tools that carry external text, and the case snapshot itself, are wrapped in `<untrusted_content source=… call_id=…> … </untrusted_content>`. Delimiter look-alikes inside the payload are neutralised.
  - Injection patterns (`SYSTEM:`, "mark … paid", "close the case", …) are flagged with `untrusted_flag`.
  - A system rule tells the model that this content can't grant permissions.
- **(e) `output-schema.ts`: output schema.**
  - Validates the final output with zod schemas from the contract (`src/schemas.ts`). Resolution claims need at least one evidence id.
  - Grounding checks: cited evidence ids must exist in the case snapshot or in tool results, and investigation steps must name tools that were actually called.
  - Up to 2 repair turns. After that the run fails with `run_failed` `invalid_output`.
- **(f) `event-sink.ts`: event sink**, as described above.
- **(g) `budget.ts`: budget.**
  - Enforces `max_steps`, `max_tokens`, `max_seconds` (a wall-clock timer aborts in-flight calls) and `max_cost_inr`.
  - When a limit is hit, the loop stops. Investigation then returns an honest partial output with `stop_reason:"budget"`, built by code from the recorded tool log. The other agents fail with `run_failed` `budget`.
  - Repair turns are exempt from `max_steps` only.
- **`evidence-guard.ts`: investigation stop rule in code.** After 2 consecutive tool steps with no *new* evidence node, the model is told to finalize with `no_new_evidence`, and further tools are denied.

### Agents (`src/agents/definitions.ts`)
System prompts follow the design doc:
- **Triage:** Laya signals → extract → attach/open the case → type and severity.
- **Evidence collection:** builds the order → delivery → invoice → payment timeline. Decoys are excluded; missing links stay visible.
- **Adaptive investigation:** picks the next read-only check from the current gap and its competing explanations. It records the *why* for each check and whether it added evidence. Stop rules: gap closed / 2 steps with no new evidence / conflict / budget.
- **Resolution:** amounts come from `compute_billable`, and full-order invoices are never proposed just because an invoice is missing. The latest correction is used and cited. Every claim cites evidence ids, and uncertainty is stated.

Note for the API team: the stop rule counts evidence ids. A negative finding ("no invoice under alternate IDs") should return an evidence node id, as `scripts/fixtures.ts` does. Otherwise two negative checks in a row trigger `no_new_evidence`, and the resolution step has nothing to cite for "no invoice exists".

## MOCK_LLM=true
`src/plugins/mock-llm.ts` is a deterministic provider behind the same router, so policy, wrapping, events, budget and schema all still run. It plays the PO-184 / RG-1042 story:
- **Triage:** High / `missing_invoice`.
- **Investigation:** `search_alt_ids` (no match) → `search_credit_notes` (none) → `sheets_read_delivery` (60) → `get_billing_rules` (partial allowed) → `gap_closed`.
- **Resolution:** `create_invoice` for ₹60,000. It becomes **₹70,000** when the snapshot or tool results contain "Correction: 70 delivered".

`input._mock.garbage_outputs = N` (or `MOCK_LLM_GARBAGE=N`) makes the first N final answers invalid. This exercises repair and the `invalid_output` failure, for the `garbage_output` demo chaos.

## Run / test
```bash
npm ci && npm run build && npm test          # 36 vitest tests; engine tests run on BOTH dsh and builtin
# local smoke without the real API:
INTERNAL_HMAC_SECRET=dev PORT=18000 npx tsx scripts/mock-api.ts &       # fake API: /tools/* fixtures + event capture
INTERNAL_HMAC_SECRET=dev API_URL=http://127.0.0.1:18000 MOCK_LLM=true HARNESS_ENGINE=dsh npm start
B='{"run_id":"r1","case_id":"RG-1042","correlation_id":"c1","agent":"triage","input":{}}'
curl -X POST localhost:3100/agents/run -H 'content-type: application/json' $(node scripts/sign.mjs "$B") -d "$B"
docker build -t revenueguard/harness .
```

Env: `PORT` `API_URL` `INTERNAL_HMAC_SECRET` `HARNESS_ENGINE` `HARNESS_ENGINE_FALLBACK` `MOCK_LLM` `MOCK_LLM_GARBAGE` `NVIDIA_API_KEY` `NIM_BASE_URL` `NIM_MODEL` `GROQ_API_KEY` `GROQ_BASE_URL` `GROQ_MODEL` `OLLAMA_BASE_URL` `OLLAMA_MODEL` `OLLAMA_DISABLED` `LLM_PROVIDER_ORDER` `LLM_TIMEOUT_MS` `LLM_TEMPERATURE` `LLM_MAX_OUTPUT_TOKENS` `CB_FAILURE_THRESHOLD` `CB_COOLDOWN_MS` `*_COST_INR_PER_MTOK_IN/OUT` `TOOL_TIMEOUT_MS` `MAX_TOOL_RESULT_CHARS` `MAX_CONCURRENT_RUNS` `MAX_REPAIR_RETRIES` `DEFAULT_MAX_STEPS|TOKENS|SECONDS|COST_INR` `EVENTS_DISABLED` `LOG_LEVEL`.

## Layout
```
src/index.ts  server.ts  runner.ts  config.ts  contract.ts  schemas.ts  hmac.ts  logger.ts
src/dsh-adapter.ts                 # HARNESS_ENGINE=dsh (all dsh imports live here)
src/engine/builtin.ts  types.ts    # HARNESS_ENGINE=builtin + engine seam
src/core/plugin.ts pipeline.ts run-context.ts types.ts
src/plugins/model-router.ts mock-llm.ts rg-tools.ts tool-policy.ts untrusted-content.ts output-schema.ts event-sink.ts budget.ts evidence-guard.ts
src/agents/definitions.ts          # 4 agent system prompts
scripts/mock-api.ts fixtures.ts sign.mjs   # test-only fake API + HMAC header helper
tests/*.test.ts                    # policy, schema, budget, router fallback/breaker, end-to-end on both engines
```
