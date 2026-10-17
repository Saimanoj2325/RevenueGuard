// usage: node scripts/sign.mjs '<json body>'  -> prints curl -H args for HMAC
import crypto from 'node:crypto'
const body = process.argv[2] ?? ''
const secret = process.env.INTERNAL_HMAC_SECRET ?? 'dev'
const sig = crypto.createHmac('sha256', secret).update(body).digest('hex')
console.log(`-H X-RG-Signature:sha256=${sig} -H X-RG-Timestamp:${Math.floor(Date.now() / 1000)}`)
