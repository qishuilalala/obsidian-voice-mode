import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import zlib from "node:zlib";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") {
      return {
        url: "data:text/javascript,export function requestUrl() { throw new Error('unmocked obsidian requestUrl'); }",
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { createObsidianFetchWithCorsFallback } = await import("../src/obsidian-http.ts");
const { createDesktopFsAdapter } = await import("../src/desktop-fs.ts");
const { DesktopModelManager, WASM_ALLOWED_HOSTNAMES } = await import("../src/model-manager.ts");
const {
  detectRuntimeCapabilities,
  resolveEffectiveAsrEngine,
  resolveEffectiveTtsEngine,
} = await import("../src/runtime-guard.ts");
const {
  DEFAULT_SETTINGS,
  createDefaultSettings,
  getTtsSecretId,
  normalizeSettings,
  setTtsSecretId,
  stripSecretsFromSettings,
  toSecretId,
} = await import("../src/settings.ts");
const { SpeechPlayer } = await import("../src/speech-player.ts");
const { MimoTtsEngine, OpenAiCompatTtsEngine } = await import("@voice-mode/core");
const { VitsWasmTtsEngine, encodePcm16Wav } = await import("@voice-mode/browser");

const nodeRequire = createRequire(import.meta.url);
const TEXT_ENCODER = new TextEncoder();

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeFakeWavBytes() {
  return new Uint8Array(encodePcm16Wav(new Float32Array([0, 0.25, -0.25, 0]), 22050));
}

function makeFakeMp3Bytes() {
  return new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb]);
}

function writeTarString(buf, offset, maxLen, text) {
  const encoded = TEXT_ENCODER.encode(text);
  const count = Math.min(encoded.byteLength, maxLen);
  buf.set(encoded.subarray(0, count), offset);
}

function buildUstarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data =
      entry.data instanceof Uint8Array ? entry.data : TEXT_ENCODER.encode(entry.data ?? "");
    const header = new Uint8Array(512);
    const sizeBytes = data.byteLength;

    writeTarString(header, 0, 100, entry.name);
    writeTarString(header, 100, 8, "0000644\0");
    writeTarString(header, 108, 8, "0000000\0");
    writeTarString(header, 116, 8, "0000000\0");
    writeTarString(header, 124, 12, `${sizeBytes.toString(8).padStart(11, "0")}\0`);
    writeTarString(header, 136, 12, "00000000000\0");
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");

    let checksum = 0;
    for (let i = 0; i < 512; i += 1) {
      checksum += header[i];
    }
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);

    if (sizeBytes > 0) {
      const paddedLen = Math.ceil(sizeBytes / 512) * 512;
      const payloadBlock = new Uint8Array(paddedLen);
      payloadBlock.set(data.subarray(0, sizeBytes), 0);
      blocks.push(payloadBlock);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, b) => sum + b.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const block of blocks) {
    out.set(block, pos);
    pos += block.byteLength;
  }
  return out;
}

