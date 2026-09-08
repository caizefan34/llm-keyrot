/**
 * OpenAI Node SDK adapter for llm-keyrot.
 *
 * Wraps `openai.ChatCompletion.create` (and similar methods) with automatic
 * key rotation: on a 429 / rate‑limit, the adapter rotates to the next pool
 * key and retries transparently.
 *
 * @example
 * ```js
 * import OpenAI from 'openai'
 * import { wrapOpenAI } from 'llm-keyrot/adapters/openai-node'
 * import { KeyRotator } from 'llm-keyrot'
 *
 * const rotator = new KeyRotator({
 *   providers: {
 *     openai: {
 *       activeKey: process.env.OPENAI_API_KEY,
 *       pool: [process.env.OPENAI_KEY_2].filter(Boolean),
 *       cooldownMs: 30_000,
 *     },
 *   },
 *   onActivate(key) { client.apiKey = key },
 * })
 *
 * const client = wrapOpenAI(new OpenAI(), rotator, 'openai')
 * ```
 * @module llm-keyrot/adapters/openai-node
 */

/**
 * Wrap an OpenAI client instance so chat completion calls automatically retry
 * with a rotated key on rate‑limit errors.
 *
 * @param {import('openai').OpenAI} client
 * @param {import('../lib/index.js').KeyRotator} rotator
 * @param {string} providerId  Provider id used in the rotator's provider map.
 * @param {object} [options]
 * @param {number} [options.maxRetries=3]  Max retry attempts per call.
 * @returns {import('openai').OpenAI}  The same client, with wrapped methods.
 */
export function wrapOpenAI(client, rotator, providerId, options = {}) {
  const maxRetries = options.maxRetries ?? 3
  const originalCreate = client.chat.completions?.create?.bind

  if (typeof originalCreate !== 'function') {
    throw new Error('wrapOpenAI: client.chat.completions.create not found — is the OpenAI SDK imported?')
  }

  const _origCreate = client.chat.completions.create.bind(client.chat.completions)

  client.chat.completions.create = async function wrappedCreate(...args) {
    let lastError = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await _origCreate(...args)
      } catch (err) {
        lastError = err

        // Check if this is a rate‑limit error
        const status = err?.status ?? err?.response?.status
        const code = err?.code ?? err?.error?.code
        if (status !== 429 && code !== 'rate_limit_exceeded' && code !== 'insufficient_quota') {
          throw err  // Non‑retryable — rethrow
        }

        const action = await rotator.onRateLimit(providerId, {
          status,
          code,
          providerRetryAfterMs: err?.response?.headers?.['retry-after-ms']
            ? Number(err.response.headers['retry-after-ms'])
            : undefined,
        })

        if (!action) throw err  // No recovery path
        // Continue to retry with the new key
      }
    }
    throw lastError
  }

  return client
}
