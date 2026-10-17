import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { Runner } from './runner.js'
import { buildServer } from './server.js'

async function main() {
  const cfg = loadConfig()
  if (!cfg.hmacSecret) logger.warn('INTERNAL_HMAC_SECRET is empty: /agents/run will reject every request')
  const runner = new Runner(cfg, logger)
  await runner.init()
  if (!cfg.mockLlm && runner.router.providers.length === 0) logger.warn('no LLM providers enabled (set NVIDIA_API_KEY / GROQ_API_KEY or run Ollama, or MOCK_LLM=true)')
  const app = buildServer(runner)
  await app.listen({ port: cfg.port, host: cfg.host })
  logger.info({ port: cfg.port, engine: runner.engine, mock_llm: cfg.mockLlm, providers: runner.router.status() }, 'harness listening')
  const stop = async () => {
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void stop())
  process.on('SIGTERM', () => void stop())
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal')
  process.exit(1)
})
