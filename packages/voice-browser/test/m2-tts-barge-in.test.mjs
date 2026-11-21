import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  AecBargeInMonitor,
  DEFAULT_BARGE_IN_CONFIRM_CHUNKS,
  DEFAULT_BARGE_IN_MIN_RMS,
  PlaybackQueue,
  SherpaWorkerClient,
  VitsWasmTtsEngine,
  clampVitsRate,
  createBargeInMicCapture,
  createSherpaWorkerScript,
  resolveBargeInPolicy,
  resolveVitsSpeakerId,
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

const flushMicrotasks = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function createVmWorkerHarness() {
  const events = []
  const stats = {
    vadCreated: 0,
    vadFreed: 0,
    asrCreated: 0,
    asrFreed: 0,
    ttsCreated: 0,
    ttsFreed: 0,
    ttsCalls: [],
    residentHeavyModels: new Set(),
    peakConcurrentHeavyModels: 0,
  }

  const updatePeakHeavy = () => {
    if (stats.residentHeavyModels.size > stats.peakConcurrentHeavyModels) {
      stats.peakConcurrentHeavyModels = stats.residentHeavyModels.size
    }
  }

  const glueGlobals = {
    Module: async () => ({
      FS: {
        mkdir(_dir) {},
        open(path) {
          return { path }
        },
        write(_stream, _bytes, _offset, length) {
          return length
        },
        close() {},
        unlink() {},
      },
    }),
    SherpaVad: {
      createVad() {
        stats.vadCreated++
        events.push('vad:create')
        let speechNow = false
        return {
          handle: 1,
          acceptWaveform(window512) {
            let sumSq = 0
            for (let i = 0; i < window512.length; i++) {
              sumSq += window512[i] * window512[i]
            }
            const rms = Math.sqrt(sumSq / window512.length)
            // Treat frames >= 0.002 RMS as VAD-positive so tests can independently verify
            // AecBargeInMonitor's `minRmsThreshold = 0.0045` gate against low-energy echo!
            speechNow = rms >= 0.002
          },
          isDetected() {
            return speechNow
          },
          isEmpty() {
            return true
          },
          pop() {},
          reset() {
            speechNow = false
          },
          free() {
            stats.vadFreed++
            events.push('vad:free')
            this.handle = 0
          },
        }
      },
    },
    SherpaAsr: {
      OfflineRecognizer: class {
        constructor() {
          stats.asrCreated++
          stats.residentHeavyModels.add('asr-offline')
          updatePeakHeavy()
          events.push('asr:create')
          this.handle = 1
        }
        createStream() {
          let len = 0
          return {
            acceptWaveform(_sr, samples) {
              len = samples.length
            },
            getLen() {
              return len
            },
            free() {},
          }
        }
        decode() {}
        getResult(stream) {
          return { text: `asr:${stream.getLen()}`, lang: 'zh' }
        }
        free() {
          if (this.handle !== 0) {
            stats.asrFreed++
            stats.residentHeavyModels.delete('asr-offline')
            events.push('asr:free')
            this.handle = 0
          }
        }
      },
    },
    SherpaTts: {
      createOfflineTts() {
        stats.ttsCreated++
        stats.residentHeavyModels.add('tts-vits')
        updatePeakHeavy()
        events.push('tts:create')
        return {
          handle: 1,
          sampleRate: 22050,
          generate(cfg) {
            stats.ttsCalls.push({ ...cfg })
            return {
              samples: new Float32Array([0, 0.25, -0.25, 0.5]),
              sampleRate: 22050,
            }
          },
          free() {
            if (this.handle !== 0) {
              stats.ttsFreed++
              stats.residentHeavyModels.delete('tts-vits')
              events.push('tts:free')
              this.handle = 0
            }
          },
        }
      },
    },
  }

  function workerFactory(scriptSource) {
    let alive = true
    const selfScope = {
      onmessage: null,
      postMessage(res) {
        if (!alive) return
        queueMicrotask(() => {
          if (!alive || typeof worker.onmessage !== 'function') return
          worker.onmessage({ data: res })
        })
      },
    }
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage(msg) {
        if (!alive) throw new Error('Worker terminated')
        queueMicrotask(() => {
          if (!alive || typeof selfScope.onmessage !== 'function') return
          selfScope.onmessage({ data: msg })
        })
      },
      terminate() {
        alive = false
      },
    }

    const sandbox = vm.createContext({
      ...glueGlobals,
      self: selfScope,
      performance,
      WebAssembly,
      ArrayBuffer,
      Uint8Array,
      Float32Array,
      DataView,
    })
    vm.runInContext(scriptSource, sandbox)

    return { worker, revoke() {} }
  }

  function createClient(idleUnloadMs = 0) {
    return new SherpaWorkerClient({
      createWorkerSource: () => createSherpaWorkerScript(''),
      loadModelBinaries: async (target, includeWasm) => {
        const files = []
        if (includeWasm) files.push({ name: 'sherpa-onnx.wasm', buffer: new ArrayBuffer(32) })
        if (target === 'vad') files.push({ name: 'silero_vad.onnx', buffer: new ArrayBuffer(32) })
        if (target === 'asr-offline') {
          files.push(
            { name: 'model.int8.onnx', buffer: new ArrayBuffer(64) },
            { name: 'tokens.txt', buffer: new ArrayBuffer(16) },
          )
        }
        if (target === 'tts-vits') {
          files.push(
            { name: 'model.onnx', buffer: new ArrayBuffer(64) },
            { name: 'lexicon.txt', buffer: new ArrayBuffer(16) },
            { name: 'tokens.txt', buffer: new ArrayBuffer(16) },
          )
        }
        return files
      },
      workerFactory,
      idleUnloadMs,
    })
  }

  return { stats, events, createClient }
}

