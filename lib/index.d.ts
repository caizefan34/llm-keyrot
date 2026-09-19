export interface ProviderConfig {
  activeKey: string
  pool?: string[]
  cooldownMs?: number
}

export interface FallbackRoute {
  provider: string
  model: string
}

export interface RateLimitFailure {
  status?: number
  code?: string
  providerRetryAfterMs?: number
}

export interface RetryAction {
  kind: 'retry'
}

export interface KeyRotatorLogger {
  info?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
}

export interface KeyRotatorOptions {
  providers: Record<string, ProviderConfig>
  fallbacks?: Record<string, FallbackRoute>
  onActivate: (activeKey: string) => void | Promise<void>
  onDeactivate?: (previousKey: string) => void | Promise<void>
  logger?: KeyRotatorLogger
}

export declare class KeyRotator {
  constructor(options: KeyRotatorOptions)
  onRateLimit(provider: string, failure: RateLimitFailure, signal?: AbortSignal): Promise<RetryAction | undefined>
  getRoute(provider: string, model: string): { provider: string; model: string }
  isInFallback(provider: string): boolean
  dispose(): void
}

export declare function isRateLimited(failure: Pick<RateLimitFailure, 'status' | 'code'> | null | undefined): boolean

export declare function cancellableDelay(delayMs: number, signal?: AbortSignal): Promise<boolean>
