/**
 * Linear interpolation audio resampling for browser/Electron capture pipelines.
 */

export const TARGET_SAMPLE_RATE = 16000

/** Resample mono Float32 PCM from `srcRate` Hz to `dstRate` Hz using linear interpolation. */
export function resampleLinear(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (!Number.isFinite(srcRate) || srcRate <= 0) {
    throw new RangeError(`invalid srcRate: ${srcRate}`)
  }
  if (!Number.isFinite(dstRate) || dstRate <= 0) {
    throw new RangeError(`invalid dstRate: ${dstRate}`)
  }
  if (src.length === 0) return new Float32Array(0)
  if (srcRate === dstRate) return src
  const ratio = srcRate / dstRate
  const outLen = Math.max(1, Math.floor(src.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, src.length - 1)
    const frac = pos - i0
    out[i] = src[i0]! + (src[i1]! - src[i0]!) * frac
  }
  return out
}

/** Downsample (or resample) mono Float32 PCM to 16 kHz for VAD and ASR pipelines. */
export function downsampleTo16k(src: Float32Array, srcRate: number): Float32Array {
  return resampleLinear(src, srcRate, TARGET_SAMPLE_RATE)
}
