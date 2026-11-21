import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  TARGET_SAMPLE_RATE,
  resampleLinear,
  downsampleTo16k,
  VOICE_CAPTURE_PROCESSOR_NAME,
  VOICE_CAPTURE_WORKLET_SOURCE,
  createWorkletModuleUrl,
} from '../src/index.ts'

describe('voice-browser: lookbehind-free guarantee', () => {
  it('contains zero regex lookbehind patterns anywhere in @voice-mode/browser src/', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const negLb = '(?' + '<!'
    const posLb = '(?' + '<='
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts')) continue
      const content = readFileSync(join(srcDir, file), 'utf8')
      assert.equal(content.includes(negLb), false, `${file} must not contain negative lookbehind`)
      assert.equal(content.includes(posLb), false, `${file} must not contain positive lookbehind`)
    }
  })
})

describe('resample: downsampleTo16k and resampleLinear', () => {
  it('downsamples 48 kHz and 44.1 kHz accurately to 16 kHz and handles identity/empty/invalid rates', () => {
    assert.equal(TARGET_SAMPLE_RATE, 16000)

    const src48 = new Float32Array(480)
    for (let i = 0; i < src48.length; i++) src48[i] = i / 480
    const dst16 = downsampleTo16k(src48, 48000)
    assert.equal(dst16.length, 160)
    assert.ok(Math.abs(dst16[0] - 0) < 1e-6)
    assert.ok(Math.abs(dst16[80] - 240 / 480) < 1e-5)

    const src44 = new Float32Array(441)
    for (let i = 0; i < src44.length; i++) src44[i] = i / 441
    const dstFrom44 = downsampleTo16k(src44, 44100)
    assert.equal(dstFrom44.length, 160)
    assert.ok(Math.abs(dstFrom44[1] - 2.75625 / 441) < 1e-4)

    const src16 = new Float32Array([0.1, -0.2, 0.3])
    assert.equal(downsampleTo16k(src16, 16000), src16)

    assert.equal(downsampleTo16k(new Float32Array(0), 48000).length, 0)

    assert.throws(() => resampleLinear(src16, 0, 16000), RangeError)
    assert.throws(() => resampleLinear(src16, 48000, -1), RangeError)
  })
})

describe('audio-worklet-source: CSP static URL, Blob revoke, fractional 44.1kHz phase tracking, and stop teardown', () => {
  it('prefers static worklet URL without allocating a Blob and revokes Blob URLs idempotently', () => {
    let created = 0
    let revoked = 0
    const staticHandle = createWorkletModuleUrl('chrome-extension://abc/worklet.js', {
      createObjectURL: () => {
        created++
        return 'blob:should-not-happen'
      },
      revokeObjectURL: () => {
        revoked++
      },
    })
    assert.equal(staticHandle.url, 'chrome-extension://abc/worklet.js')
    assert.equal(staticHandle.isBlob, false)
    assert.equal(created, 0)
    staticHandle.revoke()
    assert.equal(revoked, 0)

    const blobHandle = createWorkletModuleUrl(undefined, {
      createObjectURL: () => {
        created++
        return 'blob:voice-worklet-1'
      },
      revokeObjectURL: (u) => {
        assert.equal(u, 'blob:voice-worklet-1')
        revoked++
      },
    })
    assert.equal(blobHandle.url, 'blob:voice-worklet-1')
    assert.equal(blobHandle.isBlob, true)
    assert.equal(created, 1)
    blobHandle.revoke()
    blobHandle.revoke()
    assert.equal(revoked, 1)
  })

  it('executes inline AudioWorkletProcessor cleanly at 48 kHz and 16 kHz without detaching internal buffers, and honors { type: "stop" }', () => {
    for (const rate of [48000, 16000]) {
      let registeredName = ''
      let ProcessorCtor = null
      class FakeAudioWorkletProcessor {
        constructor() {
          this.posted = []
          this.port = {
            onmessage: null,
            postMessage: (data, transfer) => {
              this.posted.push({ data, transfer })
            },
          }
        }
      }
      const registerProcessor = (name, ctor) => {
        registeredName = name
        ProcessorCtor = ctor
      }
      const run = new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', VOICE_CAPTURE_WORKLET_SOURCE)
      run(rate, FakeAudioWorkletProcessor, registerProcessor)

      assert.equal(registeredName, VOICE_CAPTURE_PROCESSOR_NAME)
      assert.ok(ProcessorCtor)
      const proc = new ProcessorCtor()
      const totalInput = Math.ceil((2048 * rate) / 16000) + 128
      for (let offset = 0; offset < totalInput; offset += 128) {
        const frame = new Float32Array(Math.min(128, totalInput - offset)).fill(0.25)
        assert.equal(proc.process([[frame]]), true)
      }
      assert.equal(proc.posted.length, 2)
      assert.equal(proc.posted[0].data.length, 1024)
      assert.equal(proc.posted[0].transfer[0], proc.posted[0].data.buffer)
      assert.notEqual(proc.posted[0].data.buffer, proc.acc.buffer)
      assert.notEqual(proc.posted[0].data.buffer, proc.outBuf.buffer)

      // Sending { type: 'stop' } causes process() to return false for clean AudioWorklet teardown
      proc.port.onmessage({ data: { type: 'stop' } })
      assert.equal(proc.process([[new Float32Array(128)]]), false)
    }
  })

  it('tracks fractional 44.1 kHz -> 16 kHz phase continuously with zero chunk-boundary drift', () => {
    let ProcessorCtor = null
    class FakeAudioWorkletProcessor {
      constructor() {
        this.posted = []
        this.port = {
          onmessage: null,
          postMessage: (data, transfer) => {
            this.posted.push({ data, transfer })
          },
        }
      }
    }
    const run = new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', VOICE_CAPTURE_WORKLET_SOURCE)
    run(44100, FakeAudioWorkletProcessor, (_name, ctor) => {
      ProcessorCtor = ctor
    })

    const proc = new ProcessorCtor()
    // Feed 1 second (44100 samples) of exact linear ramp x[n] = n / 44100 in 128-sample WebAudio render quanta
    const totalInput = 44100
    for (let offset = 0; offset < totalInput; offset += 128) {
      const len = Math.min(128, totalInput - offset)
      const frame = new Float32Array(len)
      for (let i = 0; i < len; i++) frame[i] = (offset + i) / totalInput
      proc.process([[frame]])
    }

    // floor(44099 / 2.75625) = 15999 -> 15 full 1024-sample chunks (15360 samples)
    assert.equal(proc.posted.length, 15)
    const ratio = 44100 / 16000
    // Verify the final chunk's last sample (index 15359) has zero accumulated drift!
    const lastChunk = proc.posted[14].data
    const globalSampleIdx = 14 * 1024 + 1023
    const expected = (globalSampleIdx * ratio) / totalInput
    assert.ok(
      Math.abs(lastChunk[1023] - expected) < 1e-5,
      `drift detected at chunk 15: got=${lastChunk[1023]} expected=${expected}`,
    )
  })
})
