/**
 * llm-keyrot — Auto-failover API key pool for LLM providers.
 *
 * When a request hits a per-minute rate or quota limit (`429`, `RATE_LIMIT`,
 * `QUOTA`), the key that just failed is cooled down and the next available key
 * from that provider's pool is activated. If every pool key is cooling, the
 * rotator waits for the soonest one to recover instead of failing the step.
 *
 * Optional cross-provider fallback: when a provider's keys are exhausted after
 * consecutive rate limits, subsequent requests can be transparently routed to
 * a fallback provider + model. A recovery timer clears the fallback after a
 * configurable interval.
 *
 * @example
 * ```js
 * import { KeyRotator } from 'llm-keyrot'
 *
 * const rotator = new KeyRotator({
 *   providers: {
 *     openai: { activeKey: process.env.OPENAI_API_KEY, pool: [...], cooldownMs: 30_000 },
 *   },
 *   onActivate(key) { process.env.OPENAI_API_KEY = key },
 *   onDeactivate(key) { },
 * })
 *
 * // In your fetch wrapper:
 * const res = await fetch(url, opts)
 * if (res.status === 429) {
 *   const action = await rotator.onRateLimit('openai', { status: 429 })
 *   if (action?.kind === 'retry') return await fetch(url, opts) // retry with new key
 * }
 * ```
 * @module llm-keyrot
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of pool keys scanned per provider. */
const MAX_POOL_SCAN = 32

/** Minimum cooldown when the server provides a hint (1 second). */
const MIN_COOLDOWN_MS = 1000

/** Maximum cooldown (3 minutes) — safety cap against unreasonably large values. */
const MAX_COOLDOWN_MS = 180_000

/** Default recovery‑interval for cross‑provider fallback mode (2 minutes). */
const FALLBACK_RECOVERY_MS = 120_000

/** Consecutive rate limits that trigger fallback mode. */
const MAX_CONSECUTIVE_FAILURES = 3

/** Default cooldown period for a rate‑limited key (60 seconds). */
const DEFAULT_COOLDOWN_MS = 60_000

const RATE_CODES = new Set([
  'RATE_LIMIT',
  'QUOTA',
  'rate_limit_exceeded',
  'insufficient_quota',
])

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Redact a key for logging (never log the full secret). */
function mask(key) {
  if (typeof key !== 'string' || key.length === 0) return '<none>'
  if (key.length <= 10) return key.slice(0, 2) + '…'
  return key.slice(0, 6) + '…' + key.slice(-4)
}

/**
 * Test whether a failure represents a per‑minute rate or quota limit.
 * @param {object|null|undefined} failure
 * @returns {boolean}
 */
export function isRateLimited(failure) {
  if (!failure) return false
  if (failure.status === 429) return true
  return RATE_CODES.has(failure.code)
}

/**
 * Returns a promise that resolves `true` after `delayMs` milliseconds.
 * If the `signal` is aborted before the delay elapses, the promise resolves
 * `false` immediately (the pending timer is cleared).
 * @param {number} delayMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>} `true` if the full delay elapsed, `false` if aborted.
 */
export function cancellableDelay(delayMs, signal) {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, delayMs)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Compose two abort signals. The returned signal aborts when either input does.
 * @param {AbortSignal} [a]
 * @param {AbortSignal} [b]
 * @returns {AbortSignal | undefined}
 */
function anyAbortSignal(a, b) {
  if (!a) return b
  if (!b) return a
  if (a.aborted || b.aborted) {
    const ctrl = new AbortController()
    ctrl.abort()
    return ctrl.signal
  }
  const ctrl = new AbortController()
  const onAbort = () => {
    a.removeEventListener('abort', onAbort)
    b.removeEventListener('abort', onAbort)
    ctrl.abort()
  }
  a.addEventListener('abort', onAbort, { once: true })
  b.addEventListener('abort', onAbort, { once: true })
  return ctrl.signal
}

// ─── KeyRotator ─────────────────────────────────────────────────────────────

/**
 * Create a key‑rotation pool for one or more LLM providers.
 *
 * @param {object} options
 * @param {object<string,ProviderConfig>} options.providers
 *   Provider configurations keyed by provider id.
 *
 * @param {object<string,FallbackRoute>} [options.fallbacks]
 *   Cross‑provider fallback routes. When a provider enters fallback mode (all
 *   keys exhausted after consecutive rate limits), its requests are
 *   transparently routed to the fallback provider + model.
 *
 * @param {(activeKey: string) => void | Promise<void>} options.onActivate
 *   Called with the new active key value. Implementations should store this
 *   key where their LLM client picks it up (env var, config object, etc.).
 *
 * @param {(previousKey: string) => void | Promise<void>} [options.onDeactivate]
 *   Optional callback when a key is being rotated out (e.g. to revoke a
 *   short‑lived token). Defaults to a no‑op.
 *
 * @param {object} [options.logger]
 *   Optional logger with `.info()` and `.warn()` methods. Defaults to `console`.
 *
 * @example
 * ```js
 * const rotator = new KeyRotator({
 *   providers: {
 *     openai: {
 *       activeKey: process.env.OPENAI_API_KEY,
 *       pool: [process.env.OPENAI_KEY_2, process.env.OPENAI_KEY_3],
 *       cooldownMs: 30_000,
 *     },
 *   },
 *   onActivate(key) { currentKey = key },
 * })
 * ```
 */
