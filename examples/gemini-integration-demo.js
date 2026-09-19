/**
 * Deterministic Gemini integration demo (no real key required).
 * Shows in-process API-key rotation on a mocked 429 response.
 */
import { KeyRotator } from '../lib/index.js'
import { createRetryInterceptor } from '../adapters/http-interceptor.js'

let geminiKey = process.env.GEMINI_API_KEY || 'gemini-demo-key-a'
const geminiPool = [process.env.GEMINI_API_KEY_2 || 'gemini-demo-key-b']

const rotator = new KeyRotator({
  providers: {
    gemini: { activeKey: geminiKey, pool: geminiPool, cooldownMs: 25 },
  },
  onActivate(nextKey) {
    geminiKey = nextKey
    console.log('[gemini-demo] activated key:', nextKey)
  },
})

const callsByKey = new Map()
const send = createRetryInterceptor(rotator, 'gemini', async () => {
  const count = (callsByKey.get(geminiKey) ?? 0) + 1
  callsByKey.set(geminiKey, count)

  if (geminiKey.endsWith('-a') && count === 1) {
    return {
      status: 429,
      headers: { 'retry-after-ms': '50' },
      body: { error: 'rate_limited' },
    }
  }

  return {
    status: 200,
    headers: {},
    body: { ok: true, provider: 'gemini', keyUsed: geminiKey },
  }
}, { maxRetries: 2 })

const result = await send('https://generativelanguage.googleapis.com/v1beta/models/gemini:generateContent', { method: 'POST' })
console.log('[gemini-demo] final result:', result)
