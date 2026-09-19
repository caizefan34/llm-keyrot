/**
 * Deterministic Anthropic integration demo (no real key required).
 * Shows in-process API-key rotation on a mocked 429 response.
 */
import { KeyRotator } from '../lib/index.js'
import { createRetryInterceptor } from '../adapters/http-interceptor.js'

let anthropicKey = process.env.ANTHROPIC_API_KEY || 'anthropic-demo-key-a'
const anthropicPool = [process.env.ANTHROPIC_API_KEY_2 || 'anthropic-demo-key-b']

const rotator = new KeyRotator({
  providers: {
    anthropic: { activeKey: anthropicKey, pool: anthropicPool, cooldownMs: 25 },
  },
  onActivate(nextKey) {
    anthropicKey = nextKey
    console.log('[anthropic-demo] activated key:', nextKey)
  },
})

const callsByKey = new Map()
const send = createRetryInterceptor(rotator, 'anthropic', async () => {
  const count = (callsByKey.get(anthropicKey) ?? 0) + 1
  callsByKey.set(anthropicKey, count)

  if (anthropicKey.endsWith('-a') && count === 1) {
    return {
      status: 429,
      headers: { 'retry-after-ms': '50' },
      body: { error: 'rate_limited' },
    }
  }

  return {
    status: 200,
    headers: {},
    body: { ok: true, provider: 'anthropic', keyUsed: anthropicKey },
  }
}, { maxRetries: 2 })

const result = await send('https://api.anthropic.com/v1/messages', { method: 'POST' })
console.log('[anthropic-demo] final result:', result)