describe("createObsidianFetchWithCorsFallback (M2 outbound HTTP + CORS fallback)", () => {
  it("returns primary fetch response directly when CORS succeeds and blocks insecure URLs", async () => {
    let nodeCalled = 0;
    let reqUrlCalled = 0;
    const corsEvents = [];

    const obsidianFetch = createObsidianFetchWithCorsFallback({
      isDesktop: true,
      win: {
        require: () => {
          nodeCalled += 1;
          return null;
        },
      },
      fetchImpl: async (url) => new Response(`ok:${String(url)}`, { status: 200 }),
      requestUrlImpl: async () => {
        reqUrlCalled += 1;
        throw new Error("should not call requestUrl");
      },
      onCorsFallback: (origin, via) => corsEvents.push({ origin, via }),
    });

    const res = await obsidianFetch("https://api.siliconflow.cn/v1/audio/speech", {
      method: "POST",
      redirect: "error",
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok:https://api.siliconflow.cn/v1/audio/speech");
    assert.equal(nodeCalled, 0);
    assert.equal(reqUrlCalled, 0);
    assert.deepEqual(corsEvents, []);

    await assert.rejects(
      () => obsidianFetch("http://remote.example.com/v1/audio/speech"),
      /HTTPS|loopback/i,
    );
  });

  it("falls back to Desktop zero-redirect Node stream on CORS TypeError and blocks 302 on redirect='error'", async () => {
    const corsEvents = [];
    const chunksToEmit = [TEXT_ENCODER.encode("chunk-1-"), TEXT_ENCODER.encode("chunk-2")];
    let nextStatusCode = 200;
    let destroyedCount = 0;
    const capturedBodies = [];

    const mockHttpsMod = {
      request(_url, _opts, cb) {
        let payloadBuf = "";
        return {
          on() {
            return this;
          },
          write(chunk) {
            payloadBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            return true;
          },
          end() {
            capturedBodies.push(payloadBuf);
            const res = {
              statusCode: nextStatusCode,
              headers: { "content-type": "audio/mpeg", "x-provider": ["edge", "node"] },
              destroy() {
                destroyedCount += 1;
              },
              async *[Symbol.asyncIterator]() {
                for (const c of chunksToEmit) {
                  yield c;
                }
              },
            };
            queueMicrotask(() => cb(res));
          },
          destroy() {},
        };
      },
    };

    const obsidianFetch = createObsidianFetchWithCorsFallback({
      isDesktop: true,
      win: {
        require: (modName) => (modName === "https" ? mockHttpsMod : null),
      },
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
      onCorsFallback: (origin, via) => corsEvents.push({ origin, via }),
    });

    // 1. Streaming success via Desktop zero-redirect Node transport
    const streamRes = await obsidianFetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"input":"hello"}',
      redirect: "error",
    });
    assert.equal(streamRes.status, 200);
    assert.equal(streamRes.headers.get("content-type"), "audio/mpeg");
    assert.equal(streamRes.headers.get("x-provider"), "edge, node");
    assert.equal(await streamRes.text(), "chunk-1-chunk-2");
    assert.deepEqual(capturedBodies, ['{"input":"hello"}']);
    assert.deepEqual(corsEvents, [{ origin: "https://api.openai.com", via: "desktop-node" }]);

    // 2. HTTP 302 redirect is strictly blocked when redirect: "error" is set
    nextStatusCode = 302;
    await assert.rejects(
      () =>
        obsidianFetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          redirect: "error",
        }),
      /302.*redirect/i,
    );
    assert.ok(destroyedCount >= 1);

    // 3. Aborting AFTER response headers arrive (between pulls on an EventEmitter IncomingMessage)
    //    must never throw an uncaught Node 'error' event and must reject stream reading cleanly!
    const emitterHttpsMod = {
      request(_url, _opts, cb) {
        return {
          on() {
            return this;
          },
          write() {
            return true;
          },
          end() {
            const res = Object.assign(new EventEmitter(), {
              statusCode: 200,
              headers: { "content-type": "audio/mpeg" },
              destroy(err) {
                if (err) {
                  this.emit("error", err);
                }
              },
              [Symbol.asyncIterator]() {
                return { next: () => new Promise(() => {}) };
              },
            });
            queueMicrotask(() => cb(res));
          },
          destroy() {},
        };
      },
    };
    const emitterFetch = createObsidianFetchWithCorsFallback({
      isDesktop: true,
      win: { require: (modName) => (modName === "https" ? emitterHttpsMod : null) },
      fetchImpl: async () => {
        throw new TypeError("CORS blocked");
      },
    });
    const postHeaderAc = new AbortController();
    const pendingStreamRes = await emitterFetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      signal: postHeaderAc.signal,
    });
    postHeaderAc.abort(new Error("stopped mid-stream"));
    await assert.rejects(
      () => pendingStreamRes.arrayBuffer(),
      (err) => err instanceof Error && (err.name === "AbortError" || /abort|stop/i.test(err.message)),
    );
  });

  it("falls back to Mobile requestUrl on CORS TypeError and never falls back on AbortSignal cancellation", async () => {
    const corsEvents = [];
    let reqUrlCalls = 0;
    const wavBytes = makeFakeWavBytes();

    const mobileFetch = createObsidianFetchWithCorsFallback({
      isDesktop: false,
      fetchImpl: async (_url, init) => {
        if (init?.signal?.aborted) {
          const err = new Error("Aborted");
          err.name = "AbortError";
          throw err;
        }
        throw new TypeError("CORS blocked by WebView");
      },
      requestUrlImpl: async (param) => {
        reqUrlCalls += 1;
        assert.equal(param.throw, false);
        assert.equal(param.method, "POST");
        const ab = wavBytes.buffer.slice(
          wavBytes.byteOffset,
          wavBytes.byteOffset + wavBytes.byteLength,
        );
        return {
          status: 200,
          headers: { "content-type": "audio/wav" },
          arrayBuffer: ab,
          json: null,
          text: "",
        };
      },
      onCorsFallback: (origin, via) => corsEvents.push({ origin, via }),
    });

    const okRes = await mobileFetch("https://api.xiaomimimo.com/v1/chat/completions", {
      method: "POST",
      body: '{"model":"mimo-v2.5-tts"}',
    });
    assert.equal(okRes.status, 200);
    assert.equal(new Uint8Array(await okRes.arrayBuffer()).byteLength, wavBytes.byteLength);
    assert.equal(reqUrlCalls, 1);
    assert.deepEqual(corsEvents, [
      { origin: "https://api.xiaomimimo.com", via: "obsidian-request-url" },
    ]);

    // Aborted signal must propagate AbortError without triggering fallback!
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    await assert.rejects(
      () =>
        mobileFetch("https://api.xiaomimimo.com/v1/chat/completions", {
          method: "POST",
          signal: ac.signal,
        }),
      (err) => err instanceof Error && (err.name === "AbortError" || /abort|cancel/i.test(err.message)),
    );
    assert.equal(reqUrlCalls, 1);
  });
});

