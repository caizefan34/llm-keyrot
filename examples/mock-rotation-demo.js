/**
 * Deterministic no-key demo:
 * 1) first request with key-a returns 429
 * 2) rotator switches to key-b
 * 3) retry succeeds
 */
import { KeyRotator } from '../lib/index.js'
import { createRetryInterceptor } from '../adapters/http-interceptor.js'

let activeKey = 'demo-key-a'

const rotator = new KeyRotator({
  providers: {
    demo: { activeKey, pool: ['demo-key-b'], cooldownMs: 25 },
  },
  onActivate(next) {
    activeKey = next
    console.log('[demo] activated key:', next.replace(/-(.)[^-]+$/, '-$1***'))
  },
})

const callCountByKey = new Map()

const send = createRetryInterceptor(rotator, 'demo', async () => {
  const count = (callCountByKey.get(activeKey) ?? 0) + 1
  callCountByKey.set(activeKey, count)

  if (activeKey === 'demo-key-a' && count === 1) {
    return {
      status: 429,
      headers: { 'retry-after-ms': '50' },
      body: { error: 'rate_limited_key_a' },
    }
  }

  return {
    status: 200,
    headers: {},
    body: { ok: true, keyUsed: activeKey, attemptsWithThisKey: count },
  }
}, { maxRetries: 2 })

const result = await send('https://mock.local/chat', { method: 'POST' })
console.log('[demo] final result:', result)
