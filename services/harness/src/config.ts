const bool = (v: string | undefined, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()))
const num = (v: string | undefined, d: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))

export interface ProviderConfig {
  name: 'nim' | 'groq' | 'ollama'
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
  /** INR per 1M tokens (assumed defaults; override per deployment) */
  costInPerMTok: number
  costOutPerMTok: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const providers: ProviderConfig[] = [
    {
      name: 'nim',
      baseUrl: (env.NIM_BASE_URL ?? 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
      apiKey: env.NVIDIA_API_KEY ?? '',
      model: env.NIM_MODEL || 'auto', // preference list, see NIM_BUILTIN in plugins/model-router.ts
      enabled: !!env.NVIDIA_API_KEY && !bool(env.NIM_DISABLED),
      costInPerMTok: num(env.NIM_COST_INR_PER_MTOK_IN, 25),
      costOutPerMTok: num(env.NIM_COST_INR_PER_MTOK_OUT, 100),
    },
    {
      name: 'groq',
      baseUrl: (env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
      apiKey: env.GROQ_API_KEY ?? '',
      model: env.GROQ_MODEL ?? 'openai/gpt-oss-120b',
      enabled: !!env.GROQ_API_KEY && !bool(env.GROQ_DISABLED),
      costInPerMTok: num(env.GROQ_COST_INR_PER_MTOK_IN, 13),
      costOutPerMTok: num(env.GROQ_COST_INR_PER_MTOK_OUT, 63),
    },
    {
      name: 'ollama',
      baseUrl: (env.OLLAMA_BASE_URL ?? 'http://host.docker.internal:11434/v1').replace(/\/$/, ''),
      apiKey: env.OLLAMA_API_KEY ?? 'ollama',
      model: env.OLLAMA_MODEL ?? 'qwen3:8b',
      enabled: !bool(env.OLLAMA_DISABLED),
      costInPerMTok: num(env.OLLAMA_COST_INR_PER_MTOK_IN, 0),
      costOutPerMTok: num(env.OLLAMA_COST_INR_PER_MTOK_OUT, 0),
    },
  ]
  const order = (env.LLM_PROVIDER_ORDER ?? 'nim,groq,ollama').split(',').map((s) => s.trim())
  providers.sort((a, b) => (order.indexOf(a.name) === -1 ? 99 : order.indexOf(a.name)) - (order.indexOf(b.name) === -1 ? 99 : order.indexOf(b.name)))

  const engine = (env.HARNESS_ENGINE ?? 'dsh').toLowerCase()
  return {
    port: num(env.PORT ?? env.HARNESS_PORT, 3100),
    host: env.HOST ?? '0.0.0.0',
    apiUrl: (env.API_URL ?? 'http://api:8000').replace(/\/$/, ''),
    hmacSecret: env.INTERNAL_HMAC_SECRET ?? '',
    hmacMaxSkewSec: num(env.HMAC_MAX_SKEW_SEC, 300),
    engine: (engine === 'builtin' ? 'builtin' : 'dsh') as 'dsh' | 'builtin',
    /** if the dsh packages fail to load, fall back to the builtin loop instead of failing runs */
    engineFallback: bool(env.HARNESS_ENGINE_FALLBACK, true),
    mockLlm: bool(env.MOCK_LLM, false),
    providers,
    llmTimeoutMs: num(env.LLM_TIMEOUT_MS, 60_000),
    llmTemperature: num(env.LLM_TEMPERATURE, 0.1),
    llmMaxOutputTokens: num(env.LLM_MAX_OUTPUT_TOKENS, 2048),
    breakerFailureThreshold: num(env.CB_FAILURE_THRESHOLD, 3),
    breakerCooldownMs: num(env.CB_COOLDOWN_MS, 30_000),
    toolTimeoutMs: num(env.TOOL_TIMEOUT_MS, 20_000),
    maxToolResultChars: num(env.MAX_TOOL_RESULT_CHARS, 12_000),
    maxConcurrentRuns: num(env.MAX_CONCURRENT_RUNS, 8),
    maxRepairRetries: Math.min(2, num(env.MAX_REPAIR_RETRIES, 2)),
    defaultBudget: {
      max_steps: num(env.DEFAULT_MAX_STEPS, 8),
      max_tokens: num(env.DEFAULT_MAX_TOKENS, 40_000),
      max_seconds: num(env.DEFAULT_MAX_SECONDS, 120),
      max_cost_inr: num(env.DEFAULT_MAX_COST_INR, 5),
    },
    eventsEnabled: !bool(env.EVENTS_DISABLED),
    logLevel: env.LOG_LEVEL ?? 'info',
  }
}

export type HarnessConfig = ReturnType<typeof loadConfig>
