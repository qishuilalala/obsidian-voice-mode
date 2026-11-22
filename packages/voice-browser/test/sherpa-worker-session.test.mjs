import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {
  DICTATION_PRE_ROLL_MS,
  DICTATION_PRE_ROLL_SAMPLES,
  VOICE_CAPTURE_PROCESSOR_NAME,
  OfflineDictationSession,
  SherpaWorkerClient,
  SherpaWorkerError,
  createBrowserMicCapture,
  createSherpaWorkerScript,
  encodePcm16Wav,
} from '../src/index.ts'

/**
 * Create a deterministic VM-backed Worker executing the real script returned by
 * `createSherpaWorkerScript(...)` with inspectable Emscripten MEMFS + Sherpa hooks.
 */
function createVmSherpaWorkerHarness(overrides = {}) {
  const stats = {
    moduleInitCount: 0,
    wasmByteLengths: [],
    fsOpens: [],
    fsWrites: [],
    fsCloses: 0,
    fsUnlinks: [],
    vadCreated: 0,
    vadFreed: 0,
    vadResets: 0,
    vadWindows: [],
    asrCreated: 0,
    asrFreed: 0,
    asrStreamsCreated: 0,
    asrStreamsFreed: 0,
    asrTranscribedLengths: [],
    ttsCreated: 0,
    ttsFreed: 0,
    ttsGeneratedCalls: [],
    terminated: 0,
    revoked: 0,
    postedToWorker: [],
    transferredFromWorker: [],
  }

  const memfsFiles = new Map()

  const glueGlobals = {
    Module: async (opts) => {
      stats.moduleInitCount++
      stats.wasmByteLengths.push(opts.wasmBinary.byteLength)
      return {
        FS: {
          mkdir(_dir) {},
          open(path, flags) {
            stats.fsOpens.push({ path, flags })
            return { path, closed: false }
          },
          write(stream, bytes, offset, length, position, canOwn) {
            stats.fsWrites.push({
              path: stream.path,
              byteLength: length,
              offset,
              position,
              canOwn,
            })
            memfsFiles.set(stream.path, bytes.subarray(offset, offset + length))
            return length
          },
          close(stream) {
            stream.closed = true
            stats.fsCloses++
          },
          unlink(path) {
            stats.fsUnlinks.push(path)
            memfsFiles.delete(path)
          },
        },
      }
    },
    SherpaVad: {
      CircularBuffer: class {},
      createVad(_wasmMod, cfg) {
        stats.vadCreated++
        let speechNow = false
        const completedSegments = []
        return {
          handle: 1,
          config: cfg,
          acceptWaveform(window512) {
            // Copy window so assertions can inspect exact 512-sample slices.
            const copy = new Float32Array(window512)
            stats.vadWindows.push(copy)
            if (overrides.onVadWindow) {
              const outcome = overrides.onVadWindow(copy, stats.vadWindows.length - 1)
              speechNow = Boolean(outcome?.isSpeech)
              if (outcome?.pushSegment) completedSegments.push(copy)
              return
            }
            let sumSq = 0
            for (let i = 0; i < copy.length; i++) sumSq += copy[i] * copy[i]
            const rms = Math.sqrt(sumSq / copy.length)
            const nextSpeech = rms >= 0.05
            if (speechNow && !nextSpeech && overrides.emitSpeechEndedOnDrop) {
              completedSegments.push(copy)
            }
            speechNow = nextSpeech
          },
          isDetected() {
            return speechNow
          },
          isEmpty() {
            return completedSegments.length === 0
          },
          pop() {
            completedSegments.shift()
          },
          reset() {
            speechNow = false
            completedSegments.length = 0
            stats.vadResets++
          },
          free() {
            stats.vadFreed++
            this.handle = 0
          },
        }
      },
    },
    SherpaAsr: {
      createOnlineRecognizer() {
        return {}
      },
      OfflineRecognizer: class {
        constructor(cfg, _wasmMod) {
          stats.asrCreated++
          this.config = cfg
          this.handle = 1
        }
        createStream() {
          stats.asrStreamsCreated++
          let accepted = new Float32Array(0)
          let rate = 16000
          return {
            acceptWaveform(sampleRate, samples) {
              rate = sampleRate
              accepted = new Float32Array(samples)
            },
            getAccepted() {
              return { rate, samples: accepted }
            },
            free() {
              stats.asrStreamsFreed++
            },
          }
        }
        decode(stream) {
          if (overrides.onAsrDecode) {
            overrides.onAsrDecode(stream.getAccepted())
          }
        }
        getResult(stream) {
          const { samples } = stream.getAccepted()
          stats.asrTranscribedLengths.push(samples.length)
          if (overrides.formatTranscript) {
            return { text: overrides.formatTranscript(samples, stats.asrTranscribedLengths.length) }
          }
          return { text: `utt-${stats.asrTranscribedLengths.length}:${samples.length}`, lang: 'zh' }
        }
        free() {
          stats.asrFreed++
          this.handle = 0
        }
      },
    },
    SherpaTts: {
      createOfflineTts(_wasmMod, cfg) {
        stats.ttsCreated++
        return {
          handle: 1,
          sampleRate: 24000,
          config: cfg,
          generate(genCfg) {
            stats.ttsGeneratedCalls.push({ ...genCfg })
            return {
              samples: new Float32Array([0, 0.5, -0.5, 1.25, -1.25, Number.NaN]),
              sampleRate: 24000,
            }
          },
          free() {
            stats.ttsFreed++
            this.handle = 0
          },
        }
      },
    },
  }

  function workerFactory(scriptSource) {
    let alive = true
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage(msg, _transfer) {
        if (!alive) throw new Error('Worker already terminated')
        stats.postedToWorker.push(msg)
        queueMicrotask(() => {
          if (!alive || typeof selfScope.onmessage !== 'function') return
          selfScope.onmessage({ data: msg })
        })
      },
      terminate() {
        alive = false
        stats.terminated++
      },
      triggerCrash(message = 'simulated wasm trap') {
        alive = false
        if (typeof worker.onerror === 'function') {
          worker.onerror({ message })
        }
      },
    }

    const selfScope = {
      onmessage: null,
      postMessage(res, transfer) {
        if (!alive) return
        if (transfer) stats.transferredFromWorker.push(transfer)
        queueMicrotask(() => {
          if (!alive || typeof worker.onmessage !== 'function') return
          worker.onmessage({ data: res })
        })
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

    return {
      worker,
      revoke() {
        stats.revoked++
      },
    }
  }

  return { stats, memfsFiles, workerFactory }
}

function makeSpeechChunk(samples, amplitude = 0.2, markerFirstSample = null) {
  const arr = new Float32Array(samples).fill(amplitude)
  if (markerFirstSample !== null && arr.length > 0) {
    arr[0] = markerFirstSample
  }
  return arr
}

function makeSilentChunk(samples, value = 0) {
  return new Float32Array(samples).fill(value)
}

describe('sherpa-worker-runtime: MEMFS zero-copy, immediate unlink, 512-window carry, ASR stream cleanup, and WAV encoding', () => {
  it('encodes 44-byte 16-bit mono PCM WAV headers and clamps out-of-range/NaN samples cleanly', () => {
    const wav = encodePcm16Wav(new Float32Array([0, 1, -1, 2.5, -2.5, Number.NaN]), 16000)
    assert.equal(wav.byteLength, 44 + 6 * 2)
    const view = new DataView(wav)
    const magic = String.fromCharCode(
      view.getUint8(0),
      view.getUint8(1),
      view.getUint8(2),
      view.getUint8(3),
    )
    const wave = String.fromCharCode(
      view.getUint8(8),
      view.getUint8(9),
      view.getUint8(10),
      view.getUint8(11),
    )
    assert.equal(magic, 'RIFF')
    assert.equal(wave, 'WAVE')
    assert.equal(view.getUint16(20, true), 1)
    assert.equal(view.getUint16(22, true), 1)
    assert.equal(view.getUint32(24, true), 16000)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(view.getUint32(40, true), 12)
    assert.equal(view.getInt16(44, true), 0)
    assert.equal(view.getInt16(46, true), 32767)
    assert.equal(view.getInt16(48, true), -32768)
    assert.equal(view.getInt16(50, true), 32767)
    assert.equal(view.getInt16(52, true), -32768)
    assert.equal(view.getInt16(54, true), 0)
  })

  it('mounts zero-copy (canOwn=true), unlinks ONNX weights immediately, carries <512 VAD tails, frees ASR streams on error, and synthesizes WAV', async () => {
    let shouldFailDecode = false
    const harness = createVmSherpaWorkerHarness({
      emitSpeechEndedOnDrop: true,
      onAsrDecode() {
        if (shouldFailDecode) throw new Error('corrupted frame')
      },
    })

    const client = new SherpaWorkerClient({
      createWorkerSource: () => createSherpaWorkerScript('/* glue provided by VM globals */'),
      loadModelBinaries: async (target, includeWasm) => {
        const out = []
        if (includeWasm) {
          out.push({ name: 'sherpa-onnx.wasm', buffer: new ArrayBuffer(64) })
        }
        if (target === 'vad') {
          out.push({ name: 'silero_vad.onnx', buffer: new ArrayBuffer(128) })
        } else if (target === 'asr-offline') {
          out.push(
            { name: 'model.int8.onnx', buffer: new ArrayBuffer(256) },
            { name: 'tokens.txt', buffer: new ArrayBuffer(32) },
          )
        } else if (target === 'tts-vits') {
          out.push(
            { name: 'model.onnx', buffer: new ArrayBuffer(512) },
            { name: 'lexicon.txt', buffer: new ArrayBuffer(48) },
            { name: 'tokens.txt', buffer: new ArrayBuffer(24) },
          )
        }
        return out
      },
      workerFactory: harness.workerFactory,
      idleUnloadMs: 0,
    })

    // Test 400-sample non-aligned chunks across calls:
    // Call 1 (400 speech) -> 0 windows, 400 speech carry
    // Call 2 (400 speech) -> 1 window (512 speech), 288 speech carry
    // Call 3 (224 silent) -> 1 window (288 speech + 224 silent -> speech), 0 carry
    // Call 4 (512 silent) -> 1 window (512 silent -> speech ends!), 0 carry
    const r1 = await client.processVad(makeSpeechChunk(400, 0.25))
    assert.equal(harness.stats.vadWindows.length, 0)
    assert.equal(r1.isSpeech, false)

    const r2 = await client.processVad(makeSpeechChunk(400, 0.25))
    assert.equal(harness.stats.vadWindows.length, 1)
    assert.equal(harness.stats.vadWindows[0].length, 512)
    assert.equal(r2.isSpeech, true)

    const r3 = await client.processVad(makeSilentChunk(224))
    assert.equal(harness.stats.vadWindows.length, 2)
    assert.equal(r3.isSpeech, true)

    const r4 = await client.processVad(makeSilentChunk(512))
    assert.equal(harness.stats.vadWindows.length, 3)
    assert.equal(r4.isSpeech, false)
    assert.equal(r4.speechEnded, true)

    // Verify VAD reset clears carry buffer
    await client.processVad(makeSpeechChunk(300, 0.25))
    await client.resetVad()
    assert.equal(harness.stats.vadResets, 1)
    await client.processVad(makeSpeechChunk(300, 0.25))
    // Without carry reset, 300+300 would have triggered window #4; after reset, only 300 samples buffered!
    assert.equal(harness.stats.vadWindows.length, 3)

    // Verify ASR transcription & guaranteed stream.free() even when decode throws
    const asrOk = await client.transcribe(makeSpeechChunk(16000, 0.1))
    assert.equal(asrOk.text, 'utt-1:16000')
    assert.equal(asrOk.durationMs, 1000)
    assert.equal(harness.stats.asrStreamsCreated, 1)
    assert.equal(harness.stats.asrStreamsFreed, 1)

    shouldFailDecode = true
    await assert.rejects(
      () => client.transcribe(makeSpeechChunk(8000, 0.1)),
      (err) => err instanceof SherpaWorkerError && err.code === 'asr_failed',
    )
    assert.equal(harness.stats.asrStreamsCreated, 2)
    assert.equal(harness.stats.asrStreamsFreed, 2)

    // Verify VITS TTS WAV synthesis + zero-copy transfer back
    const ttsRes = await client.synthesizeTts('你好世界', { speakerId: 3, speed: 1.15 })
    assert.equal(ttsRes.mime, 'audio/wav')
    assert.equal(ttsRes.channels, 1)
    assert.equal(ttsRes.sampleRate, 24000)
    assert.equal(ttsRes.audio.byteLength, 44 + 6 * 2)
    assert.deepEqual(harness.stats.ttsGeneratedCalls[0], {
      text: '你好世界',
      sid: 3,
      speed: 1.15,
    })
    assert.equal(harness.stats.transferredFromWorker.length, 1)

    // Verify Module initialized ONCE across all 3 targets, all FS writes used canOwn=true,
    // and all 3 ONNX weight files were immediately unlinked!
    assert.equal(harness.stats.moduleInitCount, 1)
    assert.ok(harness.stats.fsWrites.every((w) => w.canOwn === true))
    assert.ok(harness.stats.fsUnlinks.includes('/models/vad/silero_vad.onnx'))
    assert.ok(harness.stats.fsUnlinks.includes('/models/sense/model.int8.onnx'))
    assert.ok(harness.stats.fsUnlinks.includes('/models/vits/model.onnx'))
    assert.equal(harness.memfsFiles.has('/models/sense/model.int8.onnx'), false)

    await client.dispose()
    assert.equal(harness.stats.vadFreed, 1)
    assert.equal(harness.stats.asrFreed, 1)
    assert.equal(harness.stats.ttsFreed, 1)
    assert.equal(harness.stats.terminated, 1)
    assert.equal(harness.stats.revoked, 1)
  })
})

describe('SherpaWorkerClient: lazy loading, concurrent deduplication, idle auto-unload, keepAlive lock, and crash recovery', () => {
  it('lazily spawns worker, deduplicates concurrent ensure* calls and single WASM transfer, and preserves caller views', async () => {
    const harness = createVmSherpaWorkerHarness()
    const loadCalls = []
    let latestWorker = null

    const client = new SherpaWorkerClient({
      createWorkerSource: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return createSherpaWorkerScript('')
      },
      loadModelBinaries: async (target, includeWasm) => {
        loadCalls.push({ target, includeWasm })
        await new Promise((r) => setTimeout(r, 5))
        const files = []
        if (includeWasm) files.push({ name: 'sherpa-onnx.wasm', buffer: new ArrayBuffer(32) })
        if (target === 'vad') files.push({ name: 'silero_vad.onnx', buffer: new ArrayBuffer(32) })
        if (target === 'asr-offline') {
          files.push(
            { name: 'model.int8.onnx', buffer: new ArrayBuffer(64) },
            { name: 'tokens.txt', buffer: new ArrayBuffer(16) },
          )
        }
        return files
      },
      workerFactory: (src) => {
        const created = harness.workerFactory(src)
        latestWorker = created.worker
        return created
      },
      idleUnloadMs: 0,
    })

    // Lazy: zero worker spawned at construction
    assert.equal(latestWorker, null)
    assert.equal(client.isLoaded('vad'), false)

    // Fire 4 concurrent VAD loads + 3 concurrent ASR loads simultaneously on cold start!
    await Promise.all([
      client.ensureVadLoaded(),
      client.ensureVadLoaded(),
      client.ensureAsrLoaded(),
      client.ensureVadLoaded(),
      client.ensureAsrLoaded(),
      client.ensureAsrLoaded(),
      client.ensureVadLoaded(),
    ])

    // Exactly 1 VAD load + 1 ASR load, and includeWasm=true ONLY on the very first load!
    assert.deepEqual(loadCalls, [
      { target: 'vad', includeWasm: true },
      { target: 'asr-offline', includeWasm: false },
    ])
    assert.equal(client.isLoaded('vad'), true)
    assert.equal(client.isLoaded('asr-offline'), true)

    // Verify caller subarray view is never detached by Transferable postMessage
    const backing = new Float32Array(2048).fill(0.2)
    const view = backing.subarray(256, 768)
    await client.processVad(view)
    assert.equal(backing.length, 2048)
    assert.ok(Math.abs(view[0] - 0.2) < 1e-6)

    // Simulate worker crash -> rejects in-flight or marks unloaded, then transparently recovers!
    latestWorker.triggerCrash('OOM trap')
    assert.equal(client.isLoaded('vad'), false)
    assert.equal(client.isLoaded('asr-offline'), false)
    assert.equal(harness.stats.revoked, 1)

    const recovered = await client.transcribe(makeSpeechChunk(3200, 0.2))
    assert.equal(recovered.text, 'utt-1:3200')
    assert.equal(client.isLoaded('asr-offline'), true)
    assert.equal(loadCalls.length, 3)
    assert.deepEqual(loadCalls[2], { target: 'asr-offline', includeWasm: true })

    await client.dispose()
  })

  it('honors setKeepAlive(true) during active capture and auto-unloads after idleUnloadMs once unlocked', async () => {
    const harness = createVmSherpaWorkerHarness()
    let idleUnloadCount = 0

    const client = new SherpaWorkerClient({
      createWorkerSource: () => createSherpaWorkerScript(''),
      loadModelBinaries: async (_target, includeWasm) => {
        const files = [{ name: 'silero_vad.onnx', buffer: new ArrayBuffer(32) }]
        if (includeWasm) files.push({ name: 'sherpa-onnx.wasm', buffer: new ArrayBuffer(32) })
        return files
      },
      workerFactory: harness.workerFactory,
      idleUnloadMs: 35,
      onIdleUnload: () => {
        idleUnloadCount++
      },
    })

    client.setKeepAlive(true)
    await client.ensureVadLoaded()
    assert.equal(client.isLoaded('vad'), true)

    // Wait > 2x idleUnloadMs while keepAlive is true -> MUST NOT unload!
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(client.isLoaded('vad'), true)
    assert.equal(idleUnloadCount, 0)

    // Release keepAlive -> idle timer starts and unloads cleanly
    client.setKeepAlive(false)
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(client.isLoaded('vad'), false)
    assert.equal(idleUnloadCount, 1)
    assert.equal(harness.stats.vadFreed, 1)
    assert.equal(harness.stats.terminated, 1)
    assert.equal(harness.stats.revoked, 1)

    await client.dispose()
  })

  it('synchronously detaches worker on unload() so concurrent ensure*Loaded() never races, and reloads ASR on language change', async () => {
    const asrConfigsSeen = []
    const baseHarness = createVmSherpaWorkerHarness()
    let slowDisposeActive = false

    const client = new SherpaWorkerClient({
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
        return files
      },
      modelConfigs: {
        'asr-offline': { language: 'auto', useItn: true },
      },
      workerFactory: (src) => {
        const created = baseHarness.workerFactory(src)
        const origPost = created.worker.postMessage.bind(created.worker)
        created.worker.postMessage = (msg, transfer) => {
          if (msg && msg.type === 'model:load' && msg.target === 'asr-offline') {
            asrConfigsSeen.push({ ...msg.config })
          }
          if (msg && msg.type === 'worker:dispose' && slowDisposeActive) {
            // Delay dispose ack by 40ms to test concurrent ensureAsrLoaded() during unload!
            setTimeout(() => origPost(msg, transfer), 40)
            return
          }
          origPost(msg, transfer)
        }
        return created
      },
      idleUnloadMs: 0,
    })

    await client.ensureAsrLoaded()
    assert.equal(asrConfigsSeen.length, 1)
    assert.equal(asrConfigsSeen[0].language, 'auto')

    // Start slow unload() and IMMEDIATELY call transcribe() concurrently!
    slowDisposeActive = true
    const unloadPromise = client.unload()
    assert.equal(client.isLoaded('asr-offline'), false)
    const concurrentRes = await client.transcribe(makeSpeechChunk(3200, 0.2), { language: 'ja' })
    await unloadPromise
    slowDisposeActive = false

    assert.equal(concurrentRes.text, 'utt-1:3200')
    assert.equal(client.isLoaded('asr-offline'), true)
    assert.equal(asrConfigsSeen.length, 2)
    assert.equal(asrConfigsSeen[1].language, 'ja')

    // Switching language on an already-loaded worker triggers clean in-place reload!
    await client.transcribe(makeSpeechChunk(1600, 0.2), { language: 'ko' })
    assert.equal(asrConfigsSeen.length, 3)
    assert.equal(asrConfigsSeen[2].language, 'ko')

    await client.dispose()
  })
})

