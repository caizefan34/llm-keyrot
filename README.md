# llm-keyrot

**Auto-failover API key pool for LLM providers.**  
When a key hits a rate limit, rotate to the next.  
When all keys are cooling, wait for recovery.  
Optionally fall back to a different provider.

```js
const action = await rotator.onRateLimit('openai', { status: 429 })
if (action?.kind === 'retry') {
  // request was retried with a different key
}
```

## Why

You're running a long LLM task — a batch of translations, a chain-of-thought evaluation, a multi-turn agent session. Then suddenly:

```
429 Too Many Requests
```

With the default retry, it fails. With this, it **keeps going**.

## How it works

```
request → 429 / RATE_LIMIT / QUOTA
  ↓
[llm-keyrot]
  1. Cool down the failed key  (default 60s, or use the server's Retry-After)
  2. Scan the key pool         [activeKey, key1, key2, …] (deduplicated)
     ├─ Found a non-cooled key → switch to it → retry
     └─ All keys cooling       → wait for the soonest to recover → retry
  Never fails the step on a rate limit.
```

**Cross-provider fallback:** after consecutive rate limits exhaust all keys for one provider, subsequent requests are transparently routed to a fallback provider + model. A recovery timer retries the original provider after a configurable interval.

## Install

```bash
npm install llm-keyrot
```

## Quick start

### Standalone (any Node.js app)

```js
import { KeyRotator } from 'llm-keyrot'

// You manage where the active key lives
let currentKey = process.env.OPENAI_API_KEY

const rotator = new KeyRotator({
  providers: {
    openai: {
      activeKey: currentKey,
      pool: [
        process.env.OPENAI_KEY_2,
        process.env.OPENAI_KEY_3,
      ].filter(Boolean),
      cooldownMs: 30_000,      // 30s per key
    },
  },
  onActivate(key) {
    currentKey = key            // ← store it where your client picks it up
  },
})

// In your fetch wrapper:
async function llmCall(body) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${currentKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 429) {
    const action = await rotator.onRateLimit('openai', { status: 429 })
    if (action?.kind === 'retry') return llmCall(body)  // retry with new key
  }
  return res.json()
}
```

### With the OpenAI Node SDK

```js
import OpenAI from 'openai'
import { KeyRotator } from 'llm-keyrot'
import { wrapOpenAI } from 'llm-keyrot/adapters/openai-node.js'

const rotator = new KeyRotator({
  providers: {
    default: {
      activeKey: process.env.OPENAI_API_KEY,
      pool: [process.env.OPENAI_KEY_2].filter(Boolean),
      cooldownMs: 30_000,
    },
  },
  onActivate(key) { client.apiKey = key },
})

const client = wrapOpenAI(new OpenAI(), rotator, 'default')
// client.chat.completions.create now retries with key rotation on 429
```

### With fetch / axios

```js
import { KeyRotator } from 'llm-keyrot'
import { createRetryInterceptor } from 'llm-keyrot/adapters/http-interceptor.js'

const rotator = new KeyRotator({ ... })

const apiCall = createRetryInterceptor(rotator, 'openai', async (url, opts) => {
  const res = await fetch(url, opts)
  return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.json() }
})
```

### With DeepSeek Harness (DSH)

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- insert:
    - id: llm-keyrot
      name: 'llm-keyrot'
      config:
        providers:
          my-provider:
            activeRef: "MY_API_KEY"
            poolPrefix: "MY_POOL_"
            cooldownMs: 60000
        fallbacks:
          my-provider:
            provider: "fallback-provider"
            model: "gpt-4"
```

## API

### `new KeyRotator(options)`

| Option | Type | Description |
|---|---|---|
| `providers` | `object` | Provider configs, keyed by id. Each value: `{ activeKey, pool, cooldownMs? }` |
| `fallbacks` | `object` (optional) | Fallback routes, keyed by provider id. Each value: `{ provider, model }` |
| `onActivate` | `(key) => void \| Promise<void>` | Called when a new key should become active |
| `onDeactivate` | `(key) => void \| Promise<void>` | Optional; called when a key is rotated out |
| `logger` | `object` (optional) | Logger with `.info()`, `.warn()`. Defaults to `console` |

### `rotator.onRateLimit(provider, failure, signal?)`

Returns `{ kind: 'retry' }` if the call should be retried, or `undefined` if recovery failed.

### `rotator.getRoute(provider, model)`

Returns `{ provider, model }` — the resolved route after applying fallback logic.

### `rotator.isInFallback(provider)`

Returns `true` if the provider is currently in cross-provider fallback mode.

## Provider config

| Field | Required | Default | Description |
|---|---|---|---|
| `activeKey` | yes | — | The key currently in use; every request should use this |
| `pool` | no | `[]` | Additional keys to rotate through when the active key is rate‑limited |
| `cooldownMs` | no | `60000` | How long to cool down a key after a rate limit (ms) |

## Design decisions

| Decision | Rationale |
|---|---|
| **React to 429 / `RATE_LIMIT` / `QUOTA`** | Not round‑robin or pre‑emptive — only rotate when a limit is actually hit |
| **Per‑key cooldown** | Respects server `Retry-After` headers; falls back to a sane default |
| **Wait when all keys are cooling** | A rate limit is transient; the task shouldn't fail because of a burst |
| **Cross‑provider fallback** | If one API service is fully exhausted, route to a backup transparently |
| **Serialised rotation per provider** | Concurrent failures don't race and activate two keys at once |
| **Cancellable waits** | Clean disposal: an `AbortSignal` cuts through any pending cooldown |

## License

MIT