describe("settings.ts M2 subtitle presets, barge-in mode, and per-preset TTS secret isolation", () => {
  it("normalizes M2 fields and isolates per-preset OpenAI-compatible & MiMo secret IDs", () => {
    const defaults = createDefaultSettings();
    assert.equal(defaults.subtitleFontSize, "medium");
    assert.equal(defaults.subtitleWidth, "medium");
    assert.equal(defaults.bargeInMode, "detect");
    assert.equal(defaults.ttsPresetId, "siliconflow-cosyvoice2");
    assert.equal(defaults.ttsModel, "");
    assert.equal(defaults.stopReadAloudOnNoteSwitch, true);

    // Strict per-preset secret isolation (including "custom"): zero cross-preset fallback!
    setTtsSecretId(defaults, "openai-compat", "voice-mode-tts-unscoped");
    assert.equal(getTtsSecretId(defaults, "openai-compat"), "voice-mode-tts-unscoped");
    assert.equal(getTtsSecretId(defaults, "openai-compat", "siliconflow-cosyvoice2"), "");
    assert.equal(getTtsSecretId(defaults, "openai-compat", "selfhosted-kokoro"), "");

    const sfSecretId = toSecretId("tts", "siliconflow-cosyvoice2");
    const oaiSecretId = toSecretId("tts", "openai-official");
    const customSecretId = toSecretId("tts", "custom");
    const mimoSecretId = toSecretId("tts", "mimo");

    setTtsSecretId(defaults, "openai-compat", sfSecretId, "siliconflow-cosyvoice2");
    setTtsSecretId(defaults, "openai-compat", oaiSecretId, "openai-official");
    setTtsSecretId(defaults, "openai-compat", customSecretId, "custom");
    setTtsSecretId(defaults, "mimo", mimoSecretId);

    assert.equal(getTtsSecretId(defaults, "openai-compat", "siliconflow-cosyvoice2"), sfSecretId);
    assert.equal(getTtsSecretId(defaults, "openai-compat", "openai-official"), oaiSecretId);
    assert.equal(getTtsSecretId(defaults, "openai-compat", "custom"), customSecretId);
    assert.equal(getTtsSecretId(defaults, "openai-compat", "groq-playai"), "");
    assert.equal(getTtsSecretId(defaults, "openai-compat", "selfhosted-kokoro"), "");
    assert.equal(getTtsSecretId(defaults, "mimo"), mimoSecretId);

    // Clearing a preset key removes it cleanly without resurrecting any fallback key
    setTtsSecretId(defaults, "openai-compat", "", "siliconflow-cosyvoice2");
    assert.equal(getTtsSecretId(defaults, "openai-compat", "siliconflow-cosyvoice2"), "");
    setTtsSecretId(defaults, "openai-compat", sfSecretId, "siliconflow-cosyvoice2");

    const fakeMockKey = ["sk", "proj", "mocksecretkey1234567890abcdef"].join("-");
    const stripped = stripSecretsFromSettings({
      ...defaults,
      subtitleFontSize: "large",
      subtitleWidth: "wide",
      bargeInMode: "auto",
      ttsPresetId: "custom",
      ttsModel: "cosyvoice-v2",
      stopReadAloudOnNoteSwitch: false,
      ttsApiKeySecretIds: {
        ...defaults.ttsApiKeySecretIds,
        "openai-compat:unknown-preset": "voice-mode-tts-unknown",
        mimo: fakeMockKey,
      },
    });

    assert.equal(
      stripped.ttsApiKeySecretIds["openai-compat:siliconflow-cosyvoice2"],
      sfSecretId,
    );
    assert.equal(stripped.ttsApiKeySecretIds["openai-compat:openai-official"], oaiSecretId);
    assert.equal(stripped.ttsApiKeySecretIds["openai-compat:custom"], customSecretId);
    assert.equal("openai-compat:unknown-preset" in stripped.ttsApiKeySecretIds, false);
    assert.equal("mimo" in stripped.ttsApiKeySecretIds, false);

    // Mobile cloud fallback privacy toggle (`allowCloudFallbackOnMobile`) enforcement
    const mobileCaps = detectRuntimeCapabilities(true);
    assert.equal(resolveEffectiveTtsEngine("openai-compat", mobileCaps, false), "system");
    assert.equal(resolveEffectiveTtsEngine("mimo", mobileCaps, false), "system");
    assert.equal(resolveEffectiveTtsEngine("openai-compat", mobileCaps, true), "openai-compat");
    assert.equal(resolveEffectiveAsrEngine("openai-compat", mobileCaps, false), "system");
    assert.equal(resolveEffectiveAsrEngine("openai-compat", mobileCaps, true), "openai-compat");

    const normalized = normalizeSettings(stripped);
    assert.equal(normalized.subtitleFontSize, "large");
    assert.equal(normalized.subtitleWidth, "wide");
    assert.equal(normalized.bargeInMode, "auto");
    assert.equal(normalized.ttsPresetId, "custom");
    assert.equal(normalized.ttsModel, "cosyvoice-v2");
    assert.equal(normalized.stopReadAloudOnNoteSwitch, false);

    const invalidFallback = normalizeSettings({
      subtitleFontSize: "huge",
      subtitleWidth: "ultrawide",
      bargeInMode: "invalid",
      ttsPresetId: "nonexistent-preset",
    });
    assert.equal(invalidFallback.subtitleFontSize, DEFAULT_SETTINGS.subtitleFontSize);
    assert.equal(invalidFallback.subtitleWidth, DEFAULT_SETTINGS.subtitleWidth);
    assert.equal(invalidFallback.bargeInMode, DEFAULT_SETTINGS.bargeInMode);
    assert.equal(invalidFallback.ttsPresetId, DEFAULT_SETTINGS.ttsPresetId);
  });
});