describe('M2 PlaybackQueue: pause, resume, skipCurrent, and <100ms cancel', () => {
  it('pauses active playback, holds inter-sentence gate when clip ends while paused, keeps paused on background enqueue, and resumes seamlessly', async () => {
    const playGates = new Map()
    const playStarts = []
    const states = []
    let pauseCalls = 0
    let resumeCalls = 0

    const queue = new PlaybackQueue({
      prefetchDepth: 2,
      synthesize: async (text) => ({ audio: new TextEncoder().encode(text), mime: 'audio/wav' }),
      sink: {
        play: async (payload) => {
          const text = new TextDecoder().decode(payload.audio)
          const g = deferred()
          playGates.set(text, g)
          await g.promise
        },
        pause: () => {
          pauseCalls++
        },
        resume: () => {
          resumeCalls++
        },
      },
      onPlayStart: (t) => playStarts.push(t),
      onStateChange: (s) => states.push(s),
    })

    assert.equal(queue.pause(), false)
    assert.equal(queue.resume(), false)
    assert.equal(queue.skipCurrent(), false)

    queue.enqueue('S1')
    queue.enqueue('S2')
    await flushMicrotasks()
    assert.equal(queue.state, 'playing')
    assert.deepEqual(playStarts, ['S1'])

    assert.equal(queue.pause(), true)
    assert.equal(queue.pause(), false)
    assert.equal(queue.state, 'paused')
    assert.equal(pauseCalls, 1)

    // S1 finishes while queue is paused + S3 is enqueued while paused -> S2 MUST NOT start yet!
    playGates.get('S1').resolve()
    queue.enqueue('S3')
    await flushMicrotasks()
    assert.equal(queue.state, 'paused')
    assert.deepEqual(playStarts, ['S1'])

    // Resume releases the inter-sentence pause gate -> S2 starts immediately!
    assert.equal(queue.resume(), true)
    assert.equal(queue.resume(), false)
    assert.equal(resumeCalls, 1)
    assert.equal(queue.state, 'playing')
    await flushMicrotasks()
    assert.deepEqual(playStarts, ['S1', 'S2'])

    playGates.get('S2').resolve()
    await flushMicrotasks()
    assert.deepEqual(playStarts, ['S1', 'S2', 'S3'])
    playGates.get('S3').resolve()

    await queue.waitUntilDrained()
    assert.equal(queue.state, 'idle')
    assert.deepEqual(states, ['playing', 'paused', 'playing', 'idle'])
  })

  it('skipCurrent() aborts ONLY the head item while preserving prefetched/waiting items across playing and paused states, and cancel() finishes in <100ms', async () => {
    const playGates = new Map()
    const playSignals = new Map()
    const playStarts = []
    let stopCalls = 0

    const queue = new PlaybackQueue({
      prefetchDepth: 2,
      synthesize: async (text) => ({ audio: new TextEncoder().encode(text), mime: 'audio/wav' }),
      sink: {
        play: async (payload, signal) => {
          const text = new TextDecoder().decode(payload.audio)
          playSignals.set(text, signal)
          const g = deferred()
          playGates.set(text, g)
          await g.promise
        },
        stop: () => {
          stopCalls++
        },
      },
      onPlayStart: (t) => playStarts.push(t),
    })

    for (const s of ['A1', 'A2', 'A3', 'A4']) queue.enqueue(s)
    await flushMicrotasks()
    assert.deepEqual(playStarts, ['A1'])

    // Skip A1 while playing -> aborts ONLY A1, preserves A2/A3/A4, advances immediately to A2
    assert.equal(queue.skipCurrent(), true)
    assert.equal(playSignals.get('A1').aborted, true)
    assert.equal(stopCalls, 1)
    await flushMicrotasks()
    assert.deepEqual(playStarts, ['A1', 'A2'])
    assert.equal(queue.state, 'playing')

    // Pause during A2, then skipCurrent() -> resumes 'playing' directly into A3!
    assert.equal(queue.pause(), true)
    assert.equal(queue.state, 'paused')
    assert.equal(queue.skipCurrent(), true)
    assert.equal(playSignals.get('A2').aborted, true)
    assert.equal(queue.state, 'playing')
    await flushMicrotasks()
    assert.deepEqual(playStarts, ['A1', 'A2', 'A3'])

    // Skip A3 -> advances to A4 (last item), then pause during A4 and skipCurrent() -> transitions directly to 'idle'!
    assert.equal(queue.skipCurrent(), true)
    await flushMicrotasks()
    assert.deepEqual(playStarts, ['A1', 'A2', 'A3', 'A4'])
    assert.equal(queue.pause(), true)
    assert.equal(queue.skipCurrent(), true)
    await queue.waitUntilDrained()
    assert.equal(queue.state, 'idle')

    // Verify < 100 ms cancel() even when paused on a non-cooperative sink
    queue.enqueue('HANG-1')
    queue.enqueue('HANG-2')
    await flushMicrotasks()
    queue.pause()
    const drainPromise = queue.waitUntilDrained()
    const t0 = performance.now()
    queue.cancel()
    await drainPromise
    const elapsedMs = performance.now() - t0
    assert.ok(elapsedMs < 100, `Expected cancel() < 100 ms, got ${elapsedMs.toFixed(2)} ms`)
    assert.equal(queue.state, 'idle')
  })
})

