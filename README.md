<div align="center">

# llm-keyrot

**Zero-dependency API key rotation for LLM providers.**

Never let a `429 Too Many Requests` kill your long-running task again.

[![CI](https://github.com/caizefan34/llm-keyrot/actions/workflows/ci.yml/badge.svg)](https://github.com/caizefan34/llm-keyrot/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-keyrot)](https://www.npmjs.com/package/llm-keyrot)
[![npm downloads](https://img.shields.io/npm/dm/llm-keyrot)](https://www.npmjs.com/package/llm-keyrot)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![no dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

**Works with OpenAI, Anthropic, Gemini, DeepSeek, Groq, OpenRouter, and any HTTP LLM API.**

</div>

***

## The problem

You're running a long LLM task — a batch of translations, an eval harness, a multi-step agent. Then:

```
429 Too Many Requests
```

The SDK's built-in retry uses **the same key**, hits **the same limit**, and fails. Your 3-hour job dies at hour 2.

## The fix

Pool your keys. When one hits a rate limit, rotate to the next. When *all* of them are cooling, **wait** for the soonest to recover instead of failing. Optionally fall back to a different provider entirely.

```js
import { KeyRotator } from 'llm-keyrot'

let currentKey = process.env.OPENAI_API_KEY

const rotator = new KeyRotator({
  providers: {
    openai: {
      activeKey: currentKey,
      pool: [process.env.OPENAI_KEY_2, process.env.OPENAI_KEY_3].filter(Boolean),
      cooldownMs: 30_000,
    },
  },
  onActivate(key) { currentKey = key },
})

// In your fetch wrapper — that's the whole integration:
if (res.status === 429) {
  const action = await rotator.onRateLimit('openai', { status: 429 })
  if (action?.kind === 'retry') return llmCall(body)   // retried with a fresh key
}
```

## How it works

```
request → 429 / RATE_LIMIT / QUOTA
  ↓
[llm-keyrot]
  1. Cool down the failed key   (default 60s, or the server's Retry-After)
  2. Scan the key pool          [activeKey, key1, key2, …] (deduplicated)
     ├─ Found a non-cooled key → switch to it → retry
     └─ All keys cooling        → wait for the soonest to recover → retry
  Never fails the step on a rate limit.
```

**Cross-provider fallback:** after consecutive rate limits exhaust all keys for one provider, subsequent requests are transparently routed to a fallback provider + model. A recovery timer retries the original provider later.

## Why this one

| <br />                                      | llm-keyrot | SDK built-in retry | LiteLLM / Portkey |
| ------------------------------------------- | ---------- | ------------------ | ----------------- |
| Rotates to a *different key* on 429         | ✅          | ❌ same key         | ✅                 |
| Zero dependencies                           | ✅          | —                  | ❌                 |
| Runs in-process, no proxy / gateway         | ✅          | —                  | ❌                 |
| Drops into existing code (3 lines)          | ✅          | ✅                  | ❌ rewrite         |
| Works with any provider / any HTTP client   | ✅          | —                  | partial           |
| Waits instead of failing when all keys cool | ✅          | ❌                  | ✅                 |
| Cross-provider fallback                     | ✅          | ❌                  | ✅                 |
| Keys stay in your process                   | ✅          | ✅                  | ❌ sent to gateway |

Key properties:

- **Zero dependencies** — pure ESM JavaScript, \~3 KB. Audit-friendly, install-friendly.

- **Not a proxy** — no extra hop, no gateway to deploy, no key escrow. Your keys never leave your process.

- **Provider-agnostic** — anything that can return a status code works: OpenAI, Anthropic, Gemini, DeepSeek, Groq, OpenRouter, internal gateways…

- **Concurrency-safe** — parallel failures on the same provider are serialized; you never activate two keys at once.

- **Respects** **`Retry-After`** — per-key cooldown uses the server's hint when present (clamped to 1s–3min).

- **Cancellable** — every wait accepts an `AbortSignal`.

## Install

```bash
npm install llm-keyrot
```

Node.js ≥ 18 (uses global `fetch`, `AbortSignal`, timers).

## Quick start

### Standalone (any provider, any HTTP client)

```js
import { KeyRotator } from 'llm-keyrot'

let currentKey = process.env.OPENAI_API_KEY

const rotator = new KeyRotator({
  providers: {
    openai: {
      activeKey: currentKey,
      pool: [process.env.OPENAI_KEY_2, process.env.OPENAI_KEY_3].filter(Boolean),
      cooldownMs: 30_000,      // 30s per key
    },
  },
  onActivate(key) { currentKey = key },
})

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

| Option         | Type                             | Description                                                                   |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------- |
| `providers`    | `object`                         | Provider configs, keyed by id. Each value: `{ activeKey, pool, cooldownMs? }` |
| `fallbacks`    | `object` (optional)              | Fallback routes, keyed by provider id. Each value: `{ provider, model }`      |
| `onActivate`   | `(key) => void \| Promise<void>` | Called when a new key should become active                                    |
| `onDeactivate` | `(key) => void \| Promise<void>` | Optional; called when a key is rotated out                                    |
| `logger`       | `object` (optional)              | Logger with `.info()`, `.warn()`. Defaults to `console`                       |

### `rotator.onRateLimit(provider, failure, signal?)`

Returns `{ kind: 'retry' }` if the call should be retried, or `undefined` if recovery failed.

`failure` accepts `{ status }` (HTTP status), `{ code }` (`RATE_LIMIT` / `QUOTA`), and an optional `providerRetryAfterMs` hint (e.g. from a `Retry-After` header).

### `rotator.getRoute(provider, model)`

Returns `{ provider, model }` — the resolved route after applying fallback logic.

### `rotator.isInFallback(provider)`

Returns `true` if the provider is currently in cross-provider fallback mode.

### `rotator.dispose()`

Cancels all pending cooldown waits and fallback timers.

## Provider config

| Field        | Required | Default | Description                                                           |
| ------------ | -------- | ------- | --------------------------------------------------------------------- |
| `activeKey`  | yes      | —       | The key currently in use; every request should use this               |
| `pool`       | no       | `[]`    | Additional keys to rotate through when the active key is rate-limited |
| `cooldownMs` | no       | `60000` | How long to cool down a key after a rate limit (ms)                   |

## Design decisions

| Decision                                              | Rationale                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| **React to 429 /** **`RATE_LIMIT`** **/** **`QUOTA`** | Not round-robin or pre-emptive — only rotate when a limit is actually hit |
| **Per-key cooldown**                                  | Respects server `Retry-After` headers; falls back to a sane default       |
| **Wait when all keys are cooling**                    | A rate limit is transient; the task shouldn't fail because of a burst     |
| **Cross-provider fallback**                           | If one API service is fully exhausted, route to a backup transparently    |
| **Serialized rotation per provider**                  | Concurrent failures don't race and activate two keys at once              |
| **Cancellable waits**                                 | Clean disposal: an `AbortSignal` cuts through any pending cooldown        |
| **Zero dependencies**                                 | You're adding resilience, not a dependency tree                           |

## FAQ

**Why not just the SDK's retry?** SDK retries back off and retry with the *same* key — against a per-key limit that's a countdown to failure. Rotation switches to a key that still has quota.

**Does it make requests for me?** No — you keep your own client (fetch, axios, SDK). llm-keyrot only decides *which key* should be active and *when* to retry. No wrapping proxy, no behavior change on the happy path.

**Where do keys live?** In your process, wherever you put them. llm-keyrot never logs full keys (they're masked) and never sends them anywhere.

**Multiple providers?** Yes — pass several entries in `providers` and handle each one's failures with `onRateLimit('<id>', …)`.

## Contributing

Issues and PRs are welcome. Run tests with `npm test` (zero-dependency `node:test`).

## License

MIT

***

<div align="center">

**If this saved your batch job, ⭐ star the repo — it helps others find it.**

</div>
