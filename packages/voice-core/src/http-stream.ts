/**
 * Shared internal HTTP stream, abort-race, timer, secret resolution, and PCM buffer helpers
 * reused across `asr-engines.ts`, `tts-engines.ts`, and `daemon-client.ts`.
 */

import { redactSecrets } from './redact.ts'

export type SecretValueProvider = string | (() => Promise<string | null> | string | null)

const UTF8_DECODER = new TextDecoder('utf-8')

/** Host-neutral timer and default WinterCG `fetch` helpers (lazy-resolved for bare JSC safety). */
export function scheduleTimeout(callback: () => void, ms?: number): ReturnType<typeof setTimeout> {
  const fn = typeof setTimeout === 'function' ? setTimeout : undefined
  if (!fn) {
    throw new Error('Timer API is unavailable in this runtime')
  }
  return fn(callback, ms)
}

export function cancelTimeout(id: ReturnType<typeof setTimeout> | undefined): void {
  const fn = typeof clearTimeout === 'function' ? clearTimeout : undefined
  if (fn && id !== undefined) {
    fn(id)
  }
}

export function resolveFetchImpl(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? fetch
}

export function toError(reason: unknown, fallbackMessage = 'aborted'): Error {
  if (reason instanceof Error) {
    return reason
  }
  if (typeof reason === 'string' && reason.length > 0) {
    return new Error(reason)
  }
  return new Error(fallbackMessage)
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(toError(signal.reason))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(toError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (val) => {
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(toError(err, 'request failed'))
      },
    )
  })
}

export async function resolveSecretValue(provider: SecretValueProvider | undefined): Promise<string> {
  if (typeof provider === 'string') return provider.trim()
  if (typeof provider === 'function') {
    const val = await provider()
    return typeof val === 'string' ? val.trim() : ''
  }
  return ''
}

export async function readBoundedStreamBytes(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
  createTooLargeError: () => Error,
): Promise<Uint8Array> {
  const declaredLen = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    await res.body?.cancel().catch(() => undefined)
    throw createTooLargeError()
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    const ab = await raceAbort(res.arrayBuffer(), signal)
    if (ab.byteLength > maxBytes) {
      throw createTooLargeError()
    }
    return new Uint8Array(ab)
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal)
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw createTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

/**
 * Read up to `maxErrorBytes` of an HTTP error body, run `redactSecrets` over the full window
 * BEFORE truncating to `maxMessageChars` so secrets crossing the cut boundary are masked.
 */
export async function readRedactedHttpErrorMessage(
  res: Response,
  maxErrorBytes: number,
  maxMessageChars: number,
  signal: AbortSignal,
): Promise<string> {
  const prefix = `HTTP ${res.status}`
  try {
    let rawText = ''
    if (!res.body || typeof res.body.getReader !== 'function') {
      const ab = await raceAbort(res.arrayBuffer(), signal)
      rawText = UTF8_DECODER.decode(new Uint8Array(ab, 0, Math.min(ab.byteLength, maxErrorBytes)))
    } else {
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      try {
        while (total < maxErrorBytes) {
          const { done, value } = await raceAbort(reader.read(), signal)
          if (done || !value) break
          const take = Math.min(value.byteLength, maxErrorBytes - total)
          if (take > 0) {
            chunks.push(value.subarray(0, take))
            total += take
          }
          if (total >= maxErrorBytes) {
            await reader.cancel().catch(() => undefined)
          }
        }
      } finally {
        reader.releaseLock()
      }
      const merged = new Uint8Array(total)
      let off = 0
      for (const c of chunks) {
        merged.set(c, off)
        off += c.byteLength
      }
      rawText = UTF8_DECODER.decode(merged)
    }

    const redacted = redactSecrets(rawText).replace(/\s+/g, ' ').trim()
    if (!redacted) return prefix
    return `${prefix}: ${redacted}`.slice(0, maxMessageChars)
  } catch {
    return prefix
  }
}

export function mergeFloat32Chunks(chunks: readonly Float32Array[], totalSamples: number): Float32Array {
  const merged = new Float32Array(totalSamples)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}