describe('M2 Single-Heavy-Model Memory Guard (ADR-0002): SenseVoice <-> VITS mutual exclusion with co-resident Silero VAD', () => {
  it('never keeps asr-offline and tts-vits resident simultaneously while preserving Silero VAD across swaps', async () => {
    const harness = createVmWorkerHarness()
    const client = harness.createClient()

    await Promise.all([client.ensureVadLoaded(), client.ensureAsrLoaded()])
    assert.equal(client.isLoaded('vad'), true)
    assert.equal(client.isLoaded('asr-offline'), true)
    assert.equal(client.isLoaded('tts-vits'), false)
    assert.equal(harness.stats.peakConcurrentHeavyModels, 1)

    // Loading VITS TTS evicts SenseVoice BEFORE constructing VITS, while Silero VAD stays loaded!
    const wav = await client.synthesizeTts('测试单大模型互斥', { speakerId: 1, speed: 1.0 })
    assert.ok(wav.audio.byteLength > 44)
    assert.equal(client.isLoaded('vad'), true)
    assert.equal(client.isLoaded('tts-vits'), true)
    assert.equal(client.isLoaded('asr-offline'), false)
    assert.equal(harness.stats.asrFreed, 1)
    assert.equal(harness.stats.vadFreed, 0)
    assert.equal(harness.stats.peakConcurrentHeavyModels, 1)

    // Live VAD continues working during VITS playback without reloading VAD
    const vadRes = await client.processVad(new Float32Array(1024).fill(0.1))
    assert.equal(vadRes.isSpeech, true)
    assert.equal(harness.stats.vadCreated, 1)

    // Switching back to SenseVoice ASR evicts VITS BEFORE constructing SenseVoice, preserving VAD
    const asrRes = await client.transcribe(new Float32Array(3200).fill(0.1))
    assert.equal(asrRes.text, 'asr:3200')
    assert.equal(client.isLoaded('vad'), true)
    assert.equal(client.isLoaded('asr-offline'), true)
    assert.equal(client.isLoaded('tts-vits'), false)
    assert.equal(harness.stats.ttsFreed, 1)
    assert.equal(harness.stats.vadFreed, 0)
    assert.equal(harness.stats.peakConcurrentHeavyModels, 1)

    // Verify strict eviction-before-creation ordering in worker event trace
    const asrFreeIdx = harness.events.indexOf('asr:free')
    const ttsCreateIdx = harness.events.indexOf('tts:create')
    const ttsFreeIdx = harness.events.indexOf('tts:free')
    const secondAsrCreateIdx = harness.events.lastIndexOf('asr:create')
    assert.ok(asrFreeIdx >= 0 && asrFreeIdx < ttsCreateIdx)
    assert.ok(ttsFreeIdx > ttsCreateIdx && ttsFreeIdx < secondAsrCreateIdx)

    // Concurrent back-to-back synthesizeTts + transcribe calls serialize cleanly without race errors
    const [concurrentTts, concurrentAsr] = await Promise.all([
      client.synthesizeTts('并发切换'),
      client.transcribe(new Float32Array(1600).fill(0.1)),
    ])
    assert.ok(concurrentTts.audio.byteLength > 44)
    assert.equal(concurrentAsr.text, 'asr:1600')
    assert.equal(harness.stats.peakConcurrentHeavyModels, 1)

    await client.dispose()
  })
})

