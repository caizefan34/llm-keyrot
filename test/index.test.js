/**
 * Tests for llm-keyrot — run with `npm test` (zero-dependency node:test).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { KeyRotator, isRateLimited, cancellableDelay } from '../lib/index.js'
import { createRetryInterceptor, parseRetryAfterMs } from '../adapters/http-interceptor.js'
import { wrapOpenAI } from '../adapters/openai-node.js'

/** Silent logger to keep test output clean. */
const quiet = { info() {}, warn() {} }

// ─── isRateLimited ──────────────────────────────────────────────────────────

test('isRateLimited detects 429 status', () => {
  assert.equal(isRateLimited({ status: 429 }), true)
})

test('isRateLimited detects RATE_LIMIT / QUOTA codes', () => {
  assert.equal(isRateLimited({ code: 'RATE_LIMIT' }), true)
  assert.equal(isRateLimited({ code: 'QUOTA' }), true)
})

test('isRateLimited ignores other failures', () => {
  assert.equal(isRateLimited({ status: 500 }), false)
  assert.equal(isRateLimited({ code: 'SERVER_ERROR' }), false)
  assert.equal(isRateLimited(null), false)
  assert.equal(isRateLimited(undefined), false)
})

test('isRateLimited detects lowercase provider codes', () => {
  assert.equal(isRateLimited({ code: 'rate_limit_exceeded' }), true)
  assert.equal(isRateLimited({ code: 'insufficient_quota' }), true)
})

// ─── cancellableDelay ───────────────────────────────────────────────────────

test('cancellableDelay resolves true after the delay', async () => {
  const start = Date.now()
  const ok = await cancellableDelay(20)
  assert.equal(ok, true)
  assert.ok(Date.now() - start >= 15)
})

test('cancellableDelay resolves false when already aborted', async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  assert.equal(await cancellableDelay(10, ctrl.signal), false)
})

// ─── KeyRotator: rotation ───────────────────────────────────────────────────

test('onRateLimit rotates to the next pool key', async () => {
  let active = 'key-a'
  const activated = []
  const rotator = new KeyRotator({
    providers: {
      p: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 60_000 },
    },
    onActivate(key) { activated.push(key); active = key },
    logger: quiet,
  })

  const action = await rotator.onRateLimit('p', { status: 429 })
  assert.equal(action?.kind, 'retry')
  assert.equal(active, 'key-b')
  assert.deepEqual(activated, ['key-b'])
})

test('onRateLimit returns undefined for unknown provider', async () => {
  const rotator = new KeyRotator({ providers: {}, onActivate() {} })
  assert.equal(await rotator.onRateLimit('nope', { status: 429 }), undefined)
})

test('onRateLimit ignores non-rate-limit failures', async () => {
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'] } },
    onActivate() {},
  })
  assert.equal(await rotator.onRateLimit('p', { status: 500 }), undefined)
})

test('onRateLimit returns undefined when pool is empty', async () => {
  const rotator = new KeyRotator({
    providers: { p: { activeKey: '', pool: [] } },
    onActivate() {},
    logger: quiet,
  })
  assert.equal(await rotator.onRateLimit('p', { status: 429 }), undefined)
})

test('onRateLimit returns undefined when onActivate throws', async () => {
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'] } },
    onActivate() { throw new Error('boom') },
    logger: quiet,
  })
  assert.equal(await rotator.onRateLimit('p', { status: 429 }), undefined)
})

test('rotated-out key is passed to onDeactivate', async () => {
  const deactivated = []
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'] } },
    onActivate() {},
    onDeactivate(key) { deactivated.push(key) },
    logger: quiet,
  })
  await rotator.onRateLimit('p', { status: 429 })
  assert.deepEqual(deactivated, ['key-a'])
})

test('duplicate pool entries are deduplicated', () => {
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'] } },
    onActivate() {},
  })
  // activeKey + duplicates collapse to a unique ordered pool: [active, …pool]
  const pool = rotator._buildPool({ activeKey: 'key-a', pool: ['key-a', 'key-b', 'key-b', ''] })
  assert.deepEqual(pool, ['key-a', 'key-b'])
})

test('constructor validates required options', () => {
  assert.throws(() => new KeyRotator(), /options object/)
  assert.throws(() => new KeyRotator({}), /providers map/)
  assert.throws(() => new KeyRotator({ providers: {} }), /onActivate callback/)
})

