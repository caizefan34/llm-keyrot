/**
 * DSH (DeepSeek Harness) adapter for llm-keyrot.
 *
 * Registers two Cordis waterfall listeners:
 *  1. `agent/request` (non‑prepended) — swaps provider + model when the
 *     original provider is in fallback mode.
 *  2. `agent/request-error` (prepended) — on a rate‑limited response, cools
 *     the current key, rotates to the next pool key, and retries. Enters
 *     cross‑provider fallback after consecutive failures.
 *
 * The adapter resolves pool keys from the DSH credential service so they are
 * re‑evaluated on every request (no stale env vars).
 *
 * @example
 * ```yaml
 * # In a cordis.patch.yml composition row:
 * - insert:
 *     - id: llm-keyrot
 *       name: 'llm-keyrot'
 *       config: {
 *         providers: {
 *           my-provider: {
 *             activeRef: "MY_API_KEY",
 *             poolPrefix: "MY_KEY_POOL_",
 *             cooldownMs: 60000
 *           }
 *         },
 *         fallbacks: {
 *           my-provider: { provider: "fallback-provider", model: "gpt-4" }
 *         }
 *       }
 * ```
 * @module llm-keyrot/adapter/dsh
 */

import { KeyRotator, isRateLimited } from '../lib/index.js'

/** DSH plugin identity. */
export const name = 'llm-keyrot'

/** Hard dependency on the credentials service. */
export const inject = ['credentials']

/** Empty schema — configuration is merged from the patch row's `config` block. */
export const Config = null

// ─── Defaults ───────────────────────────────────────────────────────────────

const MAX_POOL_SCAN = 32
const CONSECUTIVE_THRESHOLD = 3

/**
 * Install the key‑rotation and fallback listeners.
 *
 * Expects plugin config to be passed through the composition row:
 * ```yaml
 *   config:
 *     providers:
 *       openai:
 *         activeRef: "OPENAI_API_KEY"
 *         poolPrefix: "OPENAI_POOL_"
 *         cooldownMs: 30000
 *     fallbacks:
 *       openai:
 *         provider: "azure"
 *         model: "gpt-4"
 * ```
 */
export function apply(ctx, config) {
  if (!config?.providers || Object.keys(config.providers).length === 0) {
    ctx.logger.warn('[llm-keyrot] no providers configured — plugin inactive')
    return
  }

  const { providers: providerConfigs, fallbacks } = config
  const credentials = ctx.credentials

  // ── Resolve helpers ───────────────────────────────────────────────────────

  async function resolveRef(ref) {
    try {
      const hit = await credentials.resolve(ref)
      return hit?.value
    } catch {
      return undefined
    }
  }

  async function loadPool(spec) {
    const resolved = await Promise.all([
      resolveRef(spec.activeRef),
      ...Array.from({ length: MAX_POOL_SCAN }, (_, i) => resolveRef(spec.poolPrefix + (i + 1))),
    ])
    const pool = []
    const seen = new Set()
    for (const key of resolved) {
      if (typeof key === 'string' && key.length > 0 && !seen.has(key)) {
        seen.add(key)
        pool.push(key)
      }
    }
    return pool
  }

  // ── Build resolved provider config for KeyRotator ────────────────────────

  const resolvedActiveKeys = new Map()   // provider → string
  const resolvedPools = new Map()        // provider → string[]
  let ready = false

  async function refreshKeys() {
    const entries = await Promise.all(
      Object.entries(providerConfigs).map(async ([id, spec]) => {
        const activeKey = await resolveRef(spec.activeRef)
        const pool = await loadPool(spec)
        return [id, { activeKey, pool, cooldownMs: spec.cooldownMs }]
      }),
    )
    for (const [id, { activeKey, pool, cooldownMs }] of entries) {
      if (activeKey) resolvedActiveKeys.set(id, activeKey)
      resolvedPools.set(id, pool)
    }
    ready = true
  }

  // Don't block apply() — keys are resolved lazily on first rate-limit.
  refreshKeys().catch(() => {})

  function makeProvidersMap() {
    const m = {}
    for (const [id, spec] of Object.entries(providerConfigs)) {
      m[id] = {
        activeKey: resolvedActiveKeys.get(id) ?? '',
        pool: resolvedPools.get(id) ?? [],
        cooldownMs: spec.cooldownMs ?? 60_000,
      }
    }
    return m
  }

  // ── Create rotator ──────────────────────────────────────────────────────

  const rotator = new KeyRotator({
    get providers() { return makeProvidersMap() },
    fallbacks,
    async onActivate(key) {
      // Find the provider whose activeRef maps to this key
      for (const [id, spec] of Object.entries(providerConfigs)) {
        const cur = resolvedActiveKeys.get(id)
        if (cur === key || !cur) {
          // Activate by setting the credential ref to this key
          await credentials.set(spec.activeRef, key)
          resolvedActiveKeys.set(id, key)
          ctx.logger.info('[llm-keyrot] activated key for provider "%s"', id)
          return
        }
      }
    },
    logger: ctx.logger,
  })

  // ── agent/request (fallback route swap) ─────────────────────────────────

  const disposeReq = ctx.on('agent/request', async (payload, next) => {
    const cfg = await next()
    if (!cfg?.provider) return cfg

    // Refresh keys if not yet ready
    if (!ready) await refreshKeys()

    const route = rotator.getRoute(cfg.provider, cfg.model)
    if (route.provider !== cfg.provider || route.model !== cfg.model) {
      ctx.logger.info('[llm-keyrot] fallback %s/%s → %s/%s', cfg.provider, cfg.model, route.provider, route.model)
      cfg.provider = route.provider
      cfg.model = route.model
    }
    return cfg
  })

  // ── agent/request-error (prepended — own rate-limit recovery) ───────────

  const consecutiveFailures = new Map()

  const disposeErr = ctx.on('agent/request-error', (payload, next) => {
    if (!isRateLimited(payload.failure)) return next()
    if (!providerConfigs[payload.provider]) return next()

    const count = (consecutiveFailures.get(payload.provider) ?? 0) + 1
    consecutiveFailures.set(payload.provider, count)

    if (rotator.isInFallback(payload.provider)) return next()

    return rotator.onRateLimit(payload.provider, payload.failure, payload.signal)
      .then(action => action ?? next())
  }, true)

  // ── Disposal ───────────────────────────────────────────────────────────

  ctx.effect(() => () => {
    disposeReq()
    disposeErr()
    rotator.dispose()
  }, '[llm-keyrot] dispose')
}