describe('M2 VitsWasmTtsEngine: speaker resolution, rate clamping, emotion stripping, and AbortSignal', () => {
  it('maps VITS speakers/IDs, clamps rate to [0.5, 2.0], strips emotion tags, and honors AbortSignal', async () => {
    assert.equal(resolveVitsSpeakerId(undefined), 0)
    assert.equal(resolveVitsSpeakerId('suyingxue'), 0)
    assert.equal(resolveVitsSpeakerId('gunian'), 1)
    assert.equal(resolveVitsSpeakerId('fushiyu'), 2)
    assert.equal(resolveVitsSpeakerId('bingjiao'), 3)
    assert.equal(resolveVitsSpeakerId('bazong'), 4)
    assert.equal(resolveVitsSpeakerId('霸总'), 4)
    assert.equal(resolveVitsSpeakerId('3'), 3)
    assert.equal(resolveVitsSpeakerId('9'), 9)
    assert.equal(resolveVitsSpeakerId('non-existent-voice'), 0)

    assert.equal(clampVitsRate(undefined), 1.0)
    assert.equal(clampVitsRate(Number.NaN), 1.0)
    assert.equal(clampVitsRate(0.1), 0.5)
    assert.equal(clampVitsRate(4.0), 2.0)
    assert.equal(clampVitsRate(1.35), 1.35)

    const harness = createVmWorkerHarness()
    const client = harness.createClient()
    const engine = new VitsWasmTtsEngine({
      workerClient: client,
      voice: 'gunian',
      rate: 0.2,
    })

    assert.equal(engine.kind, 'vits-wasm')
    assert.equal(engine.mime, 'audio/wav')
    assert.equal(engine.status().ready, false)

    await engine.prepare()
    assert.equal(engine.status().ready, true)

    const out = await engine.synthesize('<whisper>你好</whisper><laugh>Obsidian<break 300 ms>世界')
    assert.ok(out.audio instanceof Uint8Array)
    assert.equal(out.mime, 'audio/wav')
    assert.equal(out.sampleRate, 22050)
    assert.equal(out.audio.byteLength, 44 + 4 * 2)
    assert.deepEqual(harness.stats.ttsCalls[0], {
      text: '你好 Obsidian 世界',
      sid: 1,
      speed: 0.5,
    })

    engine.updateVoice('bazong', 2.8)
    await engine.synthesize('第二句', { voice: 'fushiyu', rate: 1.25 })
    assert.deepEqual(harness.stats.ttsCalls[1], {
      text: '第二句',
      sid: 2,
      speed: 1.25,
    })

    await engine.synthesize('默认霸总倍速上限')
    assert.deepEqual(harness.stats.ttsCalls[2], {
      text: '默认霸总倍速上限',
      sid: 4,
      speed: 2.0,
    })

    // Tag-only text skips worker synthesis cleanly
    const emptyOut = await engine.synthesize('<laugh> <sigh>')
    assert.equal(emptyOut.audio.byteLength, 0)
    assert.equal(harness.stats.ttsCalls.length, 3)

    // Pre-aborted signal rejects immediately with AbortError
    const abortedController = new AbortController()
    abortedController.abort('cancelled by user')
    await assert.rejects(
      () => engine.synthesize('不会合成', { signal: abortedController.signal }),
      (err) => err instanceof Error && err.name === 'AbortError',
    )

    await engine.close()
    // Shared workerClient remains usable unless disposeWorkerOnClose: true
    assert.equal(client.isLoaded('tts-vits'), true)
    await client.dispose()
  })
})

