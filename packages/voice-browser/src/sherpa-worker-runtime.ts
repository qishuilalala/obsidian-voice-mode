/**
 * Self-contained Web Worker runtime script builder for sherpa-onnx WASM
 * (Silero VAD, SenseVoice int8 offline ASR, and VITS offline TTS).
 *
 * Mounts model binaries zero-copy into Emscripten MEMFS (`canOwn = true`) and
 * immediately unlinks ONNX weight files post-initialization so duplicate JS heap
 * buffers are reclaimed while WASM retains its internal model graph.
 */

const WAV_HEADER_BYTES = 44

/** Encode mono Float32 PCM samples in [-1, 1] into a 44-byte 16-bit PCM `audio/wav` ArrayBuffer. */
export function encodePcm16Wav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 22050
  const dataBytes = samples.length * 2
  const wavBuffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes)
  const view = new DataView(wavBuffer)

  // RIFF chunk descriptor
  view.setUint8(0, 0x52) // R
  view.setUint8(1, 0x49) // I
  view.setUint8(2, 0x46) // F
  view.setUint8(3, 0x46) // F
  view.setUint32(4, 36 + dataBytes, true)
  view.setUint8(8, 0x57) // W
  view.setUint8(9, 0x41) // A
  view.setUint8(10, 0x56) // V
  view.setUint8(11, 0x45) // E

  // fmt sub-chunk (16-bit mono linear PCM)
  view.setUint8(12, 0x66) // f
  view.setUint8(13, 0x6d) // m
  view.setUint8(14, 0x74) // t
  view.setUint8(15, 0x20) // ' '
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)

  // data sub-chunk
  view.setUint8(36, 0x64) // d
  view.setUint8(37, 0x61) // a
  view.setUint8(38, 0x74) // t
  view.setUint8(39, 0x61) // a
  view.setUint32(40, dataBytes, true)

  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i]
    const clamped = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0
    const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767)
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.max(-32768, Math.min(32767, pcm)), true)
  }

  return wavBuffer
}