// ─── KeyRotator: cooldown & waiting ─────────────────────────────────────────

test('waits for recovery when all keys are cooling', async () => {
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 50 } },
    onActivate() {},
    logger: quiet,
  })
  // 1st: cool key-a, rotate to key-b
  await rotator.onRateLimit('p', { status: 429 })
  // 2nd: cool key-b — all cooling → waits (min 1s) → key-a recovered → retry
  const action = await rotator.onRateLimit('p', { status: 429 })
  assert.equal(action?.kind, 'retry')
  rotator.dispose()
})

test('aborted signal cancels the recovery wait', async () => {
  const ctrl = new AbortController()
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 60_000 } },
    onActivate() {},
    logger: quiet,
  })
  await rotator.onRateLimit('p', { status: 429 })   // rotate to key-b
  ctrl.abort()
  assert.equal(await rotator.onRateLimit('p', { status: 429 }, ctrl.signal), undefined)
})

test('dispose cancels pending recovery wait', async () => {
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 60_000 } },
    onActivate() {},
    logger: quiet,
  })
  await rotator.onRateLimit('p', { status: 429 }) // rotate to key-b
  const start = Date.now()
  const waiting = rotator.onRateLimit('p', { status: 429 })
  setTimeout(() => rotator.dispose(), 20)
  assert.equal(await waiting, undefined)
  assert.ok(Date.now() - start < 500, 'dispose should abort without waiting minimum cooldown')
})

test('providerRetryAfterMs hint is respected and clamped', async () => {
  const ctrl = new AbortController()
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 60_000 } },
    onActivate() {},
    logger: quiet,
  })
  // hint 1500ms → key-a cools for 1500ms (within [1s, 3min] clamp)
  await rotator.onRateLimit('p', { status: 429, providerRetryAfterMs: 1500 })
  const until = rotator._cooldownUntil.get('key-a')
  const remaining = until - Date.now()
  assert.ok(remaining > 1400 && remaining <= 1500, `expected ~1500ms remaining, got ${remaining}`)

  // hint 10_000_000ms → clamped down to 3 minutes (cooldown is set before the
  // wait, so an aborted signal skips the 3-minute recovery wait)
  ctrl.abort()
  assert.equal(
    await rotator.onRateLimit('p', { status: 429, providerRetryAfterMs: 10_000_000 }, ctrl.signal),
    undefined,
  )
  const clamped = rotator._cooldownUntil.get('key-b') - Date.now()
  assert.ok(clamped > 179_000 && clamped <= 180_000, `expected clamp to ~3min, got ${clamped}ms`)
})

// ─── KeyRotator: fallback ────────────────────────────────────────────────────

test('enters cross-provider fallback after consecutive failures', async () => {
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 50 } },
    fallbacks: { p: { provider: 'backup', model: 'gpt-4' } },
    onActivate() {},
    logger: quiet,
  })

  assert.equal(rotator.isInFallback('p'), false)
  assert.deepEqual(rotator.getRoute('p', 'm1'), { provider: 'p', model: 'm1' })

  await rotator.onRateLimit('p', { status: 429 })   // rotate a → b
  await rotator.onRateLimit('p', { status: 429 })   // rotate b → a? no: all cooling → wait → retry
  await rotator.onRateLimit('p', { status: 429 })   // 3rd consecutive failure → fallback

  assert.equal(rotator.isInFallback('p'), true)
  assert.deepEqual(rotator.getRoute('p', 'm1'), { provider: 'backup', model: 'gpt-4' })

  // While in fallback mode, onRateLimit does not rotate
  assert.equal(await rotator.onRateLimit('p', { status: 429 }), undefined)

  rotator.dispose()
})

// ─── KeyRotator: concurrency ─────────────────────────────────────────────────

test('concurrent failures are serialized without unhandled rejections', async () => {
  const activated = []
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b', 'key-c'], cooldownMs: 50 } },
    onActivate(key) { activated.push(key) },
    logger: { info() {}, warn() {} },
  })

  const results = await Promise.all([
    rotator.onRateLimit('p', { status: 429 }),
    rotator.onRateLimit('p', { status: 429 }),
    rotator.onRateLimit('p', { status: 429 }),
  ])
  // Each resolves without throwing; at least one rotation happened.
  assert.ok(activated.length >= 1)
  assert.ok(results.every((r) => r === undefined || r.kind === 'retry'))
})