describe('M2 resolveBargeInPolicy & AecBargeInMonitor: system-TTS lock, auto-downgrade, <600ms barge-in, and zero leaked tracks', () => {
  it('locks manual policy whenever usesSystemTts is true (even if requestedMode is auto) and honors manual/auto/detect modes', () => {
    assert.deepEqual(
      resolveBargeInPolicy({
        requestedMode: 'detect',
        usesSystemTts: true,
        nativeAecActive: true,
      }),
      { policy: 'manual', reason: 'system-tts-bypasses-aec', allowHandsFreeBargeIn: false },
    )

    assert.deepEqual(
      resolveBargeInPolicy({
        requestedMode: 'auto',
        usesSystemTts: true,
        nativeAecActive: true,
      }),
      { policy: 'manual', reason: 'system-tts-bypasses-aec', allowHandsFreeBargeIn: false },
    )

    assert.deepEqual(
      resolveBargeInPolicy({
        requestedMode: 'manual',
        usesSystemTts: false,
        nativeAecActive: true,
      }),
      { policy: 'manual', reason: 'user-selected-manual', allowHandsFreeBargeIn: false },
    )

    assert.deepEqual(
      resolveBargeInPolicy({
        requestedMode: 'auto',
        usesSystemTts: false,
        isEdge: true,
        nativeAecActive: false,
      }),
      { policy: 'auto', reason: 'ok', allowHandsFreeBargeIn: true },
    )

    assert.deepEqual(
      resolveBargeInPolicy({
        requestedMode: 'auto',
        usesSystemTts: false,
        isMobile: true,
        nativeAecActive: true,
      }),
      { policy: 'manual', reason: 'mobile-aec-unreliable', allowHandsFreeBargeIn: false },
    )
  })

  it('auto-downgrades and immediately closes mic stream when AEC is inactive in detect mode (zero mic light / zero self-interrupt)', async () => {
    const harness = createVmWorkerHarness()
    const client = harness.createClient()

    let openMicStreams = 0
    let captureAttempts = 0
    let capturedOptions = null
    let strayPushChunk = null
    const downgrades = []
    let bargeInCount = 0

    const monitor = new AecBargeInMonitor({
      workerClient: client,
      bargeInMode: 'detect',
      captureAudio: async (opts) => {
        captureAttempts++
        capturedOptions = opts
        openMicStreams++
        strayPushChunk = opts.onChunk
        return {
          track: {
            getSettings: () => ({ echoCancellation: false, sampleRate: 48000, channelCount: 1 }),
          },
          supportedConstraints: { echoCancellation: true },
          stop: async () => {
            openMicStreams--
          },
        }
      },
      onDowngrade: (decision, probe) => downgrades.push({ decision, probe }),
      onBargeIn: () => {
        bargeInCount++
      },
    })

    // 1. Pre-capture gate on usesSystemTts: true -> zero mic open attempts!
    const sysRes = await monitor.start({ usesSystemTts: true, bargeInMode: 'auto' })
    assert.equal(sysRes.activePolicy, 'manual')
    assert.equal(sysRes.reason, 'system-tts-bypasses-aec')
    assert.equal(captureAttempts, 0)
    assert.equal(openMicStreams, 0)
    assert.equal(downgrades.length, 1)
    assert.equal(downgrades[0].decision.reason, 'system-tts-bypasses-aec')

    // 2. Post-capture probe in 'detect' mode when track reports echoCancellation: false ->
    //    mic is closed BEFORE start() returns!
    const detectRes = await monitor.start({ usesSystemTts: false, bargeInMode: 'detect' })
    assert.equal(captureAttempts, 1)
    assert.equal(capturedOptions.echoCancellation, true)
    assert.equal(capturedOptions.noiseSuppression, true)
    assert.equal(capturedOptions.autoGainControl, false)
    assert.equal(detectRes.activePolicy, 'manual')
    assert.equal(detectRes.reason, 'native-aec-inactive')
    assert.equal(openMicStreams, 0)
    assert.equal(monitor.state, 'idle')
    assert.equal(downgrades.length, 2)
    assert.equal(downgrades[1].decision.reason, 'native-aec-inactive')
    assert.equal(downgrades[1].probe?.appliedEchoCancellation, false)

    // Pushing audio chunks after downgrade must be completely ignored
    strayPushChunk?.(new Float32Array(1024).fill(0.25))
    strayPushChunk?.(new Float32Array(1024).fill(0.25))
    await flushMicrotasks()
    assert.equal(bargeInCount, 0)

    await client.dispose()
  })

  it('rejects transient clicks & sub-threshold echo, triggers onBargeIn in <600ms on confirmed speech, and leaves zero leaked mic tracks', async () => {
    const harness = createVmWorkerHarness()
    const client = harness.createClient()

    let openMicStreams = 0
    let pushChunk = null
    const bargeEvents = []
    let micOpenAtBargeCallback = -1

    const monitor = new AecBargeInMonitor({
      workerClient: client,
      bargeInMode: 'detect',
      minRmsThreshold: DEFAULT_BARGE_IN_MIN_RMS,
      confirmChunks: DEFAULT_BARGE_IN_CONFIRM_CHUNKS,
      captureAudio: async (opts) => {
        openMicStreams++
        pushChunk = opts.onChunk
        return {
          track: {
            getSettings: () => ({ echoCancellation: true, sampleRate: 48000, channelCount: 1 }),
          },
          supportedConstraints: { echoCancellation: true },
          stop: async () => {
            openMicStreams--
            pushChunk = null
          },
        }
      },
      onBargeIn: (ev) => {
        micOpenAtBargeCallback = openMicStreams
        bargeEvents.push(ev)
      },
    })

    const startRes = await monitor.start()
    assert.equal(startRes.activePolicy, 'auto')
    assert.equal(startRes.reason, 'ok')
    assert.equal(monitor.state, 'monitoring')
    assert.equal(openMicStreams, 1)

    // 1. Sub-threshold residual echo (0.004 RMS < 0.0045 minRmsThreshold, even though VAD sees >=0.002) -> ignored!
    pushChunk(new Float32Array(1024).fill(0.004))
    pushChunk(new Float32Array(1024).fill(0.004))
    pushChunk(new Float32Array(1024).fill(0.004))
    await flushMicrotasks(6)
    assert.equal(bargeEvents.length, 0)
    assert.equal(openMicStreams, 1)

    // 2. Single 64ms transient click followed by silence -> resets confirmation counter, zero false trigger!
    pushChunk(new Float32Array(1024).fill(0.15))
    pushChunk(new Float32Array(1024).fill(0))
    await flushMicrotasks(6)
    assert.equal(bargeEvents.length, 0)
    assert.equal(openMicStreams, 1)

    // 3. Real human speech: 2 consecutive 64ms chunks (128ms) >= 0.0045 RMS -> triggers <600ms & closes mic!
    const bargeDone = deferred()
    const origTriggerLen = bargeEvents.length
    const speechT0 = performance.now()
    pushChunk(new Float32Array(1024).fill(0.12))
    pushChunk(new Float32Array(1024).fill(0.14))

    while (bargeEvents.length === origTriggerLen) {
      await flushMicrotasks(2)
      if (performance.now() - speechT0 > 1000) break
    }
    bargeDone.resolve()
    await bargeDone.promise

    const wallLatencyMs = performance.now() - speechT0
    assert.equal(bargeEvents.length, 1)
    assert.ok(wallLatencyMs < 600, `Expected barge-in < 600 ms, got ${wallLatencyMs.toFixed(2)} ms`)
    assert.ok(bargeEvents[0].elapsedMs < 600)
    assert.equal(bargeEvents[0].confirmedChunks, 2)
    assert.equal(micOpenAtBargeCallback, 0, 'Mic stream must already be closed when onBargeIn fires')
    assert.equal(openMicStreams, 0)
    assert.equal(monitor.state, 'idle')

    // Verify createBargeInMicCapture passes autoGainControl: false to getUserMedia and stops all tracks cleanly
    const prevNavigator = globalThis.navigator
    const prevAudioContext = globalThis.AudioContext
    const prevAudioWorkletNode = globalThis.AudioWorkletNode
    let getUserMediaArg = null
    let hardwareTrackStopped = false

    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          mediaDevices: {
            getSupportedConstraints: () => ({ echoCancellation: true }),
            getUserMedia: async (constraints) => {
              getUserMediaArg = constraints
              const track = {
                getSettings: () => ({ echoCancellation: true, sampleRate: 48000, channelCount: 1 }),
                stop: () => {
                  hardwareTrackStopped = true
                },
              }
              return {
                getAudioTracks: () => [track],
                getTracks: () => [track],
              }
            },
          },
        },
      })
      globalThis.AudioContext = class {
        state = 'running'
        destination = {}
        audioWorklet = { addModule: async () => {} }
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} }
        }
        createGain() {
          return { gain: { value: 1 }, connect() {}, disconnect() {} }
        }
        async resume() {}
        async close() {
          this.state = 'closed'
        }
      }
      globalThis.AudioWorkletNode = class {
        port = { onmessage: null, postMessage() {} }
        onprocessorerror = null
        connect() {}
        disconnect() {}
      }

      const capHandle = await createBargeInMicCapture({
        workletUrl: 'blob:mock-worklet',
        onChunk: () => {},
      })
      assert.deepEqual(getUserMediaArg, {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      })
      assert.equal(capHandle.supportedConstraints?.echoCancellation, true)
      assert.equal(capHandle.track?.getSettings?.().echoCancellation, true)
      await capHandle.stop()
      assert.equal(hardwareTrackStopped, true)
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: prevNavigator,
      })
      globalThis.AudioContext = prevAudioContext
      globalThis.AudioWorkletNode = prevAudioWorkletNode
    }

    await client.dispose()
  })

  it('isolates stale epoch cleanup on rapid start() -> stop() -> start() without clobbering newer mic session', async () => {
    const harness = createVmWorkerHarness()
    const client = harness.createClient()

    const firstCaptureGate = deferred()
    let openMicStreams = 0
    let stoppedFirst = false
    let stoppedSecond = false
    let callIndex = 0
    let secondPushChunk = null
    let bargeCount = 0

    const monitor = new AecBargeInMonitor({
      workerClient: client,
      bargeInMode: 'detect',
      captureAudio: async (opts) => {
        const idx = ++callIndex
        openMicStreams++
        if (idx === 1) {
          await firstCaptureGate.promise
          return {
            track: { getSettings: () => ({ echoCancellation: true, sampleRate: 48000, channelCount: 1 }) },
            supportedConstraints: { echoCancellation: true },
            stop: async () => {
              if (!stoppedFirst) {
                stoppedFirst = true
                openMicStreams--
              }
            },
          }
        }
        secondPushChunk = opts.onChunk
        return {
          track: { getSettings: () => ({ echoCancellation: true, sampleRate: 48000, channelCount: 1 }) },
          supportedConstraints: { echoCancellation: true },
          stop: async () => {
            if (!stoppedSecond) {
              stoppedSecond = true
              openMicStreams--
            }
          },
        }
      },
      onBargeIn: () => {
        bargeCount++
      },
    })

    // Start Call 1 (hangs in captureAudio), then immediately stop() and start Call 2
    const p1 = monitor.start()
    await monitor.stop()
    const p2 = monitor.start()
    const res2 = await p2
    assert.equal(res2.activePolicy, 'auto')
    assert.equal(monitor.state, 'monitoring')

    // Now release Call 1's delayed captureAudio: must close ONLY handle 1 and leave Call 2 monitoring!
    firstCaptureGate.resolve()
    const res1 = await p1
    assert.equal(res1.activePolicy, 'manual')
    assert.equal(stoppedFirst, true)
    assert.equal(stoppedSecond, false)
    assert.equal(openMicStreams, 1)
    assert.equal(monitor.state, 'monitoring')
    assert.equal(monitor.activePolicy, 'auto')

    // Call 2 remains fully responsive to barge-in speech
    secondPushChunk(new Float32Array(1024).fill(0.15))
    secondPushChunk(new Float32Array(1024).fill(0.15))
    await flushMicrotasks(8)
    assert.equal(bargeCount, 1)
    assert.equal(stoppedSecond, true)
    assert.equal(openMicStreams, 0)
    assert.equal(monitor.state, 'idle')

    await client.dispose()
  })
})
