/**
 * Deterministic no-key fallback route demo.
 * Triggers repeated 429 failures on providerA and shows getRoute() switching.
 */
import { KeyRotator } from '../lib/index.js'

const rotator = new KeyRotator({
  providers: {
    providerA: { activeKey: 'a1', pool: ['a2'], cooldownMs: 25 },
    providerB: { activeKey: 'b1', pool: ['b2'], cooldownMs: 25 },
  },
  fallbacks: {
    providerA: { provider: 'providerB', model: 'backup-model' },
  },
  onActivate() {},
})

console.log('[demo] initial route:', rotator.getRoute('providerA', 'primary-model'))

await rotator.onRateLimit('providerA', { status: 429 })
await rotator.onRateLimit('providerA', { status: 429 })
await rotator.onRateLimit('providerA', { status: 429 })

console.log('[demo] fallback enabled:', rotator.isInFallback('providerA'))
console.log('[demo] routed to:', rotator.getRoute('providerA', 'primary-model'))

rotator.dispose()