describe("SpeechPlayer M2 pause/resume watchdog suspension, skipCurrent, <100ms cancel, and engine mounting", () => {
  it("suspends speechSynthesis watchdog while paused, skips current sentence cleanly, and cancels in <100ms", async () => {
    const utterances = [];
    const errors = [];
    let synthPaused = false;

    class MockUtterance {
      constructor(text) {
        this.text = text;
        this.rate = 1;
        this.lang = "";
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      }
    }

    const mockWindow = {
      SpeechSynthesisUtterance: MockUtterance,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      speechSynthesis: {
        paused: false,
        getVoices: () => [],
        pause: () => {
          synthPaused = true;
          mockWindow.speechSynthesis.paused = true;
        },
        resume: () => {
          synthPaused = false;
          mockWindow.speechSynthesis.paused = false;
        },
        speak: (u) => {
          utterances.push(u);
        },
        cancel: () => {
          synthPaused = false;
          mockWindow.speechSynthesis.paused = false;
        },
      },
      URL,
      Audio: class {},
    };

    const player = new SpeechPlayer(
      { engine: "system", voice: "", rate: 1.0, language: "zh-CN" },
      {
        onError: (err, sentence) => errors.push({ err, sentence }),
      },
      () => mockWindow,
      { speechWatchdogMs: 70 },
    );

    player.speakSentences(["Sentence one.", "Sentence two.", "Sentence three."]);
    while (utterances.length < 1) {
      await new Promise((r) => queueMicrotask(r));
    }

    assert.equal(player.isActive, true);
    assert.equal(player.isPaused, false);

    // Pause for 140ms (> 70ms watchdog) — watchdog MUST stay suspended with zero false timeout!
    assert.equal(player.pause(), true);
    assert.equal(player.isPaused, true);
    assert.equal(player.isActive, true);
    assert.equal(synthPaused, true);

    await new Promise((r) => setTimeout(r, 140));
    assert.equal(errors.length, 0);
    assert.equal(player.isPaused, true);

    // Resume via togglePause() and complete utterance 1
    assert.equal(player.togglePause(), true);
    assert.equal(player.isPaused, false);
    assert.equal(synthPaused, false);
    utterances[0].onend();

    while (utterances.length < 2) {
      await new Promise((r) => queueMicrotask(r));
    }
    assert.equal(utterances[1].text, "Sentence two.");

    // skipCurrent() aborts sentence 2 and advances directly to sentence 3
    assert.equal(player.skipCurrent(), true);
    while (utterances.length < 3) {
      await new Promise((r) => queueMicrotask(r));
    }
    assert.equal(utterances[2].text, "Sentence three.");

    // Instant <100ms cancel()
    const t0 = performance.now();
    player.cancel();
    await player.waitUntilDrained();
    const cancelMs = performance.now() - t0;
    assert.ok(cancelMs < 100, `Expected cancel() < 100ms, got ${cancelMs.toFixed(2)}ms`);
    assert.equal(player.isActive, false);
    assert.equal(player.state, "idle");
    assert.equal(errors.length, 0);

    await player.dispose();
  });

  it("mounts OpenAiCompatTtsEngine, MimoTtsEngine, and VitsWasmTtsEngine and supports HTMLAudioElement pause/resume", async () => {
    const mp3Bytes = makeFakeMp3Bytes();
    const wavBytes = makeFakeWavBytes();
    const playedBlobs = [];
    const activeAudios = [];

    class MockAudio {
      constructor(src) {
        this.src = src;
        this.currentTime = 0;
        this.paused = false;
        this.onended = null;
        this.onerror = null;
        this.pendingPlayReject = null;
        activeAudios.push(this);
      }
      pause() {
        this.paused = true;
        if (this.pendingPlayReject) {
          const rej = this.pendingPlayReject;
          this.pendingPlayReject = null;
          const abortErr = new DOMException(
            "The play() request was interrupted by a call to pause().",
            "AbortError",
          );
          rej(abortErr);
        }
      }
      play() {
        this.paused = false;
        // Simulate Chromium's asynchronous play() promise so pause() during pending play() rejects with AbortError!
        return new Promise((resolve, reject) => {
          this.pendingPlayReject = reject;
          setTimeout(() => {
            if (this.pendingPlayReject === reject) {
              this.pendingPlayReject = null;
              resolve();
            }
          }, 25);
        });
      }
    }

    const mockWindow = {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      URL: {
        createObjectURL: (blob) => {
          playedBlobs.push(blob);
          return `blob:mock-${playedBlobs.length}`;
        },
        revokeObjectURL: () => {},
      },
      Audio: MockAudio,
    };

    const synthErrors = [];
    const player = new SpeechPlayer(
      { engine: "openai-compat", voice: "", rate: 1.1, language: "zh-CN" },
      {
        onError: (err, sentence) => synthErrors.push({ err, sentence }),
      },
      () => mockWindow,
    );

    const waitForAudioCount = async (count) => {
      for (let i = 0; i < 60 && activeAudios.length < count; i += 1) {
        if (synthErrors.length > 0) {
          throw synthErrors[0].err;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      if (synthErrors.length > 0) {
        throw synthErrors[0].err;
      }
      assert.equal(activeAudios.length, count);
    };

    const openAiEngine = new OpenAiCompatTtsEngine({
      presetId: "siliconflow-cosyvoice2",
      apiKey: () => "mock-siliconflow-api-key",
      fetchImpl: async () =>
        new Response(mp3Bytes, {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
    });

    const mimoEngine = new MimoTtsEngine({
      apiKey: () => "mock-mimo-api-key",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  audio: {
                    data: Buffer.from(wavBytes).toString("base64"),
                  },
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    });

    const mockWorkerClient = {
      isLoaded: () => true,
      ensureTtsLoaded: async () => {},
      synthesizeTts: async () => ({
        audio: wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength),
        mime: "audio/wav",
        sampleRate: 22050,
      }),
      dispose: async () => {},
    };
    const vitsEngine = new VitsWasmTtsEngine({
      workerClient: mockWorkerClient,
      voice: "gunian",
      rate: 1.0,
    });

    player.registerEngine(openAiEngine);
    player.registerEngine(mimoEngine);
    player.registerEngine(vitsEngine);

    assert.equal(player.hasRegisteredEngine("openai-compat"), true);
    assert.equal(player.hasRegisteredEngine("mimo"), true);
    assert.equal(player.hasRegisteredEngine("vits-wasm"), true);

    // 1. OpenAI-compatible playback + HTMLAudioElement pause/resume
    player.speakSentences(["Hello from CosyVoice2."]);
    await waitForAudioCount(1);
    assert.equal(player.pause(), true);
    assert.equal(activeAudios[0].paused, true);
    assert.equal(player.resume(), true);
    assert.equal(activeAudios[0].paused, false);
    activeAudios[0].onended();
    await player.waitUntilDrained();

    // 2. MiMo playback
    player.updateConfig({ engine: "mimo" });
    player.speakSentences(["Hello from MiMo."]);
    await waitForAudioCount(2);
    activeAudios[1].onended();
    await player.waitUntilDrained();

    // 3. Local VITS WASM playback
    player.updateConfig({ engine: "vits-wasm", voice: "gunian" });
    player.speakSentences(["你好，本地语音合成。"]);
    await waitForAudioCount(3);
    activeAudios[2].onended();
    await player.waitUntilDrained();

    assert.equal(playedBlobs.length, 3);
    assert.equal(playedBlobs[0].type, "audio/mpeg");
    assert.equal(playedBlobs[1].type, "audio/wav");
    assert.equal(playedBlobs[2].type, "audio/wav");

    await player.dispose();
  });
});

describe("DesktopModelManager M2 vitsReady and downloadVitsStack()", () => {
  it("tracks vitsReady independently of dictation stack and installs SHA256-verified VITS assets", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-m2-vits-test-"));
    const vaultDir = path.join(tmpRoot, "vault");
    const cacheDir = path.join(tmpRoot, "external-cache");
    await fsp.mkdir(vaultDir, { recursive: true });

    try {
      const vadBytes = TEXT_ENCODER.encode("fixture-vad-onnx");
      const senseBytes = TEXT_ENCODER.encode("fixture-sensevoice-onnx");
      const vitsModelBytes = TEXT_ENCODER.encode("fixture-vits-zh-ll-model-onnx");
      const vitsLexiconBytes = TEXT_ENCODER.encode("你好 n i3 h ao3\n");
      const vitsTokensBytes = TEXT_ENCODER.encode("sil 0\nn 1\n");

      const wasmEntries = [
        ["sherpa-onnx-wasm-nodejs.wasm", new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])],
        ["sherpa-onnx-wasm-nodejs.js", TEXT_ENCODER.encode("// wasm js\n")],
        ["sherpa-onnx-asr.js", TEXT_ENCODER.encode("// asr js\n")],
        ["sherpa-onnx-vad.js", TEXT_ENCODER.encode("// vad js\n")],
        ["sherpa-onnx-tts.js", TEXT_ENCODER.encode("// tts js\n")],
      ];
      const tarRaw = buildUstarArchive(
        wasmEntries.map(([name, data]) => ({ name: `package/${name}`, data })),
      );
      const tgzBytes = new Uint8Array(zlib.gzipSync(tarRaw));

      const vadBundle = {
        id: "silero-vad",
        label: "VAD",
        repo: "csukuangfj/vad",
        revision: "main",
        license: "MIT",
        files: [
          {
            revision: "main",
            file: "silero_vad.onnx",
            sha256: sha256Hex(vadBytes),
            bytes: vadBytes.byteLength,
          },
        ],
      };

      const senseVoiceBundle = {
        id: "sensevoice-int8",
        label: "SenseVoice",
        repo: "csukuangfj/sensevoice",
        revision: "main",
        license: "FunAudioLLM",
        files: [
          {
            revision: "main",
            file: "model.int8.onnx",
            sha256: sha256Hex(senseBytes),
            bytes: senseBytes.byteLength,
          },
        ],
      };

      const vitsBundle = {
        id: "vits-zh-ll",
        label: "VITS",
        repo: "csukuangfj/sherpa-onnx-vits-zh-ll",
        revision: "main",
        license: "Apache-2.0",
        files: [
          {
            revision: "main",
            file: "model.onnx",
            sha256: sha256Hex(vitsModelBytes),
            bytes: vitsModelBytes.byteLength,
          },
          {
            revision: "main",
            file: "lexicon.txt",
            sha256: sha256Hex(vitsLexiconBytes),
            bytes: vitsLexiconBytes.byteLength,
          },
          {
            revision: "main",
            file: "tokens.txt",
            sha256: sha256Hex(vitsTokensBytes),
            bytes: vitsTokensBytes.byteLength,
          },
        ],
      };

      const wasmTarball = {
        id: "sherpa-onnx-2.0.2",
        version: "2.0.2",
        tarballPath: "/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz",
        sha256: sha256Hex(tgzBytes),
        bytes: tgzBytes.byteLength,
        primaryHost: "https://registry.npmjs.org",
        fallbackHost: "https://registry.npmmirror.com",
        allowedHosts: WASM_ALLOWED_HOSTNAMES,
        license: "Apache-2.0",
        files: wasmEntries.map(([file, data]) => ({
          file,
          sha256: sha256Hex(data),
          bytes: data.byteLength,
        })),
      };

      const routePayloads = new Map([
        ["/csukuangfj/vad/resolve/main/silero_vad.onnx", vadBytes],
        ["/csukuangfj/sensevoice/resolve/main/model.int8.onnx", senseBytes],
        ["/csukuangfj/sherpa-onnx-vits-zh-ll/resolve/main/model.onnx", vitsModelBytes],
        ["/csukuangfj/sherpa-onnx-vits-zh-ll/resolve/main/lexicon.txt", vitsLexiconBytes],
        ["/csukuangfj/sherpa-onnx-vits-zh-ll/resolve/main/tokens.txt", vitsTokensBytes],
        ["/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz", tgzBytes],
      ]);

      let httpCalls = 0;
      const manager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vaultBasePath: vaultDir,
        vadBundle,
        senseVoiceBundle,
        vitsBundle,
        wasmTarball,
        adapter: createDesktopFsAdapter({ isDesktop: true, win: { require: nodeRequire } }),
        httpStreamFetch: async (req) => {
          httpCalls += 1;
          const pathname = new URL(req.url).pathname;
          const payload = routePayloads.get(pathname);
          if (!payload) {
            return { statusCode: 404, headers: {}, body: (async function* () {})() };
          }
          return {
            statusCode: 200,
            headers: { "content-length": String(payload.byteLength) },
            body: (async function* () {
              yield payload;
            })(),
          };
        },
      });

      const initial = await manager.checkStatus();
      assert.equal(initial.ready, false);
      assert.equal(initial.vitsReady, false);
      assert.equal(initial.vitsVerifiedBytes, 0);
      assert.equal(httpCalls, 0);

      // Download dictation stack only -> ready is true, vitsReady remains false
      const afterDictation = await manager.downloadDictationStack();
      assert.equal(afterDictation.ready, true);
      assert.equal(afterDictation.vitsReady, false);
      assert.equal(afterDictation.vitsVerifiedBytes, 0);

      // Download optional VITS stack -> both ready and vitsReady become true
      const afterVits = await manager.downloadVitsStack();
      assert.equal(afterVits.ready, true);
      assert.equal(afterVits.vitsReady, true);
      assert.equal(
        afterVits.vitsVerifiedBytes,
        vitsModelBytes.byteLength + vitsLexiconBytes.byteLength + vitsTokensBytes.byteLength,
      );

      const callsBeforeRead = httpCalls;
      const vitsBinaries = await manager.readTargetBinaries("tts-vits", false);
      assert.equal(httpCalls, callsBeforeRead);
      assert.deepEqual(
        vitsBinaries.map((b) => b.name),
        ["model.onnx", "lexicon.txt", "tokens.txt"],
      );
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});


describe("SpeechPlayer long-note backpressure (D-0012 A)", () => {
  it("feeds 300 sentences in bounded batches without dropping the tail", async () => {
    const utterances = [];
    class MockUtterance {
      constructor(text) {
        this.text = text;
        this.rate = 1;
        this.lang = "";
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      }
    }
    const mockWindow = {
      SpeechSynthesisUtterance: MockUtterance,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      speechSynthesis: {
        paused: false,
        getVoices: () => [],
        pause: () => undefined,
        resume: () => undefined,
        speak: (utterance) => {
          utterances.push(utterance);
        },
        cancel: () => undefined,
      },
      URL,
      Audio: class {},
    };

    const player = new SpeechPlayer(
      { engine: "system", voice: "", rate: 1.0, language: "zh-CN" },
      {},
      () => mockWindow,
    );
    const sentences = Array.from({ length: 300 }, (_, index) => `Sentence number ${index + 1}.`);
    assert.equal(player.speakSentences(sentences), 300);

    let played = 0;
    const deadline = Date.now() + 15_000;
    while (played < 300 && Date.now() < deadline) {
      const utterance = utterances.shift();
      if (!utterance) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      utterance.onend?.();
      played += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.equal(played, 300, `expected the full tail to play, got ${played}`);
    assert.equal(player.isActive, false);
    await player.dispose();
  });
});


describe("SpeechPlayer WAV export (P4 / D-0012 A)", () => {
  it("merges WAV engine output into one file and joins decoded samples", async () => {
    const { encodeMonoPcm16Wav, decodeMonoPcm16Wav } = await import("@voice-mode/core");
    const first = encodeMonoPcm16Wav(new Float32Array([0.1, 0.2, 0.3]), 24000);
    const second = encodeMonoPcm16Wav(new Float32Array([0.4, 0.5]), 24000);
    const player = new SpeechPlayer(
      { engine: "kokoro-daemon", voice: "", rate: 1.0, language: "zh-CN" },
      {},
      () => globalThis.window ?? {},
    );
    player.registerEngine({
      kind: "kokoro-daemon",
      async synthesize(text) {
        return text.includes("second")
          ? { audio: second, mime: "audio/wav" }
          : { audio: first, mime: "audio/wav" };
      },
      async close() {},
    });

    const result = await player.exportSentences(["first sentence", "second sentence"]);
    assert.equal(result.sentences, 2);
    assert.equal(result.skipped, 0);
    assert.equal(result.sampleRate, 24000);
    assert.ok(result.wav, "export must produce a WAV");
    const decoded = decodeMonoPcm16Wav(result.wav);
    assert.ok(decoded);
    assert.equal(decoded.samples.length, 5, "3 + 2 decoded samples must be joined");
    await player.dispose();
  });

  it("returns cancelled when the export signal is aborted", async () => {
    const { encodeMonoPcm16Wav } = await import("@voice-mode/core");
    const player = new SpeechPlayer(
      { engine: "kokoro-daemon", voice: "", rate: 1.0, language: "zh-CN" },
      {},
      () => globalThis.window ?? {},
    );
    player.registerEngine({
      kind: "kokoro-daemon",
      async synthesize() {
        return { audio: encodeMonoPcm16Wav(new Float32Array([0.1]), 16000), mime: "audio/wav" };
      },
      async close() {},
    });
    assert.equal(player.hasRegisteredEngine("kokoro-daemon"), true);
    const controller = new AbortController();
    controller.abort();
    const result = await player.exportSentences(["hello"], { signal: controller.signal });
    assert.equal(result.wav, null);
    assert.equal(result.reason, "cancelled");
    player.unregisterEngine("kokoro-daemon");
    assert.equal(player.hasRegisteredEngine("kokoro-daemon"), false);
    await player.dispose();
  });

  it("reports no-wav-engine when the selected engine produces text (system speech)", async () => {
    const player = new SpeechPlayer(
      { engine: "system", voice: "", rate: 1.0, language: "zh-CN" },
      {},
      () => globalThis.window ?? {},
    );
    const result = await player.exportSentences(["hello"]);
    assert.equal(result.wav, null);
    assert.equal(result.reason, "no-wav-engine");
    await player.dispose();
  });
});


describe("SpeechPlayer read-aloud progress (P4)", () => {
  it("reports the sentence index and total through onSentenceStart", async () => {
    const utterances = [];
    class MockUtterance {
      constructor(text) {
        this.text = text;
        this.rate = 1;
        this.lang = "";
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      }
    }
    const mockWindow = {
      SpeechSynthesisUtterance: MockUtterance,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      speechSynthesis: {
        paused: false,
        getVoices: () => [],
        pause: () => undefined,
        resume: () => undefined,
        speak: (utterance) => {
          utterances.push(utterance);
        },
        cancel: () => undefined,
      },
      URL,
      Audio: class {},
    };
    const started = [];
    const player = new SpeechPlayer(
      { engine: "system", voice: "", rate: 1.0, language: "zh-CN" },
      {
        onSentenceStart: (text, index, total) => {
          started.push({ text, index, total });
        },
      },
      () => mockWindow,
    );

    player.speakSentences(["First sentence.", "Second sentence."]);
    const deadline = Date.now() + 10_000;
    while (started.length < 2 && Date.now() < deadline) {
      const utterance = utterances.shift();
      if (!utterance) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      utterance.onend?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    assert.deepEqual(started, [
      { text: "First sentence.", index: 0, total: 2 },
      { text: "Second sentence.", index: 1, total: 2 },
    ]);
    await player.dispose();
  });


  it("reuses cached WAV synthesis for repeated sentences (session cache)", async () => {
    const { encodeMonoPcm16Wav } = await import("@voice-mode/core");
    const wav = encodeMonoPcm16Wav(new Float32Array(1600), 24000);
    let synthCalls = 0;
    const player = new SpeechPlayer(
      { engine: "vits-wasm", voice: "v0", rate: 1, language: "zh-CN" },
      { onError: () => {} },
      () => ({}) ,
      {},
    );
    player.registerEngine({
      kind: "vits-wasm",
      synthesize: async () => {
        synthCalls += 1;
        return { audio: wav, mime: "audio/wav" };
      },
    });
    const first = await player.exportSentences(["缓存命中测试。"]);
    const second = await player.exportSentences(["缓存命中测试。"]);
    assert.ok(first.wav && second.wav);
    assert.equal(synthCalls, 1, "second export must reuse the cached WAV");
  });
});
