import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { encodeMonoPcm16Wav, decodeMonoPcm16Wav } from '../src/index.ts'

describe('WAV export: encode/decode round-trip', () => {
  it('round-trips mono PCM16LE samples', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 0.999, -0.999])
    const wav = encodeMonoPcm16Wav(samples, 24000)
    const decoded = decodeMonoPcm16Wav(wav)
    assert.ok(decoded)
    assert.equal(decoded.sampleRate, 24000)
    assert.equal(decoded.samples.length, samples.length)
    for (let i = 0; i < samples.length; i++) {
      assert.ok(Math.abs(decoded.samples[i] - samples[i]) < 0.001, `sample ${i}`)
    }
  })

  it('joins multiple decoded chunks into one WAV', () => {
    const first = decodeMonoPcm16Wav(encodeMonoPcm16Wav(new Float32Array([0.1, 0.2]), 16000))
    const second = decodeMonoPcm16Wav(encodeMonoPcm16Wav(new Float32Array([0.3]), 16000))
    assert.ok(first && second)
    const total = new Float32Array([...first.samples, ...second.samples])
    const wav = encodeMonoPcm16Wav(total, 16000)
    const joined = decodeMonoPcm16Wav(wav)
    assert.ok(joined)
    assert.equal(joined.samples.length, 3)
    assert.equal(joined.sampleRate, 16000)
  })

  it('rejects non-WAV and truncated input', () => {
    assert.equal(decodeMonoPcm16Wav(new Uint8Array(10)), null)
    assert.equal(decodeMonoPcm16Wav(new TextEncoder().encode('not a wav file at all, definitely not')), null)
  })
})
