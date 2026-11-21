import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CloudDictationSession,
  DEFAULT_CLOUD_MIN_SPEECH_MS,
  DEFAULT_CLOUD_SPEECH_RMS_THRESHOLD,
  DICTATION_PRE_ROLL_MS,
  DICTATION_PRE_ROLL_SAMPLES,
  TARGET_SAMPLE_RATE,
} from '../src/index.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeConstantChunk(samples, amplitude = 0) {
  const out = new Float32Array(samples)
  if (amplitude !== 0) out.fill(amplitude)
  return out
}

function makeSpeechChunk(samples, amplitude = 0.08) {
  const out = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    out[i] = i % 2 === 0 ? amplitude : -amplitude
  }
  return out
}

function createCloudRig(options = {}) {
  const calls = []
  let abortCalls = 0
  let pushChunk = null
  let openMicStreams = 0
  let micStops = 0
  const states = []
  const activities = []
  const transcripts = []
  const errors = []

  const transport =
    options.transport ?? {
      kind: 'openai-compat',
      async transcribe(pcm16k, opts = {}) {
        const idx = calls.length + 1
        const record = {
          idx,
          pcm: new Float32Array(pcm16k),
          sampleRate: opts.sampleRate,
          language: opts.language,
          signal: opts.signal,
        }
        calls.push(record)
        if (options.onTranscribe) {
          return options.onTranscribe(record)
        }
        return {
          text: `cloud-utt-${idx}:${pcm16k.length}`,
          isFinal: true,
          durationMs: Math.round((pcm16k.length / TARGET_SAMPLE_RATE) * 1000),
        }
      },
      abort() {
        abortCalls++
      },
      async close() {},
    }

  const session = new CloudDictationSession({
    transport,
    endpointPolicy: options.endpointPolicy,
    language: options.language,
    speechRmsThreshold: options.speechRmsThreshold,
    minSpeechMs: options.minSpeechMs,
    captureAudio:
      options.captureAudio ??
      (async ({ onChunk }) => {
        openMicStreams++
        pushChunk = onChunk
        let stopped = false
        return {
          stop: async () => {
            if (stopped) return
            stopped = true
            openMicStreams--
            micStops++
            pushChunk = null
          },
        }
      }),
    onStateChange: (s) => states.push(s),
    onSpeechActivity: (a) => activities.push(a),
    onFinalTranscript: (text, info) => transcripts.push({ text, info }),
    onError: (err) => errors.push(err),
  })

  return {
    session,
    transport,
    calls,
    states,
    activities,
    transcripts,
    errors,
    getAbortCalls: () => abortCalls,
    getOpenMicStreams: () => openMicStreams,
    getMicStops: () => micStops,
    feed(chunk) {
      if (pushChunk) pushChunk(chunk)
    },
  }
}

