/**
 * Tests for llm-keyrot — run with `npm test` (zero-dependency node:test).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { KeyRotator, isRateLimited, cancellableDelay } from '../lib/index.js'

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
