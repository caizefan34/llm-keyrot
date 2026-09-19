/**
 * Real-provider standalone fetch example.
 *
 * Requires your own provider keys in env vars.
 * For a no-key deterministic demo, run:
 *   node examples/mock-rotation-demo.js
 */
import { KeyRotator } from '../lib/index.js'

let currentKey = process.env.OPENAI_API_KEY || ''

const rotator = new KeyRotator({
  providers: {
    openai: {
      activeKey: currentKey,
      pool: [process.env.OPENAI_KEY_2, process.env.OPENAI_KEY_3].filter(Boolean),
      cooldownMs: 30_000,
    },
  },
  onActivate(key) {
    currentKey = key
    const safe = key.length <= 10 ? `${key.slice(0, 2)}…` : `${key.slice(0, 6)}…${key.slice(-4)}`
    console.log('[example] switched active key to', safe)
  },
})

async function chatCompletion(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `******`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gpt-4o-mini', messages }),
  })

  if (res.status === 429) {
    const action = await rotator.onRateLimit('openai', { status: 429 })
    if (action?.kind === 'retry') return chatCompletion(messages)
  }

  return res.json()
}

if (!currentKey) {
  console.error('Missing OPENAI_API_KEY. Use mock demos in examples/ for keyless local verification.')
  process.exit(1)
}

const result = await chatCompletion([{ role: 'user', content: 'Say hello in one word.' }])
console.log(JSON.stringify(result, null, 2))
