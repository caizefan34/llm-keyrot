import type { KeyRotator } from '../lib/index.js'

export interface RetryResponse {
  status: number
  headers?: Headers | Record<string, unknown>
  body: any
}

export interface RetryInterceptorOptions {
  maxRetries?: number
  status?: number
}

export declare function parseRetryAfterMs(headers?: Headers | Record<string, unknown>): number | undefined

export declare function createRetryInterceptor(
  rotator: KeyRotator,
  providerId: string,
  sendRequest: (url: string, options?: object) => Promise<RetryResponse>,
  options?: RetryInterceptorOptions,
): (url: string, options?: object) => Promise<any>