describe('M3 CloudDictationSession: zero-WASM/zero-Worker BYOK dictation across single, toggle, and push-to-talk', () => {
  it('verifies Web-standard purity (zero obsidian, electron, node:*, Worker, WASM, or regex lookbehind)', () => {
    const src = readFileSync(
      new URL('../src/cloud-dictation-session.ts', import.meta.url),
      'utf8',
    )
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    const negLb = '(?' + '<!'
    const posLb = '(?' + '<='
    assert.equal(/from\s+['"](?:obsidian|electron|node:)/.test(codeOnly), false)
    assert.equal(/\bWorker\b|\bWebAssembly\b|\bSherpaWorkerClient\b/.test(codeOnly), false)
    assert.equal(src.includes(negLb), false)
    assert.equal(src.includes(posLb), false)
    assert.equal(DEFAULT_CLOUD_SPEECH_RMS_THRESHOLD, 0.008)
    assert.equal(DEFAULT_CLOUD_MIN_SPEECH_MS, 160)
    assert.equal(DICTATION_PRE_ROLL_MS, 640)
    assert.equal(DICTATION_PRE_ROLL_SAMPLES, 10240)
  })

  it('single mode: preserves exact 640 ms pre-roll before speech onset, rejects single-frame click, and auto-stops mic on silence endpoint -> transcribe -> idle', async () => {
    const rig = createCloudRig({
      endpointPolicy: { silenceMs: 320, maxSpeechSec: 60 },
      language: 'zh',
    })

    await rig.session.start('single')
    assert.equal(rig.session.state, 'listening')
    assert.equal(rig.getOpenMicStreams(), 1)

    // 1) Feed a single-frame click (1024 samples = 64 ms < 160 ms minSpeechMs) with high RMS (0.05):
    //    must NOT trigger speech onset or onSpeechActivity(true)!
    rig.feed(makeSpeechChunk(1024, 0.05))
    rig.feed(makeConstantChunk(1024, 0))
    assert.equal(rig.activities.length, 0)
    assert.equal(rig.calls.length, 0)

    // 2) Feed 12 silent 1024-sample chunks (12,288 > 10,240 pre-roll capacity) with unique markers
    //    below speechRmsThreshold (0.008) so wraparound retains chunks #3..#12 (exact 640 ms = 10,240 samples).
    for (let i = 1; i <= 12; i++) {
      const c = makeConstantChunk(1024, 0)
      c[0] = i * 0.0001
      rig.feed(c)
    }

    // 3) Speech onset: 4 chunks of 1024 samples = 256 ms >= 160 ms (onset confirmed on chunk #3,
    //    while preserving ALL 10,240 pre-roll samples prior to chunk #1 AND chunks #1..#4!).
    for (let i = 0; i < 4; i++) {
      rig.feed(makeSpeechChunk(1024, 0.05))
    }
    assert.equal(rig.calls.length, 0)

    // 4) Trailing silence >= 320 ms (5 * 1024 = 5,120 samples = 320 ms) -> triggers single endpoint!
    for (let i = 0; i < 5; i++) {
      rig.feed(makeConstantChunk(1024, 0))
    }

    // Extra speech after endpoint must be ignored because single mode auto-stops capture immediately
    rig.feed(makeSpeechChunk(1024, 0.08))
    rig.feed(makeSpeechChunk(1024, 0.08))

    const deadline = Date.now() + 1000
    while (rig.session.state !== 'idle' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5))
    }

    assert.equal(rig.session.state, 'idle')
    assert.equal(rig.getOpenMicStreams(), 0)
    assert.equal(rig.getMicStops(), 1)
    assert.equal(rig.errors.length, 0)
    assert.deepEqual(rig.states, ['starting', 'listening', 'transcribing', 'idle'])
    assert.deepEqual(rig.activities, [true, false])

    assert.equal(rig.calls.length, 1)
    const call = rig.calls[0]
    assert.equal(call.sampleRate, 16000)
    assert.equal(call.language, 'zh')

    // 10,240 pre-roll + 4*1024 speech + 5*1024 trailing silence = 19,456 samples
    assert.equal(call.pcm.length, 10240 + 9 * 1024)
    for (let k = 0; k < 10; k++) {
      const expectedMarker = (k + 3) * 0.0001
      assert.ok(
        Math.abs(call.pcm[k * 1024] - expectedMarker) < 1e-7,
        `pre-roll chunk ${k} mismatch: got ${call.pcm[k * 1024]} expected ${expectedMarker}`,
      )
    }
    // Verify first speech sample begins immediately at index 10,240 (0 leading speech clipped!)
    assert.ok(Math.abs(call.pcm[10240] - 0.05) < 1e-6)

    assert.equal(rig.transcripts.length, 1)
    assert.equal(rig.transcripts[0].text, 'cloud-utt-1:19456')
    assert.equal(rig.transcripts[0].info.mode, 'single')
    assert.equal(rig.transcripts[0].info.durationMs, 1216)
  })

  it('toggle mode: serializes multi-utterance background transcriptions while listening and flushes trailing utterance on stop({ flush: true })', async () => {
    const firstUploadGate = deferred()
    const rig = createCloudRig({
      endpointPolicy: { silenceMs: 320, maxSpeechSec: 60 },
      language: 'en',
      onTranscribe: async (record) => {
        if (record.idx === 1) {
          await firstUploadGate.promise
        }
        return {
          text: `seg-${record.idx}:${record.language}:${record.pcm.length}`,
          isFinal: true,
        }
      },
    })

    await rig.session.start('toggle')

    // Utterance 1: 3 speech chunks (192 ms >= 160 ms) + 2 silent breath chunks (128 ms < 320 ms)
    // + 2 speech chunks + 5 silent endpoint chunks (320 ms)
    rig.feed(makeConstantChunk(1024, 0))
    for (let i = 0; i < 3; i++) rig.feed(makeSpeechChunk(1024, 0.04))
    rig.feed(makeConstantChunk(1024, 0))
    rig.feed(makeConstantChunk(1024, 0))
    rig.feed(makeSpeechChunk(1024, 0.04))
    rig.feed(makeSpeechChunk(1024, 0.04))
    for (let i = 0; i < 5; i++) rig.feed(makeConstantChunk(1024, 0))

    // Session MUST remain in 'listening' with mic open while Utterance 1 uploads in the background!
    assert.equal(rig.session.state, 'listening')
    assert.equal(rig.getOpenMicStreams(), 1)

    // Live config updates mid-session apply cleanly to Utterance 2
    rig.session.updateLanguage('ja')
    rig.session.updateEndpointPolicy({ silenceMs: 600 })

    // Utterance 2 starts speaking (3 * 1024 = 192 ms >= 160 ms) and user stops with flush: true
    // BEFORE 600 ms silence elapses and WHILE Utterance 1 is still uploading!
    rig.feed(makeConstantChunk(1024, 0))
    for (let i = 0; i < 3; i++) rig.feed(makeSpeechChunk(1024, 0.06))

    const stopPromise = rig.session.stop({ flush: true })
    await new Promise((r) => setTimeout(r, 15))
    // Mic is already closed, waiting on serialized upload queue
    assert.equal(rig.getOpenMicStreams(), 0)
    assert.equal(rig.transcripts.length, 0)

    firstUploadGate.resolve()
    await stopPromise

    assert.equal(rig.session.state, 'idle')
    assert.equal(rig.getMicStops(), 1)
    assert.equal(rig.errors.length, 0)
    assert.equal(rig.calls.length, 2)
    assert.equal(rig.calls[0].language, 'en')
    assert.equal(rig.calls[1].language, 'ja')
    assert.equal(rig.transcripts.length, 2)
    assert.equal(rig.transcripts[0].text, `seg-1:en:${1024 + 12 * 1024}`)
    assert.equal(rig.transcripts[0].info.mode, 'toggle')
    // Utterance 2 has 2560 seeded inter-utterance lead-in + 1024 silent chunk + 3*1024 speech = 6,656 samples
    assert.equal(rig.transcripts[1].text, `seg-2:ja:${2560 + 4 * 1024}`)
    assert.equal(rig.transcripts[1].info.mode, 'toggle')
  })

  it('supports streaming-contract AsrTransport (start / pushAudio / finalize) seamlessly', async () => {
    const events = []
    let pushedSamples = 0
    const streamingTransport = {
      kind: 'openai-compat',
      async start(opts) {
        events.push(`start:${opts?.language ?? 'auto'}`)
      },
      pushAudio(pcm) {
        pushedSamples += pcm.length
        events.push(`push:${pcm.length}`)
      },
      async finalize() {
        events.push('finalize')
        return { text: `streamed:${pushedSamples}`, isFinal: true }
      },
      async close() {},
    }

    const rig = createCloudRig({
      transport: streamingTransport,
      language: 'zh',
    })

    await rig.session.start('toggle')
    for (let i = 0; i < 3; i++) rig.feed(makeSpeechChunk(1024, 0.05))
    await rig.session.stop({ flush: true })

    assert.equal(rig.transcripts.length, 1)
    assert.equal(rig.transcripts[0].text, 'streamed:3072')
    assert.deepEqual(events, ['start:zh', 'push:3072', 'finalize'])
  })

  it('push-to-talk mode: ignores short (< 150 ms) or silent (< 0.002 RMS) taps with 0 network calls, and transcribes real held speech on release', async () => {
    const rig = createCloudRig({ language: 'en' })

    // 1) Short tap: 2 * 1024 = 2,048 samples = 128 ms (< 150 ms = 2,400 samples) -> 0 network calls
    await rig.session.start('push-to-talk')
    rig.feed(makeSpeechChunk(1024, 0.25))
    rig.feed(makeSpeechChunk(1024, 0.25))
    await rig.session.stop({ flush: true })
    assert.equal(rig.calls.length, 0)
    assert.equal(rig.transcripts.length, 0)
    assert.equal(rig.getOpenMicStreams(), 0)

    // 2) Long silent hold: 4 * 1024 = 4,096 samples = 256 ms, RMS 0.0008 (< 0.002) -> 0 network calls
    await rig.session.start('push-to-talk')
    for (let i = 0; i < 4; i++) {
      rig.feed(makeConstantChunk(1024, 0.0008))
    }
    await rig.session.stop({ flush: true })
    assert.equal(rig.calls.length, 0)
    assert.equal(rig.transcripts.length, 0)
    assert.equal(rig.getOpenMicStreams(), 0)

    // 3) Real held utterance: 5 * 1024 = 5,120 samples = 320 ms, RMS 0.12 -> 1 network call!
    await rig.session.start('push-to-talk')
    for (let i = 0; i < 5; i++) {
      rig.feed(makeSpeechChunk(1024, 0.12))
    }
    await rig.session.stop({ flush: true })
    assert.equal(rig.calls.length, 1)
    assert.equal(rig.calls[0].pcm.length, 5120)
    assert.equal(rig.transcripts.length, 1)
    assert.equal(rig.transcripts[0].text, 'cloud-utt-1:5120')
    assert.equal(rig.transcripts[0].info.mode, 'push-to-talk')
    assert.equal(rig.transcripts[0].info.durationMs, 320)
    assert.equal(rig.getOpenMicStreams(), 0)
  })

  it('enforces 60s (maxSpeechSec) forced segment split without dropping a single sample across non-aligned chunks or brief post-split tails', async () => {
    const rig = createCloudRig({
      // Default maxSpeechSec = 60 -> 960,000 samples (937.5 * 1024-sample frames!)
      endpointPolicy: { silenceMs: 1500, maxSpeechSec: 60 },
    })

    await rig.session.start('toggle')

    // Feed 1,000 frames of 1,024 samples = 1,024,000 samples (64.0s continuous speech).
    // Encode sequential frame index into amplitude (0.02 + frameIdx * 0.0001) so we can verify
    // zero dropped or duplicated samples across the mid-chunk 960,000-sample split on frame #937!
    const totalFrames = 1000
    for (let f = 0; f < totalFrames; f++) {
      const val = 0.02 + (f % 500) * 0.0001
      rig.feed(makeSpeechChunk(1024, val))
    }

    await rig.session.stop({ flush: true })

    assert.equal(rig.calls.length, 2)
    assert.equal(rig.calls[0].pcm.length, 960000) // Exact 60.0s!
    assert.equal(rig.calls[1].pcm.length, 1024000 - 960000) // Exact remaining 64,000 samples (4.0s)!

    // Verify sample continuity right across the 960,000 split (frame #937 = 937 * 1024 = 959,488):
    // First 512 samples of frame #937 end Segment 1; remaining 512 samples of frame #937 start Segment 2!
    const expectedSplitVal = 0.02 + (937 % 500) * 0.0001
    assert.ok(Math.abs(Math.abs(rig.calls[0].pcm[959999]) - expectedSplitVal) < 1e-6)
    assert.ok(Math.abs(Math.abs(rig.calls[1].pcm[0]) - expectedSplitVal) < 1e-6)
    const expectedNextFrameVal = 0.02 + (938 % 500) * 0.0001
    assert.ok(Math.abs(Math.abs(rig.calls[1].pcm[512]) - expectedNextFrameVal) < 1e-6)

    // Also test exact-boundary split (5s = 80,000 samples = 50 * 1600) followed by just 1 frame
    // of 1024 samples (64 ms < 160 ms minSpeechMs): must still retain that 64 ms continuation!
    const boundaryRig = createCloudRig({
      endpointPolicy: { silenceMs: 1500, maxSpeechSec: 5 },
    })
    await boundaryRig.session.start('toggle')
    for (let i = 0; i < 50; i++) {
      boundaryRig.feed(makeSpeechChunk(1600, 0.05))
    }
    boundaryRig.feed(makeSpeechChunk(1024, 0.05))
    await boundaryRig.session.stop({ flush: true })

    assert.equal(boundaryRig.calls.length, 2)
    assert.equal(boundaryRig.calls[0].pcm.length, 80000)
    assert.equal(boundaryRig.calls[1].pcm.length, 1024)
  })

  it('handles rapid start() -> abort() during capture setup, start() -> stop() -> start() epoch races, and mid-transcribe upload cancellation with 0 leaked streams and 0 false onError', async () => {
    // ── Case A: Rapid start() -> abort() while getUserMedia / AudioWorklet setup is still pending ──
    const setupGate = deferred()
    let openStreamsA = 0
    let stoppedStreamsA = 0
    const rigA = createCloudRig({
      captureAudio: async () => {
        await setupGate.promise
        openStreamsA++
        let closed = false
        return {
          stop: async () => {
            if (closed) return
            closed = true
            openStreamsA--
            stoppedStreamsA++
          },
        }
      },
    })

    const pStartA = rigA.session.start('single')
    await rigA.session.abort()
    assert.equal(rigA.session.state, 'idle')

    // Release delayed captureAudio: stale handle MUST be immediately closed with 0 leaked streams!
    setupGate.resolve()
    await pStartA
    assert.equal(openStreamsA, 0)
    assert.equal(stoppedStreamsA, 1)
    assert.equal(rigA.session.state, 'idle')
    assert.equal(rigA.errors.length, 0)
    assert.equal(rigA.transcripts.length, 0)

    // ── Case B: Rapid start() -> stop() -> start() where Call 1 resolves after Call 2 is listening ──
    const firstGate = deferred()
    let captureAttempt = 0
    let openStreamsB = 0
    let pushSecond = null
    const rigB = createCloudRig({
      captureAudio: async ({ onChunk }) => {
        const attempt = ++captureAttempt
        if (attempt === 1) {
          await firstGate.promise
        }
        openStreamsB++
        if (attempt === 2) {
          pushSecond = onChunk
        }
        let closed = false
        return {
          stop: async () => {
            if (closed) return
            closed = true
            openStreamsB--
          },
        }
      },
    })

    const p1 = rigB.session.start('toggle')
    await rigB.session.stop()
    assert.equal(rigB.session.state, 'idle')

    await rigB.session.start('toggle')
    assert.equal(rigB.session.state, 'listening')
    assert.equal(openStreamsB, 1)

    // Late resolution of Call 1 closes ONLY Call 1's stream without clobbering Call 2!
    firstGate.resolve()
    await p1
    assert.equal(openStreamsB, 1)
    assert.equal(rigB.session.state, 'listening')

    for (let i = 0; i < 3; i++) pushSecond(makeSpeechChunk(1024, 0.05))
    await rigB.session.stop({ flush: true })
    assert.equal(openStreamsB, 0)
    assert.equal(rigB.transcripts.length, 1)
    assert.equal(rigB.errors.length, 0)

    // ── Case C: Mid-`transport.transcribe` network upload cancellation via abort() ──
    const uploadStarted = deferred()
    let capturedSignal = null
    let signalAbortEvents = 0
    const rigC = createCloudRig({
      endpointPolicy: { silenceMs: 256, maxSpeechSec: 60 },
      onTranscribe: async (record) => {
        capturedSignal = record.signal
        return new Promise((_resolve, reject) => {
          record.signal.addEventListener(
            'abort',
            () => {
              signalAbortEvents++
              const abortErr = new Error('The operation was aborted.')
              abortErr.name = 'AbortError'
              reject(abortErr)
            },
            { once: true },
          )
          uploadStarted.resolve()
        })
      },
    })

    await rigC.session.start('toggle')
    for (let i = 0; i < 3; i++) rigC.feed(makeSpeechChunk(1024, 0.06))
    for (let i = 0; i < 4; i++) rigC.feed(makeConstantChunk(1024, 0)) // 256 ms -> triggers upload!

    await uploadStarted.promise
    assert.equal(rigC.calls.length, 1)
    assert.equal(capturedSignal.aborted, false)
    assert.equal(rigC.getOpenMicStreams(), 1)

    // Cancel mid-upload!
    await rigC.session.abort()
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(rigC.session.state, 'idle')
    assert.equal(rigC.getOpenMicStreams(), 0)
    assert.equal(capturedSignal.aborted, true)
    assert.equal(signalAbortEvents, 1)
    assert.equal(rigC.getAbortCalls(), 1)
    assert.equal(rigC.transcripts.length, 0)
    assert.equal(rigC.errors.length, 0)
  })
})