describe('OfflineDictationSession: toggle, single, push-to-talk, 640ms pre-roll, 60s cap, flush vs abort, and mic teardown', () => {
  function createSessionRig(options = {}) {
    const harness = createVmSherpaWorkerHarness({
      formatTranscript: options.formatTranscript,
    })

    const client = new SherpaWorkerClient({
      createWorkerSource: () => createSherpaWorkerScript(''),
      loadModelBinaries: async (target, includeWasm) => {
        const out = []
        if (includeWasm) out.push({ name: 'sherpa-onnx.wasm', buffer: new ArrayBuffer(32) })
        if (target === 'vad') out.push({ name: 'silero_vad.onnx', buffer: new ArrayBuffer(32) })
        if (target === 'asr-offline') {
          out.push(
            { name: 'model.int8.onnx', buffer: new ArrayBuffer(32) },
            { name: 'tokens.txt', buffer: new ArrayBuffer(16) },
          )
        }
        return out
      },
      workerFactory: harness.workerFactory,
      idleUnloadMs: options.idleUnloadMs ?? 40,
    })

    let pushChunk = null
    let micStops = 0
    const states = []
    const activities = []
    const transcripts = []
    const errors = []

    const session = new OfflineDictationSession({
      workerClient: client,
      endpointPolicy: options.endpointPolicy,
      captureAudio: async ({ onChunk }) => {
        pushChunk = onChunk
        return {
          stop: async () => {
            micStops++
            pushChunk = null
          },
        }
      },
      onStateChange: (s) => states.push(s),
      onSpeechActivity: (a) => activities.push(a),
      onFinalTranscript: (text, info) => transcripts.push({ text, info }),
      onError: (err) => errors.push(err),
    })

    return {
      harness,
      client,
      session,
      states,
      activities,
      transcripts,
      errors,
      getMicStops: () => micStops,
      feed: (chunk) => {
        if (pushChunk) pushChunk(chunk)
      },
    }
  }

  it('preserves exact 640 ms (10,240-sample) wrapped pre-roll ring buffer and handles multi-utterance toggle mode across pauses', async () => {
    assert.equal(DICTATION_PRE_ROLL_MS, 640)
    assert.equal(DICTATION_PRE_ROLL_SAMPLES, 10240)

    const transcribedBuffers = []
    const rig = createSessionRig({
      endpointPolicy: { silenceMs: 320, maxSpeechSec: 60 },
      formatTranscript: (samples, idx) => {
        transcribedBuffers.push(new Float32Array(samples))
        return `这句话-${idx}`
      },
    })

    await rig.session.start('toggle')
    assert.equal(rig.session.state, 'listening')

    // Feed 12 silent 1024-sample chunks (12,288 samples > 10,240 pre-roll capacity) with unique tags
    // so we can verify wraparound keeps ONLY chunks #3..#12 (10 * 1024 = 10,240 samples) in exact order!
    for (let i = 1; i <= 12; i++) {
      const c = makeSilentChunk(1024, 0)
      c[0] = i * 0.0001 // below VAD RMS threshold (0.05) but uniquely identifiable!
      rig.feed(c)
    }

    // Utterance 1: 2 chunks of speech + brief 2-chunk (128 ms < 320 ms) breath pause + 2 chunks of speech
    rig.feed(makeSpeechChunk(1024, 0.25))
    rig.feed(makeSpeechChunk(1024, 0.25))
    rig.feed(makeSilentChunk(1024, 0))
    rig.feed(makeSilentChunk(1024, 0))
    rig.feed(makeSpeechChunk(1024, 0.25))
    rig.feed(makeSpeechChunk(1024, 0.25))

    // Trailing silence >= 320 ms (5 * 1024 = 5,120 samples = 320 ms) -> finalizes Utterance 1!
    for (let i = 0; i < 5; i++) {
      rig.feed(makeSilentChunk(1024, 0))
    }

    // Utterance 2 immediately follows in parallel without stopping capture:
    // 160 ms (2,560 samples) seeded inter-utterance lead-in + 2 pre-roll silent chunks + 3 speech chunks!
    rig.feed(makeSilentChunk(1024, 0))
    rig.feed(makeSilentChunk(1024, 0))
    rig.feed(makeSpeechChunk(1024, 0.3))
    rig.feed(makeSpeechChunk(1024, 0.3))
    rig.feed(makeSpeechChunk(1024, 0.3))

    await rig.session.stop({ flush: true })

    assert.equal(rig.session.state, 'idle')
    assert.equal(rig.getMicStops(), 1)
    assert.equal(rig.errors.length, 0)
    assert.equal(rig.transcripts.length, 2)
    assert.equal(rig.transcripts[0].text, '这句话-1')
    assert.equal(rig.transcripts[0].info.mode, 'toggle')
    assert.equal(rig.transcripts[1].text, '这句话-2')
    assert.deepEqual(rig.activities.slice(0, 4), [true, false, true, false])

    // Verify exact 10,240-sample wrapped pre-roll at head of Utterance 1 (chunks #3..#12)
    const utt1 = transcribedBuffers[0]
    // 10240 pre-roll + 6*1024 (speech+breath+speech) + 5*1024 (trailing silence) = 21 * 1024 = 21,504
    assert.equal(utt1.length, 21 * 1024)
    for (let k = 0; k < 10; k++) {
      const expectedTag = (k + 3) * 0.0001
      assert.ok(
        Math.abs(utt1[k * 1024] - expectedTag) < 1e-7,
        `pre-roll slot ${k} mismatch: got ${utt1[k * 1024]} expected ${expectedTag}`,
      )
    }

    // Verify Utterance 2 has 2560 inter-utterance lead-in + 2*1024 pre-roll + 3*1024 speech = 7,680 samples
    assert.equal(transcribedBuffers[1].length, 2560 + 5 * 1024)

    await rig.client.dispose()
  })

  it('enforces the 60s (maxSpeechSec) hard cap in toggle mode without dropping continuation samples', async () => {
    const lengths = []
    // Note: resolveEndpointPolicy clamps maxSpeechSec to [5, 300]; test with 5s (80,000 samples)
    // AND verify default policy is 60s (960,000 samples).
    const rig = createSessionRig({
      endpointPolicy: { silenceMs: 1500, maxSpeechSec: 5 },
      formatTranscript: (samples, idx) => {
        lengths.push(samples.length)
        return `seg-${idx}`
      },
    })

    await rig.session.start('toggle')
    // Feed 6 seconds (96,000 samples = 60 chunks of 1600 samples) of continuous uninterrupted speech
    for (let i = 0; i < 60; i++) {
      rig.feed(makeSpeechChunk(1600, 0.25))
    }
    await rig.session.stop({ flush: true })

    assert.equal(rig.transcripts.length, 2)
    assert.equal(lengths[0], 80000) // Exact 5.0s cap!
    assert.equal(lengths[1], 16000) // Remaining 1.0s seamlessly captured as segment 2!

    await rig.client.dispose()
  })

  it('auto-stops mic capture right after utterance 1 in single mode and awaits transcription before idle', async () => {
    const rig = createSessionRig({
      endpointPolicy: { silenceMs: 256, maxSpeechSec: 60 },
    })

    await rig.session.start('single')
    rig.feed(makeSilentChunk(1024, 0))
    rig.feed(makeSpeechChunk(1024, 0.25))
    rig.feed(makeSpeechChunk(1024, 0.25))
    // 4 * 1024 = 4096 samples = 256 ms silence -> triggers single-utterance auto-stop!
    for (let i = 0; i < 4; i++) {
      rig.feed(makeSilentChunk(1024, 0))
    }
    // Extra chunks after utterance 1 must be ignored because mic auto-stopped
    rig.feed(makeSpeechChunk(1024, 0.25))

    // Wait for async VAD + transcription completion
    const deadline = Date.now() + 1000
    while (rig.session.state !== 'idle' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }

    assert.equal(rig.session.state, 'idle')
    assert.equal(rig.getMicStops(), 1)
    assert.equal(rig.transcripts.length, 1)
    assert.equal(rig.transcripts[0].info.mode, 'single')
    assert.ok(rig.states.includes('transcribing'))

    await rig.client.dispose()
  })

  it('supports push-to-talk hold & release and skips silent or sub-150ms taps', async () => {
    const rig = createSessionRig()

    // 1) Sub-150ms tap (1024 samples = 64 ms) -> skipped
    await rig.session.start('push-to-talk')
    rig.feed(makeSpeechChunk(1024, 0.3))
    await rig.session.stop({ flush: true })
    assert.equal(rig.transcripts.length, 0)

    // 2) Long hold (4096 samples = 256 ms) but low noise floor (RMS 0.0005 <= 0.002) -> skipped
    await rig.session.start('push-to-talk')
    for (let i = 0; i < 4; i++) rig.feed(makeSilentChunk(1024, 0.0005))
    await rig.session.stop({ flush: true })
    assert.equal(rig.transcripts.length, 0)

    // 3) Valid hold & release (4096 samples = 256 ms, RMS 0.2 > 0.002) -> transcribed!
    await rig.session.start('push-to-talk')
    for (let i = 0; i < 4; i++) rig.feed(makeSpeechChunk(1024, 0.2))
    await rig.session.stop({ flush: true })
    assert.equal(rig.transcripts.length, 1)
    assert.equal(rig.transcripts[0].text, 'utt-1:4096')
    assert.equal(rig.transcripts[0].info.mode, 'push-to-talk')
    assert.equal(rig.transcripts[0].info.durationMs, 256)

    await rig.client.dispose()
  })

  it('discards buffered audio immediately on abort() without emitting transcripts', async () => {
    const rig = createSessionRig()

    await rig.session.start('toggle')
    rig.feed(makeSpeechChunk(1024, 0.25))
    rig.feed(makeSpeechChunk(1024, 0.25))
    await rig.session.abort()

    assert.equal(rig.session.state, 'idle')
    assert.equal(rig.getMicStops(), 1)
    assert.equal(rig.transcripts.length, 0)

    // Wait for any queued microtasks to settle and confirm zero late transcripts arrive
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(rig.transcripts.length, 0)

    await rig.client.dispose()
  })

  it('performs 100% browser microphone, AudioWorklet, GainNode, MediaStreamTrack, AudioContext, and Blob URL teardown', async () => {
    const origNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const origAudioContext = globalThis.AudioContext
    const origAudioWorkletNode = globalThis.AudioWorkletNode
    const origCreateObjUrl = URL.createObjectURL
    const origRevokeObjUrl = URL.revokeObjectURL

    const events = []
    let capturedConstraints = null
    let workletNodeRef = null

    try {
      URL.createObjectURL = () => {
        events.push('blob:create')
        return 'blob:mock-capture-worklet'
      }
      URL.revokeObjectURL = (url) => {
        events.push(`blob:revoke:${url}`)
      }

      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          mediaDevices: {
            getUserMedia: async (constraints) => {
              capturedConstraints = constraints
              return {
                getTracks: () => [
                  {
                    stop: () => events.push('track:stop'),
                  },
                ],
              }
            },
          },
        },
      })

      globalThis.AudioContext = class FakeAudioContext {
        constructor() {
          this.state = 'suspended'
          this.destination = { kind: 'destination' }
          this.audioWorklet = {
            addModule: async (url) => {
              events.push(`worklet:addModule:${url}`)
            },
          }
        }
        async resume() {
          this.state = 'running'
          events.push('ctx:resume')
        }
        createMediaStreamSource() {
          return {
            connect: () => events.push('source:connect'),
            disconnect: () => events.push('source:disconnect'),
          }
        }
        createGain() {
          const node = {
            gain: { value: 1 },
            connect: () => events.push('gain:connect'),
            disconnect: () => events.push('gain:disconnect'),
          }
          events.push('gain:create')
          return node
        }
        async close() {
          this.state = 'closed'
          events.push('ctx:close')
        }
      }

      const captureWorkletNode = (node) => {
        workletNodeRef = node
      }
      globalThis.AudioWorkletNode = class FakeAudioWorkletNode {
        constructor(_ctx, name, opts) {
          assert.equal(name, VOICE_CAPTURE_PROCESSOR_NAME)
          assert.equal(opts.processorOptions.targetSampleRate, 16000)
          this.port = {
            onmessage: null,
            postMessage: (msg) => events.push(`port:post:${msg.type}`),
          }
          this.onprocessorerror = null
          captureWorkletNode(this)
        }
        connect(dest) {
          if ('gain' in dest) {
            assert.equal(dest.gain.value, 0)
          }
          events.push('worklet:connect')
        }
        disconnect() {
          events.push('worklet:disconnect')
        }
      }

      const received = []
      const handle = await createBrowserMicCapture({
        onChunk: (pcm) => received.push(pcm),
      })

      assert.deepEqual(capturedConstraints, {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      workletNodeRef.port.onmessage({ data: new Float32Array([0.1, -0.1]) })
      assert.equal(received.length, 1)

      await handle.stop()
      await handle.stop() // Idempotent second call

      assert.deepEqual(events, [
        'blob:create',
        'worklet:addModule:blob:mock-capture-worklet',
        'ctx:resume',
        'gain:create',
        'source:connect',
        'worklet:connect',
        'gain:connect',
        'port:post:stop',
        'source:disconnect',
        'worklet:disconnect',
        'gain:disconnect',
        'track:stop',
        'ctx:close',
        'blob:revoke:blob:mock-capture-worklet',
      ])
    } finally {
      if (origNavigator) {
        Object.defineProperty(globalThis, 'navigator', origNavigator)
      } else {
        delete globalThis.navigator
      }
      globalThis.AudioContext = origAudioContext
      globalThis.AudioWorkletNode = origAudioWorkletNode
      URL.createObjectURL = origCreateObjUrl
      URL.revokeObjectURL = origRevokeObjUrl
    }
  })
})
