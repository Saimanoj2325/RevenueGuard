import { ApiClient } from './api-client.js'
import { Bridge } from './bridge.js'
import { config } from './config.js'
import { logger } from './logger.js'
import { buildServer } from './server.js'
import { Store } from './store.js'
import { BaileysConnector } from './wa/baileys.js'
import { MockConnector } from './wa/mock.js'

async function main() {
  if (!config.hmacSecret) logger.warn('INTERNAL_HMAC_SECRET is empty: every signed endpoint will reject requests')
  const store = new Store(config.dbPath)
  const api = new ApiClient(config.apiUrl, config.hmacSecret, logger.child({ mod: 'api' }))
  const bridge = new Bridge(config, store, api, logger)
  bridge.connector = config.mock
    ? new MockConnector(bridge.hooks(), logger.child({ mod: 'mock' }), config.mockAutoConnectMs)
    : new BaileysConnector(
        {
          authDir: config.authDir,
          reconnectBaseMs: config.reconnectBaseMs,
          reconnectMaxMs: config.reconnectMaxMs,
          maxMediaBytes: config.maxMediaBytes,
          browserName: config.browserName,
          baileysLogLevel: config.baileysLogLevel,
        },
        bridge.hooks(),
        logger.child({ mod: 'wa' }),
      )
  const app = buildServer(bridge)
  await app.listen({ port: config.port, host: config.host })
  logger.info({ port: config.port, mode: bridge.connector.mode }, 'wa-bridge listening')
  bridge.startRetryLoop()
  bridge.connector.start().catch((err) => logger.error({ err }, 'connector start failed'))

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down')
    bridge.stop()
    await bridge.connector.stop().catch(() => {})
    await app.close()
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal')
  process.exit(1)
})