const SHERPA_WORKER_HANDLER_BODY = `
;(function () {
  "use strict";

  let wasmMod = null;
  let vad = null;
  let offlineAsr = null;
  let offlineTts = null;
  let vadCarry = new Float32Array(0);
  let opQueue = Promise.resolve();

  function nowMs() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }

  function makeWorkerError(code, message) {
    const err = new Error(message);
    err.workerCode = code;
    return err;
  }

  function reply(msg, transfer) {
    if (transfer && transfer.length > 0) {
      self.postMessage(msg, transfer);
    } else {
      self.postMessage(msg);
    }
  }

  function ensureDir(FS, dirPath) {
    if (!FS) return;
    if (typeof FS.mkdirTree === "function") {
      FS.mkdirTree(dirPath);
      return;
    }
    if (typeof FS.mkdir !== "function") return;
    const parts = dirPath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length; i++) {
      current += "/" + parts[i];
      try {
        FS.mkdir(current);
      } catch (_err) {
        // Directory already exists in MEMFS.
      }
    }
  }

  function safeUnlink(FS, filePath) {
    if (!FS || typeof FS.unlink !== "function") return;
    try {
      FS.unlink(filePath);
    } catch (_err) {
      // Ignore missing path.
    }
  }

  function mountZeroCopy(FS, fullPath, arrayBuffer) {
    const slashIdx = fullPath.lastIndexOf("/");
    if (slashIdx > 0) {
      ensureDir(FS, fullPath.slice(0, slashIdx));
    }
    safeUnlink(FS, fullPath);
    const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    const stream = FS.open(fullPath, "w+");
    try {
      FS.write(stream, bytes, 0, bytes.byteLength, 0, true);
    } finally {
      if (typeof FS.close === "function") {
        FS.close(stream);
      }
    }
  }

  function normalizeRelName(rawName) {
    const cleaned = String(rawName || "").replace(/^\\/+|^\\.\\/+/, "");
    const parts = cleaned.split("/");
    if (!cleaned || parts.some((seg) => !seg || seg === "." || seg === "..")) {
      throw makeWorkerError("model_load_failed", "Unsafe model filename: " + String(rawName));
    }
    return cleaned;
  }

  function baseName(pathStr) {
    const idx = pathStr.lastIndexOf("/");
    return idx >= 0 ? pathStr.slice(idx + 1) : pathStr;
  }

  function freeInstance(inst) {
    if (inst && typeof inst.free === "function") {
      try {
        inst.free();
      } catch (_err) {
        // Ignore teardown errors on superseded instances.
      }
    }
  }

  function encodeWavPcm16(samples, sampleRate) {
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? Math.round(sampleRate) : 22050;
    const dataBytes = samples.length * 2;
    const wavBuffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(wavBuffer);

    view.setUint8(0, 0x52);
    view.setUint8(1, 0x49);
    view.setUint8(2, 0x46);
    view.setUint8(3, 0x46);
    view.setUint32(4, 36 + dataBytes, true);
    view.setUint8(8, 0x57);
    view.setUint8(9, 0x41);
    view.setUint8(10, 0x56);
    view.setUint8(11, 0x45);
    view.setUint8(12, 0x66);
    view.setUint8(13, 0x6d);
    view.setUint8(14, 0x74);
    view.setUint8(15, 0x20);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint8(36, 0x64);
    view.setUint8(37, 0x61);
    view.setUint8(38, 0x74);
    view.setUint8(39, 0x61);
    view.setUint32(40, dataBytes, true);

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const clamped = Number.isFinite(s) ? Math.max(-1, Math.min(1, s)) : 0;
      const pcm = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
      view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, pcm)), true);
    }
    return wavBuffer;
  }

  async function handleModelLoad(req) {
    const t0 = nowMs();
    const files = Array.isArray(req.files) ? req.files : [];
    const config = req.config || {};

    if (!wasmMod) {
      const wasmFile = files.find(
        (f) =>
          f &&
          typeof f.name === "string" &&
          (f.name === "sherpa-onnx.wasm" || f.name.toLowerCase().endsWith(".wasm")),
      );
      if (!wasmFile || !(wasmFile.buffer instanceof ArrayBuffer)) {
        throw makeWorkerError(
          "model_load_failed",
          "WASM binary (sherpa-onnx.wasm) is required when initializing Sherpa Module",
        );
      }
      wasmMod = await Module({
        wasmBinary: wasmFile.buffer,
        print: () => {},
        printErr: () => {},
      });
    }

    const FS = wasmMod && wasmMod.FS;
    if (!FS) {
      throw makeWorkerError("model_load_failed", "Emscripten FS is unavailable on WASM Module");
    }

    const modelFiles = files.filter(
      (f) => f && typeof f.name === "string" && !f.name.toLowerCase().endsWith(".wasm"),
    );

    if (req.target === "vad") {
      const vadFile =
        modelFiles.find((f) => baseName(f.name) === "silero_vad.onnx") ||
        modelFiles.find((f) => f.name.toLowerCase().endsWith(".onnx"));
      if (!vadFile || !(vadFile.buffer instanceof ArrayBuffer)) {
        throw makeWorkerError("model_load_failed", "Missing silero_vad.onnx in model:load files");
      }

      const vadPath = "/models/vad/silero_vad.onnx";
      mountZeroCopy(FS, vadPath, vadFile.buffer);
      freeInstance(vad);
      vad = null;
      vadCarry = new Float32Array(0);

      try {
        vad = SherpaVad.createVad(wasmMod, {
          sileroVad: {
            model: vadPath,
            threshold: Number(config.threshold ?? 0.45),
            minSilenceDuration: Number(config.minSilenceDuration ?? 0.35),
            minSpeechDuration: Number(config.minSpeechDuration ?? 0.15),
            maxSpeechDuration: Number(config.maxSpeechDuration ?? 20),
            windowSize: 512,
          },
          sampleRate: 16000,
          numThreads: 1,
          provider: "cpu",
          debug: 0,
          bufferSizeInSeconds: 60,
        });
        if (!vad || ("handle" in vad && !vad.handle)) {
          vad = null;
          throw makeWorkerError("model_load_failed", "SherpaVad.createVad returned null handle");
        }
      } finally {
        safeUnlink(FS, vadPath);
      }

      reply({
        id: req.id,
        type: "model:loaded",
        target: "vad",
        elapsedMs: Math.max(0, Math.round(nowMs() - t0)),
      });
      return;
    }

    if (req.target === "asr-offline") {
      const onnxFile =
        modelFiles.find((f) => baseName(f.name) === "model.int8.onnx") ||
        modelFiles.find((f) => f.name.toLowerCase().endsWith(".onnx"));
      const tokensFile = modelFiles.find((f) => baseName(f.name) === "tokens.txt");
      if (!onnxFile || !(onnxFile.buffer instanceof ArrayBuffer)) {
        throw makeWorkerError("model_load_failed", "Missing model.int8.onnx in model:load files");
      }
      if (!tokensFile || !(tokensFile.buffer instanceof ArrayBuffer)) {
        throw makeWorkerError("model_load_failed", "Missing tokens.txt in model:load files");
      }

      // Single-heavy-model guard (ADR-0002): evict VITS before mounting SenseVoice so
      // SenseVoice (239 MB) and VITS (121 MB) never stay co-resident in WASM heap.
      // Lightweight Silero VAD (1.8 MB) remains untouched.
      freeInstance(offlineTts);
      offlineTts = null;
      freeInstance(offlineAsr);
      offlineAsr = null;

      const modelPath = "/models/sense/model.int8.onnx";
      const tokensPath = "/models/sense/tokens.txt";
      mountZeroCopy(FS, modelPath, onnxFile.buffer);
      mountZeroCopy(FS, tokensPath, tokensFile.buffer);

      try {
        offlineAsr = new SherpaAsr.OfflineRecognizer(
          {
            featConfig: { sampleRate: 16000, featureDim: 80 },
            modelConfig: {
              senseVoice: {
                model: modelPath,
                language: String(config.language ?? "auto"),
                useInverseTextNormalization: config.useItn === false ? 0 : 1,
              },
              tokens: tokensPath,
              numThreads: 1,
              provider: "cpu",
              debug: 0,
            },
          },
          wasmMod,
        );
        if (!offlineAsr || ("handle" in offlineAsr && !offlineAsr.handle)) {
          offlineAsr = null;
          throw makeWorkerError(
            "model_load_failed",
            "SherpaAsr.OfflineRecognizer returned null handle",
          );
        }
      } finally {
        safeUnlink(FS, modelPath);
      }

      reply({
        id: req.id,
        type: "model:loaded",
        target: "asr-offline",
        elapsedMs: Math.max(0, Math.round(nowMs() - t0)),
      });
      return;
    }

    if (req.target === "tts-vits") {
      if (modelFiles.length === 0) {
        throw makeWorkerError("model_load_failed", "Missing VITS files in model:load request");
      }
      const normalizedEntries = modelFiles.map((file) => ({
        file,
        rel: normalizeRelName(file.name),
      }));

      // Single-heavy-model guard (ADR-0002): evict SenseVoice before mounting VITS so
      // SenseVoice (239 MB) and VITS (121 MB) never stay co-resident in WASM heap.
      // Lightweight Silero VAD (1.8 MB) remains untouched.
      freeInstance(offlineAsr);
      offlineAsr = null;
      freeInstance(offlineTts);
      offlineTts = null;

      let modelPath = typeof config.model === "string" ? config.model : "";
      let lexiconPath = typeof config.lexicon === "string" ? config.lexicon : "";
      let tokensPath = typeof config.tokens === "string" ? config.tokens : "";
      const fstPaths = [];

      for (let i = 0; i < normalizedEntries.length; i++) {
        const entry = normalizedEntries[i];
        const file = entry.file;
        const rel = entry.rel;
        const lower = rel.toLowerCase();
        const isOnnx = lower.endsWith(".onnx");
        const targetPath =
          isOnnx && !modelPath ? "/models/vits/model.onnx" : "/models/vits/" + rel;
        mountZeroCopy(FS, targetPath, file.buffer);
        if (isOnnx && !modelPath) {
          modelPath = targetPath;
        } else if (baseName(rel) === "lexicon.txt" && !lexiconPath) {
          lexiconPath = targetPath;
        } else if (baseName(rel) === "tokens.txt" && !tokensPath) {
          tokensPath = targetPath;
        } else if (lower.endsWith(".fst")) {
          fstPaths.push(targetPath);
        }
      }

      if (!modelPath) {
        modelPath = "/models/vits/model.onnx";
      }
      const ruleFsts =
        typeof config.ruleFsts === "string" ? config.ruleFsts : fstPaths.join(",");

      try {
        offlineTts = SherpaTts.createOfflineTts(wasmMod, {
          offlineTtsModelConfig: {
            offlineTtsVitsModelConfig: {
              model: modelPath,
              lexicon: lexiconPath,
              tokens: tokensPath || "/models/vits/tokens.txt",
              dataDir: "",
              noiseScale: Number(config.noiseScale ?? 0.667),
              noiseScaleW: Number(config.noiseScaleW ?? 0.8),
              lengthScale: Number(config.lengthScale ?? 1.0),
            },
            numThreads: 1,
            debug: 0,
            provider: "cpu",
          },
          ruleFsts,
          ruleFars: String(config.ruleFars ?? ""),
          maxNumSentences: Number(config.maxNumSentences ?? 1),
        });
        if (!offlineTts || ("handle" in offlineTts && !offlineTts.handle)) {
          offlineTts = null;
          throw makeWorkerError(
            "model_load_failed",
            "SherpaTts.createOfflineTts returned null handle",
          );
        }
      } finally {
        safeUnlink(FS, "/models/vits/model.onnx");
        if (modelPath !== "/models/vits/model.onnx") {
          safeUnlink(FS, modelPath);
        }
      }

      reply({
        id: req.id,
        type: "model:loaded",
        target: "tts-vits",
        elapsedMs: Math.max(0, Math.round(nowMs() - t0)),
      });
      return;
    }

    throw makeWorkerError("model_load_failed", "Unsupported model target: " + String(req.target));
  }

  function handleVadProcess(req) {
    if (!vad) {
      throw makeWorkerError("not_initialized", "Silero VAD model is not loaded");
    }
    const incoming = new Float32Array(req.pcm);
    let samples;
    if (vadCarry.length > 0) {
      samples = new Float32Array(vadCarry.length + incoming.length);
      samples.set(vadCarry, 0);
      samples.set(incoming, vadCarry.length);
    } else {
      samples = incoming;
    }

    let offset = 0;
    let detectedInChunk = false;
    let speechEnded = false;

    while (offset + 512 <= samples.length) {
      const window512 = samples.subarray(offset, offset + 512);
      vad.acceptWaveform(window512);
      if (vad.isDetected()) {
        detectedInChunk = true;
      }
      while (!vad.isEmpty()) {
        vad.pop();
        speechEnded = true;
      }
      offset += 512;
    }

    vadCarry = offset < samples.length ? samples.slice(offset) : new Float32Array(0);
    const currentlyDetected = Boolean(vad.isDetected());
    const isSpeech = currentlyDetected || (detectedInChunk && !speechEnded);

    reply({
      id: req.id,
      type: "vad:result",
      speechProbability: isSpeech ? 1 : 0,
      isSpeech,
      speechEnded,
    });
  }

  function handleVadReset(req) {
    vadCarry = new Float32Array(0);
    if (vad && typeof vad.reset === "function") {
      vad.reset();
    }
    reply({ id: req.id, type: "worker:ack" });
  }

  function handleAsrTranscribe(req) {
    if (!offlineAsr) {
      throw makeWorkerError("not_initialized", "Offline ASR model is not loaded");
    }
    const samples = new Float32Array(req.pcm);
    const sampleRate = Number(req.sampleRate) > 0 ? Number(req.sampleRate) : 16000;
    const durationMs = samples.length > 0 ? Math.round((samples.length / sampleRate) * 1000) : 0;

    if (samples.length === 0) {
      reply({ id: req.id, type: "asr:final", text: "", durationMs: 0 });
      return;
    }

    const stream = offlineAsr.createStream();
    try {
      stream.acceptWaveform(sampleRate, samples);
      offlineAsr.decode(stream);
      const res = offlineAsr.getResult(stream) || {};
      const text = typeof res.text === "string" ? res.text.trim() : "";
      const out = {
        id: req.id,
        type: "asr:final",
        text,
        durationMs,
      };
      if (typeof res.lang === "string" && res.lang.length > 0) {
        out.language = res.lang;
      }
      reply(out);
    } finally {
      if (stream && typeof stream.free === "function") {
        stream.free();
      }
    }
  }

  function handleTtsSynthesize(req) {
    if (!offlineTts) {
      throw makeWorkerError("not_initialized", "Offline TTS model is not loaded");
    }
    const text = typeof req.text === "string" ? req.text : "";
    const generated = offlineTts.generate({
      text,
      sid: req.speakerId ?? 0,
      speed: req.speed ?? 1.0,
    });
    const samples =
      generated && generated.samples instanceof Float32Array
        ? generated.samples
        : new Float32Array(0);
    const sampleRate = Number(generated?.sampleRate || offlineTts.sampleRate || 22050);
    const wavBuffer = encodeWavPcm16(samples, sampleRate);
    reply(
      {
        id: req.id,
        type: "tts:result",
        audio: wavBuffer,
        sampleRate,
        channels: 1,
        mime: "audio/wav",
      },
      [wavBuffer],
    );
  }

  function handleDispose(req) {
    freeInstance(offlineAsr);
    offlineAsr = null;
    freeInstance(vad);
    vad = null;
    freeInstance(offlineTts);
    offlineTts = null;
    vadCarry = new Float32Array(0);
    reply({ id: req.id, type: "worker:ack" });
  }

  function mapErrorCode(reqType, err) {
    if (err && typeof err.workerCode === "string") {
      return err.workerCode;
    }
    const msg = err && typeof err.message === "string" ? err.message : String(err);
    if (
      (typeof WebAssembly !== "undefined" && err instanceof WebAssembly.RuntimeError) ||
      /out of memory|oom|cannot enlarge memory|allocation failed/i.test(msg)
    ) {
      return "out_of_memory";
    }
    switch (reqType) {
      case "model:load":
        return "model_load_failed";
      case "vad:process":
      case "vad:reset":
        return "vad_failed";
      case "asr:transcribe":
        return "asr_failed";
      case "tts:synthesize":
        return "tts_failed";
      default:
        return "internal_error";
    }
  }

  async function dispatchRequest(req) {
    if (
      !req ||
      typeof req !== "object" ||
      typeof req.id !== "number" ||
      !Number.isInteger(req.id) ||
      req.id < 0 ||
      typeof req.type !== "string"
    ) {
      if (req && typeof req === "object" && typeof req.id === "number") {
        reply({
          id: req.id,
          type: "worker:error",
          code: "invalid_message",
          message: "Malformed worker request",
        });
      }
      return;
    }

    try {
      switch (req.type) {
        case "model:load":
          await handleModelLoad(req);
          break;
        case "vad:process":
          handleVadProcess(req);
          break;
        case "vad:reset":
          handleVadReset(req);
          break;
        case "asr:transcribe":
          handleAsrTranscribe(req);
          break;
        case "tts:synthesize":
          handleTtsSynthesize(req);
          break;
        case "worker:cancel":
          reply({ id: req.id, type: "worker:ack" });
          break;
        case "worker:dispose":
          handleDispose(req);
          break;
        default:
          reply({
            id: req.id,
            type: "worker:error",
            code: "invalid_message",
            message: "Unsupported worker request type: " + String(req.type),
          });
          break;
      }
    } catch (err) {
      const code = mapErrorCode(req.type, err);
      const message =
        err && typeof err === "object" && typeof err.message === "string"
          ? err.message
          : String(err);
      reply({
        id: req.id,
        type: "worker:error",
        code,
        message,
      });
    }
  }

  self.onmessage = function (ev) {
    const req = ev ? ev.data : undefined;
    if (req && typeof req === "object" && req.type === "worker:cancel" && Number.isInteger(req.id) && req.id >= 0) {
      reply({ id: req.id, type: "worker:ack" });
      return;
    }
    opQueue = opQueue.then(() => dispatchRequest(req)).catch(() => undefined);
  };
})();
`.trim()

/**
 * Produce a complete self-contained Web Worker script string by prepending
 * `memfsSherpaGlueCode` (`Module`, `SherpaVad`, `SherpaAsr`, `SherpaTts`) to the
 * `WorkerRequest` / `WorkerResponse` message runtime.
 */
export function createSherpaWorkerScript(memfsSherpaGlueCode: string): string {
  return `${memfsSherpaGlueCode}\n${SHERPA_WORKER_HANDLER_BODY}\n`
}
