/**
 * Generic fetch/axios interceptor adapter for llm-keyrot.
 *
 * Wraps any HTTP client that returns `{ status, headers }` with automatic key
 * rotation on 429 responses. The caller provides the `sendRequest` function.
 *
 * @example
 * ```js
 * import { KeyRotator } from 'llm-keyrot'
 * import { createRetryInterceptor } from 'llm-keyrot/adapters/http-interceptor'
 *
 * const rotator = new KeyRotator({ ... })
 *
 * const sendWithRetry = createRetryInterceptor(rotator, 'my-provider',
 *   async (url, opts) => {
 *     const res = await fetch(url, opts)
 *     return { status: res.status, headers: res.headers, body: await res.json() }
 *   }
 * )
 * ```
 * @module llm-keyrot/adapters/http-interceptor
 */

/**
 * Create a request function that automatically retries on 429 with key
 * rotation.
 *
 * @param {import('../lib/index.js').KeyRotator} rotator
 * @param {string} providerId
 * @param {(url: string, options?: object) => Promise<{ status: number, headers?: object, body: any }>} sendRequest
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.status]  The HTTP status to treat as rate‑limited (default 429).
 * @returns {(url: string, options?: object) => Promise<any>}
 */
export function createRetryInterceptor(rotator, providerId, sendRequest, options = {}) {
  const maxRetries = options.maxRetries ?? 3
  const rateLimitStatus = options.status ?? 429

  return async function retryRequest(url, opts) {
    let lastError = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await sendRequest(url, opts)
        if (response.status !== rateLimitStatus) return response.body

        const action = await rotator.onRateLimit(providerId, {
          status: response.status,
          code: response.status === 429 ? 'RATE_LIMIT' : undefined,
          providerRetryAfterMs: response.headers?.['retry-after-ms']
            ? Number(response.headers['retry-after-ms'])
            : undefined,
        })

        if (!action) return response.body  // No recovery — return the error body
        // Continue to retry with the new key
      } catch (err) {
        lastError = err
        const action = await rotator.onRateLimit(providerId, {
          status: err?.status ?? err?.response?.status,
          code: err?.code,
        })
        if (!action) throw err
      }
    }
    throw lastError ?? new Error(`Request failed after ${maxRetries} retries`)
  }
}
