import type { KeyRotator } from '../lib/index.js'

export interface WrapOpenAIOptions {
  maxRetries?: number
}

export interface OpenAICompatibleClient {
  chat: {
    completions: {
      create: (...args: any[]) => Promise<any>
    }
  }
}

export declare function wrapOpenAI<T extends OpenAICompatibleClient>(
  client: T,
  rotator: KeyRotator,
  providerId: string,
  options?: WrapOpenAIOptions,
): T
