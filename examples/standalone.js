/**
 * Minimal standalone example using llm-keyrot with fetch.
 *
 * Run:
 *   export OPENAI_API_KEY="sk-…" OPENAI_KEY_2="sk-…"
 *   node examples/standalone.js
 *
 * (The 429 won't trigger in normal use — this shows the wiring.)
 */
import { KeyRotator } from '../lib/index.js'

let currentKey = process.env.OPENAI_API_KEY || ''

const rotator = new KeyRotator({
  providers: {
    openai: {
      activeKey: currentKey,
      pool: [
        process.env.OPENAI_KEY_2,
      ].filter(Boolean),
      cooldownMs: 30_000,
    },
  },
  onActivate(key) {
    currentKey = key
    console.log('[example] active key switched to', key.slice(0, 6) + '…')
  },
})

async function chatCompletion(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${currentKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
  })

  if (res.status === 429) {
    console.log('[example] hit rate limit, asking rotator…')
    const action = await rotator.onRateLimit('openai', { status: 429 })
    if (action?.kind === 'retry') {
      console.log('[example] key rotated, retrying…')
      return chatCompletion(messages)
    }
    console.log('[example] no recovery, returning error body')
    return res.json()
  }

  return res.json()
}

// Quick smoke test
const result = await chatCompletion([{ role: 'user', content: 'Say hello in one word.' }])
console.log('Result:', JSON.stringify(result, null, 2))
