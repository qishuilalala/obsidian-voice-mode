/**
 * Self-contained AudioWorkletProcessor source string and CSP-friendly module URL loader.
 *
 * Supports passing a pre-hosted static `workletUrl` (required under strict MV3 CSP
 * where `blob:` script URLs are blocked) and falls back to an object Blob URL with
 * an explicit idempotent `revoke()` handle to prevent leaks.
 */

export const VOICE_CAPTURE_PROCESSOR_NAME = 'voice-capture'

/**
 * Inline ES module source registered via `audioContext.audioWorklet.addModule(url)`.
 *
 * Uses continuous fractional phase stepping (eliminating 44.1 kHz chunk-boundary phase
 * drift), transfers owned 1024-sample Float32Array chunks so internal buffers are never
 * detached, and honors `{ type: 'stop' }` messages on `port` for clean teardown.
 */
export const VOICE_CAPTURE_WORKLET_SOURCE = `
const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_CHUNK_SAMPLES = 1024;

class VoiceCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = typeof opts.targetSampleRate === 'number' && opts.targetSampleRate > 0
      ? opts.targetSampleRate
      : DEFAULT_TARGET_RATE;
    this.chunkSamples = typeof opts.chunkSamples === 'number' && opts.chunkSamples > 0
      ? Math.floor(opts.chunkSamples)
      : DEFAULT_CHUNK_SAMPLES;
    this.ratio = sampleRate / this.targetRate;
    this.acc = new Float32Array(0);
    this.accLen = 0;
    this.phase = 0;
    this.outBuf = new Float32Array(this.chunkSamples);
    this.outLen = 0;
    this.stopped = false;
    if (this.port) {
      this.port.onmessage = (event) => {
        const data = event && event.data;
        if (data && data.type === 'stop') {
          this.stopped = true;
        }
      };
    }
  }

  process(inputs) {
    if (this.stopped) return false;
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length > 0) this.push(ch);
    this.drain();
    return true;
  }

  push(ch) {
    if (this.accLen + ch.length > this.acc.length) {
      let cap = this.acc.length > 0 ? this.acc.length : Math.max(this.chunkSamples * 4, 2048);
      while (cap < this.accLen + ch.length) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.acc.subarray(0, this.accLen));
      this.acc = next;
    }
    this.acc.set(ch, this.accLen);
    this.accLen += ch.length;
  }

  emitChunk(src) {
    // Always copy into an owned buffer before transferring so internal buffers are never detached.
    const chunk = new Float32Array(this.chunkSamples);
    chunk.set(src);
    this.port.postMessage(chunk, [chunk.buffer]);
  }

  drain() {
    if (sampleRate === this.targetRate) {
      while (this.accLen >= this.chunkSamples) {
        this.emitChunk(this.acc.subarray(0, this.chunkSamples));
        this.acc.copyWithin(0, this.chunkSamples, this.accLen);
        this.accLen -= this.chunkSamples;
      }
      return;
    }

    // Continuous fractional-phase linear interpolation with residual sample retention.
    while (Math.floor(this.phase) + 1 < this.accLen) {
      const i0 = Math.floor(this.phase);
      const frac = this.phase - i0;
      this.outBuf[this.outLen++] = this.acc[i0] + (this.acc[i0 + 1] - this.acc[i0]) * frac;
      this.phase += this.ratio;
      if (this.outLen === this.chunkSamples) {
        this.emitChunk(this.outBuf);
        this.outLen = 0;
      }
    }

    const consumed = Math.min(Math.floor(this.phase), this.accLen);
    if (consumed > 0) {
      const keep = this.accLen - consumed;
      if (keep > 0) this.acc.copyWithin(0, consumed, this.accLen);
      this.accLen = keep;
      this.phase -= consumed;
    }
  }
}

registerProcessor('${VOICE_CAPTURE_PROCESSOR_NAME}', VoiceCaptureProcessor);
`.trim()

export interface WorkletModuleHandle {
  /** Module URL suitable for `audioContext.audioWorklet.addModule(url)`. */
  readonly url: string
  /** True when `url` is a dynamically allocated Blob URL that must be revoked. */
  readonly isBlob: boolean
  /** Idempotently release the allocated Blob URL (no-op for static URLs). */
  revoke(): void
}

export interface CreateWorkletUrlOptions {
  source?: string
  createObjectURL?: (blob: Blob) => string
  revokeObjectURL?: (url: string) => void
}

/**
 * Resolve an AudioWorklet module URL.
 * Prefers `staticUrl` when provided (MV3 CSP-safe); otherwise creates a JS Blob URL
 * paired with an explicit `revoke()` cleanup handle.
 */
export function createWorkletModuleUrl(
  staticUrl?: string,
  options: CreateWorkletUrlOptions = {},
): WorkletModuleHandle {
  const trimmed = typeof staticUrl === 'string' ? staticUrl.trim() : ''
  if (trimmed.length > 0) {
    return {
      url: trimmed,
      isBlob: false,
      revoke(): void {
        // Static asset URLs do not allocate object URLs.
      },
    }
  }

  const source = options.source ?? VOICE_CAPTURE_WORKLET_SOURCE
  const createUrl = options.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b))
  const revokeUrl = options.revokeObjectURL ?? ((u: string) => URL.revokeObjectURL(u))
  const blob = new Blob([source], { type: 'application/javascript;charset=utf-8' })
  const url = createUrl(blob)
  let revoked = false

  return {
    url,
    isBlob: true,
    revoke(): void {
      if (revoked) return
      revoked = true
      revokeUrl(url)
    },
  }
}