// ─── adapters: retry-after parsing & retry behavior ──────────────────────────

test('parseRetryAfterMs supports retry-after-ms, seconds, and HTTP date', () => {
  assert.equal(parseRetryAfterMs({ 'retry-after-ms': '1500' }), 1500)
  assert.equal(parseRetryAfterMs({ 'Retry-After': '2' }), 2000)
  const future = new Date(Date.now() + 2500).toUTCString()
  const parsed = parseRetryAfterMs({ 'retry-after': future })
  assert.ok(parsed >= 1000 && parsed <= 3000, `expected a positive delay from HTTP-date, got ${parsed}`)
})

test('http interceptor enforces maxRetries and keeps non-429 errors', async () => {
  let calls = 0
  const rotator = new KeyRotator({
    providers: { p: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 0 } },
    onActivate() {},
    logger: quiet,
  })

  const request429 = createRetryInterceptor(rotator, 'p', async () => {
    calls += 1
    return { status: 429, headers: {}, body: { error: 'rate' } }
  }, { maxRetries: 2 })
  await assert.rejects(request429('https://example.invalid'), /after 2 retries/)
  assert.equal(calls, 3)

  const fatal = createRetryInterceptor(rotator, 'p', async () => {
    const err = new Error('server exploded')
    err.status = 500
    throw err
  })
  await assert.rejects(fatal('https://example.invalid'), /server exploded/)
})

test('openai adapter retries rate limits and rethrows non-rate-limit errors', async () => {
  let attempts = 0
  const client = {
    chat: {
      completions: {
        async create() {
          attempts += 1
          if (attempts < 3) {
            const err = new Error('rate')
            err.status = 429
            err.code = 'rate_limit_exceeded'
            throw err
          }
          return { ok: true }
        },
      },
    },
  }

  const rotator = new KeyRotator({
    providers: { openai: { activeKey: 'key-a', pool: ['key-b'], cooldownMs: 0 } },
    onActivate() {},
    logger: quiet,
  })
  wrapOpenAI(client, rotator, 'openai', { maxRetries: 3 })
  assert.deepEqual(await client.chat.completions.create({}), { ok: true })
  assert.equal(attempts, 3)

  const fatalClient = {
    chat: {
      completions: {
        async create() {
          const err = new Error('fatal')
          err.status = 500
          throw err
        },
      },
    },
  }
  wrapOpenAI(fatalClient, rotator, 'openai', { maxRetries: 1 })
  await assert.rejects(fatalClient.chat.completions.create({}), /fatal/)
})

test('package exports include TypeScript declarations for root and adapters', () => {
  const pkgPath = new URL('../package.json', import.meta.url)
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  assert.equal(pkg.types, './lib/index.d.ts')
  assert.equal(pkg.exports['.'].types, './lib/index.d.ts')
  assert.equal(pkg.exports['./adapters/*.js'].types, './adapters/*.d.ts')

  assert.equal(existsSync(new URL('../lib/index.d.ts', import.meta.url)), true)
  assert.equal(existsSync(new URL('../adapters/http-interceptor.d.ts', import.meta.url)), true)
  assert.equal(existsSync(new URL('../adapters/openai-node.d.ts', import.meta.url)), true)
  assert.equal(existsSync(new URL('../adapters/dsh.d.ts', import.meta.url)), true)
})

test('deterministic anthropic and gemini integration demos run without credentials', () => {
  const anthropic = spawnSync(process.execPath, [fileURLToPath(new URL('../examples/anthropic-integration-demo.js', import.meta.url))], {
    encoding: 'utf8',
  })
  assert.equal(anthropic.status, 0, anthropic.stderr)
  assert.match(anthropic.stdout, /\[anthropic-demo\] final result:/)

  const gemini = spawnSync(process.execPath, [fileURLToPath(new URL('../examples/gemini-integration-demo.js', import.meta.url))], {
    encoding: 'utf8',
  })
  assert.equal(gemini.status, 0, gemini.stderr)
  assert.match(gemini.stdout, /\[gemini-demo\] final result:/)
})
