import path from 'node:path'

const bool = (v: string | undefined, d = false) => (v === undefined ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()))
const num = (v: string | undefined, d: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v))

const dataDir = process.env.WA_DATA_DIR ?? '/data'

export const config = {
  port: num(process.env.PORT ?? process.env.WA_BRIDGE_PORT, 3001),
  host: process.env.HOST ?? '0.0.0.0',
  apiUrl: (process.env.API_URL ?? 'http://api:8000').replace(/\/$/, ''),
  hmacSecret: process.env.INTERNAL_HMAC_SECRET ?? '',
  hmacMaxSkewSec: num(process.env.HMAC_MAX_SKEW_SEC, 300),
  requireHmacOnGet: bool(process.env.WA_REQUIRE_HMAC_ON_GET, false),
  mock: bool(process.env.WA_MOCK, false),
  /** DEMO_MODE (shared compose env) or WA_MOCK: seed the demo chats into an empty, never-configured allowlist. */
  demoMode: bool(process.env.DEMO_MODE, false),
  demoAllowedJids: (process.env.WA_DEMO_ALLOWED_JIDS ?? '120363000000000001@g.us,919800000002@s.whatsapp.net')
    .split(',').map((s) => s.trim()).filter(Boolean),
  approvalReplyTimeoutMs: num(process.env.WA_APPROVAL_REPLY_TIMEOUT_MS, 15_000),
  mockAutoConnectMs: num(process.env.WA_MOCK_AUTO_CONNECT_MS, 1500),
  dataDir,
  authDir: process.env.WA_AUTH_DIR ?? path.join(dataDir, 'auth'),
  dbPath: process.env.WA_DB_PATH ?? path.join(dataDir, 'wa-bridge.sqlite'),
  mediaDir: process.env.WA_MEDIA_DIR ?? path.join(dataDir, 'media'),
  maxMediaBytes: num(process.env.WA_MAX_MEDIA_BYTES, 16 * 1024 * 1024),
  sendRatePerMinute: num(process.env.WA_SEND_RATE_PER_MIN, 20),
  sendMinIntervalMs: num(process.env.WA_SEND_MIN_INTERVAL_MS, 1500),
  reconnectBaseMs: num(process.env.WA_RECONNECT_BASE_MS, 1000),
  reconnectMaxMs: num(process.env.WA_RECONNECT_MAX_MS, 60_000),
  forwardRetryIntervalMs: num(process.env.WA_FORWARD_RETRY_MS, 30_000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  baileysLogLevel: process.env.BAILEYS_LOG_LEVEL ?? 'warn',
  browserName: process.env.WA_BROWSER_NAME ?? 'RevenueGuard',
}
export type Config = typeof config
