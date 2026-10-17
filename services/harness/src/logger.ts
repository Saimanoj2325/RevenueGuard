import { pino } from 'pino'

const PHONE_RE = /(?<![\w.])\+?\d[\d\s-]{8,}\d(?![\w.])/g
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'harness' },
  hooks: {
    logMethod(args, method) {
      return method.apply(this, args.map((a) => (typeof a === 'string' ? a.replace(PHONE_RE, '***') : a)) as Parameters<typeof method>)
    },
  },
})
export type Logger = typeof logger
