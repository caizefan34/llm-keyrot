export interface DshProviderConfig {
  activeRef: string
  poolPrefix: string
  cooldownMs?: number
}

export interface DshFallbackRoute {
  provider: string
  model: string
}

export interface DshConfig {
  providers: Record<string, DshProviderConfig>
  fallbacks?: Record<string, DshFallbackRoute>
}

export declare const name: 'llm-keyrot'
export declare const inject: readonly ['credentials']
export declare const Config: null

export declare function apply(ctx: any, config: DshConfig): void