export class KeyRotator {
  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('KeyRotator requires an options object')
    }
    if (!options.providers || typeof options.providers !== 'object') {
      throw new TypeError('KeyRotator requires a providers map')
    }
    if (typeof options.onActivate !== 'function') {
      throw new TypeError('KeyRotator requires an onActivate callback')
    }
    this._providers = { ...options.providers }
    this._fallbacks = options.fallbacks ? { ...options.fallbacks } : {}
    this._onActivate = options.onActivate
    this._onDeactivate = options.onDeactivate ?? (() => {})
    this._log = options.logger ?? console

    /** key → epoch ms when this key may be used again. */
    this._cooldownUntil = new Map()
    /** provider → serialized rotation promise chain. */
    this._locks = new Map()
    /** provider → consecutive rate‑limit failure count. */
    this._consecutiveFailures = new Map()
    /** provider → currently in fallback mode. */
    this._fallbackMode = new Map()
    /** provider → recovery‑timer disposer. */
    this._fallbackTimers = new Map()
    this._lifetime = new AbortController()
  }

  /** Dispose the rotator: cancel fallback timers and pending cooldown waits. */
  dispose() {
    for (const clear of this._fallbackTimers.values()) clear()
    this._fallbackTimers.clear()
    this._lifetime.abort()
  }

  // ── Internal helpers ────────────────────────────────────────────────────

  _normalizeProvider(id) {
    const p = this._providers[id]
    if (!p) return undefined
    return {
      activeKey: p.activeKey,
      pool: Array.isArray(p.pool) ? p.pool : [],
      cooldownMs: p.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    }
  }

  _buildPool(spec) {
    // Deduplicated: activeKey first, then pool entries
    const seen = new Set()
    const pool = []
    if (typeof spec.activeKey === 'string' && spec.activeKey.length > 0) {
      seen.add(spec.activeKey)
      pool.push(spec.activeKey)
    }
    for (const key of spec.pool) {
      if (typeof key === 'string' && key.length > 0 && !seen.has(key)) {
        seen.add(key)
        pool.push(key)
      }
    }
    return pool
  }

  _isCooled(key, nowMs) {
    const ts = this._cooldownUntil.get(key)
    return ts !== undefined && ts > nowMs
  }

  _withLock(provider, fn) {
    const prev = this._locks.get(provider) ?? Promise.resolve()
    const run = prev.catch(() => {}).then(fn)
    this._locks.set(provider, run.catch(() => {}))
    return run
  }

  async _activate(provider, key) {
    try {
      const prev = typeof this._providers[provider]?.activeKey === 'string'
        ? this._providers[provider].activeKey
        : undefined
      await this._onActivate(key)
      if (prev != null && prev !== key) {
        await this._onDeactivate(prev)
      }
      // Update the in‑memory config so _buildPool picks up the new active key
      if (this._providers[provider]) {
        this._providers[provider].activeKey = key
      }
      return true
    } catch (error) {
      this._log.warn('[llm-keyrot] failed to activate key %s: %s', mask(key), error?.message ?? error)
      return false
    }
  }

  _clearFallbackTimer(provider) {
    const clear = this._fallbackTimers.get(provider)
    if (clear) { clear(); this._fallbackTimers.delete(provider) }
  }

  _enterFallback(provider) {
    if (this._fallbackMode.get(provider)) return
    const fb = this._fallbacks[provider]
    if (!fb) return
    this._fallbackMode.set(provider, true)
    this._consecutiveFailures.set(provider, 0)
    this._log.info('[llm-keyrot] provider "%s" entered fallback mode → %s/%s', provider, fb.provider, fb.model)
    const timer = setTimeout(() => {
      this._fallbackMode.delete(provider)
      this._log.info('[llm-keyrot] fallback mode cleared for "%s", will retry original provider', provider)
    }, FALLBACK_RECOVERY_MS)
    this._clearFallbackTimer(provider)
    this._fallbackTimers.set(provider, () => { clearTimeout(timer) })
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Check whether a provider is currently in fallback mode.
   * @param {string} provider
   * @returns {boolean}
   */
  isInFallback(provider) {
    return !!this._fallbackMode.get(provider)
  }

  /**
   * Get the effective route for a request, applying fallback if active.
   *
   * When the original `provider` is in fallback mode, returns the fallback
   * provider + model. Otherwise returns `{ provider, model }` unchanged.
   *
   * @param {string} provider  The original provider id.
   * @param {string} model     The original model name.
   * @returns {{ provider: string, model: string }} The resolved route.
   */
  getRoute(provider, model) {
    const fb = this._fallbacks[provider]
    if (fb && this._fallbackMode.get(provider)) {
      return { provider: fb.provider, model: fb.model }
    }
    return { provider, model }
  }

  /**
   * Handle a rate‑limit failure.
   *
   * Cools the failed key, switches to the next available pool key, or waits
   * for the soonest recovery when every key is cooling. If this provider's
   * keys are exhausted after consecutive failures, enters fallback mode (if
   * configured).
   *
   * **Concurrent‑safe**: rotations for the same provider are serialised so
   * parallel failures don't race.
   *
   * @param {string} provider
   * @param {object} failure
   * @param {number} [failure.status]
   * @param {string} [failure.code]
   * @param {number} [failure.providerRetryAfterMs]
   *   Optional cooldown hint returned by the server (e.g. `Retry-After` header).
   * @param {AbortSignal} [signal]
   *   Optional signal. When aborted, the wait is cancelled and the method
   *   returns `undefined` (no retry).
   * @returns {Promise<{ kind: 'retry' } | undefined>}
   *   `{ kind: 'retry' }` when a retry should be attempted (new key activated,
   *   or cooldown wait completed). `undefined` when the failure should be
   *   passed to the caller's own error handling.
   */
  async onRateLimit(provider, failure, signal) {
    if (!isRateLimited(failure)) return undefined
    const spec = this._normalizeProvider(provider)
    if (!spec) return undefined

    const failCount = (this._consecutiveFailures.get(provider) ?? 0) + 1
    this._consecutiveFailures.set(provider, failCount)

    // Already in fallback mode — do not attempt rotation
    if (this._fallbackMode.get(provider)) return undefined

    return this._withLock(provider, async () => {
      const pool = this._buildPool(spec)
      const currentActive = spec.activeKey

      if (pool.length === 0) {
        this._log.warn('[llm-keyrot] provider "%s" has no API keys in pool', provider)
        return undefined
      }

      // Cool the failed key
      if (currentActive) {
        let coolMs = spec.cooldownMs
        const hint = failure?.providerRetryAfterMs
        if (typeof hint === 'number' && Number.isFinite(hint) && hint > 0) {
          coolMs = Math.min(Math.max(hint, MIN_COOLDOWN_MS), MAX_COOLDOWN_MS)
        }
        this._cooldownUntil.set(currentActive, Date.now() + coolMs)
        this._log.info('[llm-keyrot] provider "%s" rate‑limited; cooled key %s for %dms', provider, mask(currentActive), coolMs)
      }

      // Try a non‑cooled key
      for (const key of pool) {
        if (!this._isCooled(key, Date.now())) {
          if (key !== currentActive) {
            if (!await this._activate(provider, key)) return undefined
            this._log.info('[llm-keyrot] provider "%s" rotated to key %s', provider, mask(key))
          }
          return { kind: 'retry' }
        }
      }

      // All keys are cooling — wait for the soonest one to recover
      let soonest = Infinity
      for (const key of pool) {
        const ts = this._cooldownUntil.get(key)
        if (ts !== undefined && ts < soonest) soonest = ts
      }
      const waitMs = Math.max(
        (Number.isFinite(soonest) ? soonest : Date.now()) - Date.now(),
        MIN_COOLDOWN_MS,
      )
      this._log.info('[llm-keyrot] provider "%s" has %d key(s) all cooling; waiting %dms', provider, pool.length, waitMs)
      const mergedSignal = anyAbortSignal(signal, this._lifetime.signal)
      if (!await cancellableDelay(waitMs, mergedSignal)) return undefined

      const recovered = pool.find((key) => !this._isCooled(key, Date.now()))
      if (recovered && recovered !== this._providers[provider]?.activeKey) {
        if (!await this._activate(provider, recovered)) return undefined
        this._log.info('[llm-keyrot] provider "%s" reactivated key %s after cooldown', provider, mask(recovered))
      }

      // Check if we should enter fallback mode
      const fails = this._consecutiveFailures.get(provider) ?? 0
      if (fails >= MAX_CONSECUTIVE_FAILURES && this._fallbacks[provider]) {
        this._enterFallback(provider)
      }

      return { kind: 'retry' }
    })
  }
}

/**
 * @typedef {object} ProviderConfig
 * @property {string} activeKey  The current active API key value.
 * @property {string[]} pool     Additional keys for rotation (may be empty).
 * @property {number} [cooldownMs]  Cooldown after a rate limit (ms). Default 60_000.
 */

/**
 * @typedef {object} FallbackRoute
 * @property {string} provider  Fallback provider id.
 * @property {string} model     Fallback model name.
 */
