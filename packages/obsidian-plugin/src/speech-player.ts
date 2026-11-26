import {
  type TtsEngine,
  type TtsEngineKind,
  type TtsSynthOptions,
  type TtsSynthResult,
} from "@voice-mode/core";
import {
  PlaybackQueue,
  type AudioSink,
  type PlaybackQueueState,
} from "@voice-mode/browser";

const SYSTEM_TEXT_MIME = "text/plain;charset=utf-8";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const DEFAULT_MAX_QUEUE_SIZE = 2000;
const MIN_WATCHDOG_MS = 15_000;
const MAX_WATCHDOG_MS = 120_000;

export interface SpeechPlayerConfig {
  engine: TtsEngineKind;
  voice: string;
  rate: number;
  language: string;
}

export interface SpeechPlayerHooks {
  onStateChange?: (state: PlaybackQueueState) => void;
  onSentenceStart?: (sentence: string) => void;
  onDrop?: (droppedText: string, reason: "overflow") => void;
  onEngineFallback?: (requested: TtsEngineKind, fallback: "system") => void;
  onError?: (error: unknown, sentence: string) => void;
}

export interface SpeechPlayerOptions {
  maxQueueSize?: number;
  speechWatchdogMs?: number;
}

interface SpeechRuntimeWindow extends Window {
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  URL: typeof URL;
  Audio: typeof Audio;
}

interface ActiveSystemUtterance {
  readonly win: SpeechRuntimeWindow;
  pauseWatchdog(): void;
  resumeWatchdog(): void;
}

interface ActiveBinaryAudio {
  readonly win: SpeechRuntimeWindow;
  readonly audio: HTMLAudioElement;
  readonly objectUrl: string;
  pausedBySink: boolean;
  fail(err: unknown): void;
}

function isAbortDomError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Resolve available system `SpeechSynthesisVoice` entries safely across desktop and mobile WebViews.
 */
export function getSystemVoices(win: Window = window): SpeechSynthesisVoice[] {
  if (typeof win.speechSynthesis === "undefined") {
    return [];
  }
  try {
    return win.speechSynthesis.getVoices();
  } catch {
    return [];
  }
}

function selectSystemVoice(
  voices: readonly SpeechSynthesisVoice[],
  preferredName: string,
  language: string,
): SpeechSynthesisVoice | null {
  if (voices.length === 0) {
    return null;
  }
  const trimmedName = preferredName.trim().toLowerCase();
  if (trimmedName) {
    const exact = voices.find((v) => v.name.toLowerCase() === trimmedName);
    if (exact) {
      return exact;
    }
    const partial = voices.find((v) => v.name.toLowerCase().includes(trimmedName));
    if (partial) {
      return partial;
    }
  }

  const normalizedLang = language.trim().toLowerCase();
  if (normalizedLang) {
    const exactLang = voices.find((v) => v.lang.toLowerCase() === normalizedLang);
    if (exactLang) {
      return exactLang;
    }
    const primarySubtag = normalizedLang.split("-")[0];
    if (primarySubtag) {
      const prefixLang = voices.find((v) => v.lang.toLowerCase().startsWith(primarySubtag));
      if (prefixLang) {
        return prefixLang;
      }
    }
  }

  return voices.find((v) => v.default) ?? voices[0] ?? null;
}

function computeSpeechWatchdogMs(sentence: string, rate: number, overrideMs?: number): number {
  if (typeof overrideMs === "number" && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  const safeRate = Math.min(2.0, Math.max(0.5, rate));
  const estimated = Math.ceil((sentence.length / safeRate) * 450) + 12_000;
  return Math.min(MAX_WATCHDOG_MS, Math.max(MIN_WATCHDOG_MS, estimated));
}

/**
 * Dual-mode audio sink:
 * - Plays `text/plain` payloads directly through browser/system `window.speechSynthesis` (zero config);
 * - Plays encoded binary audio (`audio/wav`, `audio/mpeg`, `audio/ogg`, etc.) from pluggable
 *   `vits-wasm`, `openai-compat`, `kokoro-daemon`, or `mimo` engines via HTMLAudioElement.
 *
 * Captures the originating Window per utterance/clip so popout window focus switches never
 * leak object URLs or fail to stop playback on the originating window.
 */
export class ObsidianAudioSink implements AudioSink {
  private readonly getConfig: () => SpeechPlayerConfig;
  private readonly getWindow: () => SpeechRuntimeWindow;
  private readonly watchdogOverrideMs?: number;

  private activeSynthWindow: SpeechRuntimeWindow | null = null;
  private activeSystemSpeech: ActiveSystemUtterance | null = null;
  private activeBinaryAudio: ActiveBinaryAudio | null = null;

  constructor(
    getConfig: () => SpeechPlayerConfig,
    getWindow: () => Window = () => window,
    speechWatchdogMs?: number,
  ) {
    this.getConfig = getConfig;
    this.getWindow = () => getWindow() as SpeechRuntimeWindow;
    this.watchdogOverrideMs = speechWatchdogMs;
  }

  play(payload: TtsSynthResult, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve();
    }
    if (payload.mime.startsWith("text/plain")) {
      const sentence = TEXT_DECODER.decode(payload.audio);
      return this.playSystemSpeech(sentence, signal);
    }
    return this.playBinaryAudio(payload, signal);
  }

  pause(): void {
    if (this.activeSystemSpeech) {
      this.activeSystemSpeech.pauseWatchdog();
      try {
        this.activeSystemSpeech.win.speechSynthesis?.pause?.();
      } catch {
        // Ignore platform synthesis pause errors.
      }
    } else if (this.activeSynthWindow && typeof this.activeSynthWindow.speechSynthesis !== "undefined") {
      try {
        this.activeSynthWindow.speechSynthesis.pause?.();
      } catch {
        // Ignore platform synthesis pause errors.
      }
    }

    if (this.activeBinaryAudio) {
      this.activeBinaryAudio.pausedBySink = true;
      try {
        this.activeBinaryAudio.audio.pause();
      } catch {
        // Ignore HTMLAudioElement pause errors.
      }
    }
  }

  resume(): void {
    if (this.activeSystemSpeech) {
      this.activeSystemSpeech.resumeWatchdog();
      try {
        this.activeSystemSpeech.win.speechSynthesis?.resume?.();
      } catch {
        // Ignore platform synthesis resume errors.
      }
    } else if (this.activeSynthWindow && typeof this.activeSynthWindow.speechSynthesis !== "undefined") {
      try {
        this.activeSynthWindow.speechSynthesis.resume?.();
      } catch {
        // Ignore platform synthesis resume errors.
      }
    }

    if (this.activeBinaryAudio) {
      const active = this.activeBinaryAudio;
      active.pausedBySink = false;
      void active.audio.play().catch((err: unknown) => {
        if (active.pausedBySink && isAbortDomError(err)) {
          return;
        }
        if (this.activeBinaryAudio === active) {
          active.fail(err);
        }
      });
    }
  }

  stop(): void {
    this.activeSystemSpeech = null;
    const synthWin = this.activeSynthWindow ?? this.getWindow();
    this.activeSynthWindow = null;
    if (typeof synthWin.speechSynthesis !== "undefined") {
      try {
        synthWin.speechSynthesis.cancel();
      } catch {
        // Ignore platform synthesis cancellation errors during teardown.
      }
    }
    this.stopBinaryAudio();
  }

  private playSystemSpeech(sentence: string, signal: AbortSignal): Promise<void> {
    const win = this.getWindow();
    const UtteranceCtor = win.SpeechSynthesisUtterance;
    if (typeof win.speechSynthesis === "undefined" || typeof UtteranceCtor === "undefined") {
      return Promise.reject(new Error("System speech synthesis is unavailable in this environment."));
    }

    const config = this.getConfig();
    const watchdogMs = computeSpeechWatchdogMs(sentence, config.rate, this.watchdogOverrideMs);

    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      let settled = false;
      let watchdogTimer: number | null = null;
      let remainingWatchdogMs = watchdogMs;
      let watchdogArmedAt = 0;
      let watchdogPaused = false;
      this.activeSynthWindow = win;

      const armWatchdog = (): void => {
        if (settled || watchdogPaused) {
          return;
        }
        if (watchdogTimer !== null) {
          win.clearTimeout(watchdogTimer);
        }
        watchdogArmedAt = Date.now();
        watchdogTimer = win.setTimeout(() => {
          watchdogTimer = null;
          try {
            win.speechSynthesis.cancel();
          } catch {
            // Ignore cancel errors on watchdog expiry.
          }
          finish(new Error("Speech synthesis timed out without finishing."));
        }, Math.max(1, remainingWatchdogMs));
      };

      const activeHandle: ActiveSystemUtterance = {
        win,
        pauseWatchdog: () => {
          if (settled || watchdogPaused) {
            return;
          }
          watchdogPaused = true;
          if (watchdogTimer !== null) {
            win.clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
          const elapsed = Math.max(0, Date.now() - watchdogArmedAt);
          remainingWatchdogMs = Math.max(1, remainingWatchdogMs - elapsed);
        },
        resumeWatchdog: () => {
          if (settled || !watchdogPaused) {
            return;
          }
          watchdogPaused = false;
          armWatchdog();
        },
      };
      this.activeSystemSpeech = activeHandle;

      const finish = (err?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (watchdogTimer !== null) {
          win.clearTimeout(watchdogTimer);
          watchdogTimer = null;
        }
        signal.removeEventListener("abort", onAbort);
        if (this.activeSystemSpeech === activeHandle) {
          this.activeSystemSpeech = null;
        }
        if (this.activeSynthWindow === win) {
          this.activeSynthWindow = null;
        }
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const onAbort = (): void => {
        try {
          win.speechSynthesis.cancel();
        } catch {
          // Ignore cancel errors on abort.
        }
        finish();
      };

      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const utterance = new UtteranceCtor(sentence);
        utterance.rate = Math.min(2.0, Math.max(0.5, config.rate));
        utterance.lang = config.language;

        const selectedVoice = selectSystemVoice(
          getSystemVoices(win),
          config.voice,
          config.language,
        );
        if (selectedVoice) {
          utterance.voice = selectedVoice;
        }

        utterance.onend = () => finish();
        utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
          if (signal.aborted || event.error === "canceled" || event.error === "interrupted") {
            finish();
            return;
          }
          finish(new Error(`Speech synthesis error: ${event.error}`));
        };

        armWatchdog();

        if (win.speechSynthesis.paused) {
          win.speechSynthesis.resume();
        }
        win.speechSynthesis.speak(utterance);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private playBinaryAudio(payload: TtsSynthResult, signal: AbortSignal): Promise<void> {
    const win = this.getWindow();
    const copy = new Uint8Array(payload.audio.byteLength);
    copy.set(payload.audio);
    const blob = new Blob([copy.buffer], { type: payload.mime || "audio/wav" });
    const objectUrl = win.URL.createObjectURL(blob);
    const audio = new win.Audio(objectUrl);

    this.stopBinaryAudio();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const activeHandle: ActiveBinaryAudio = {
        win,
        audio,
        objectUrl,
        pausedBySink: false,
        fail: (err: unknown) => {
          finish(err instanceof Error ? err : new Error(String(err)));
        },
      };
      this.activeBinaryAudio = activeHandle;

      const cleanup = (): void => {
        signal.removeEventListener("abort", onAbort);
        audio.onended = null;
        audio.onerror = null;
        if (this.activeBinaryAudio === activeHandle) {
          this.activeBinaryAudio = null;
        }
        win.URL.revokeObjectURL(objectUrl);
      };

      const finish = (err?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const onAbort = (): void => {
        activeHandle.pausedBySink = false;
        audio.pause();
        audio.currentTime = 0;
        finish();
      };

      signal.addEventListener("abort", onAbort, { once: true });
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error("Audio playback failed."));

      audio.play().catch((err: unknown) => {
        if (signal.aborted) {
          finish();
          return;
        }
        if (activeHandle.pausedBySink && isAbortDomError(err)) {
          return;
        }
        finish(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private stopBinaryAudio(): void {
    const active = this.activeBinaryAudio;
    this.activeBinaryAudio = null;
    if (!active) {
      return;
    }
    active.pausedBySink = false;
    try {
      active.audio.pause();
      active.audio.currentTime = 0;
    } catch {
      // Ignore teardown audio pause errors.
    }
    active.win.URL.revokeObjectURL(active.objectUrl);
  }
}

/**
 * Sentence-queued speech player backed by `@voice-mode/browser`'s `PlaybackQueue`.
 * Synchronizes sentence subtitles strictly with actual playback start (`onPlayStart`),
 * preserves long-note ordering (`maxQueueSize: 2000`, `overflowPolicy: "drop-newest"`),
 * and reports fallback explicitly when a selected non-system engine is not mounted.
 */
export class SpeechPlayer {
  private readonly queue: PlaybackQueue;
  private readonly sink: ObsidianAudioSink;
  private readonly engines = new Map<TtsEngineKind, TtsEngine>();
  private readonly hooks: SpeechPlayerHooks;
  private config: SpeechPlayerConfig;
  private fallbackNotifiedForEngine: TtsEngineKind | null = null;
  /**
   * Long-note backpressure (D-0012 A): sentences not yet enqueued. The queue is
   * fed in bounded batches so a long note never overflows and its tail is never
   * dropped; `pendingCount` is checked at every playback start.
   */
  private pendingSentences: string[] = [];
  private static readonly QUEUE_BATCH = 200;
  private static readonly QUEUE_LOW_WATER = 80;

  constructor(
    initialConfig: SpeechPlayerConfig,
    hooks: SpeechPlayerHooks = {},
    getWindow: () => Window = () => window,
    options: SpeechPlayerOptions = {},
  ) {
    this.config = { ...initialConfig };
    this.hooks = hooks;
    this.sink = new ObsidianAudioSink(() => this.config, getWindow, options.speechWatchdogMs);
    this.queue = new PlaybackQueue({
      synthesize: (text, signal) => this.synthesizeSentence(text, signal),
      sink: this.sink,
      prefetchDepth: 2,
      maxQueueSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
      overflowPolicy: "drop-newest",
      onStateChange: (state) => this.hooks.onStateChange?.(state),
      onPlayStart: (text) => {
        this.hooks.onSentenceStart?.(text);
        this.refillQueue();
      },
      onDrop: (droppedText, reason) => this.hooks.onDrop?.(droppedText, reason),
      onError: (err, text) => this.hooks.onError?.(err, text),
    });
  }

  get state(): PlaybackQueueState {
    return this.queue.state;
  }

  get isSpeaking(): boolean {
    return this.queue.state === "playing";
  }

  get isPaused(): boolean {
    return this.queue.state === "paused";
  }

  get isActive(): boolean {
    return this.queue.state === "playing" || this.queue.state === "paused";
  }

  updateConfig(partial: Partial<SpeechPlayerConfig>): void {
    const prevEngine = this.config.engine;
    this.config = {
      ...this.config,
      ...partial,
    };
    if (this.config.engine !== prevEngine) {
      this.fallbackNotifiedForEngine = null;
    }
  }

  /**
   * Mount an optional `TtsEngine` implementation (`vits-wasm`, `openai-compat`, `kokoro-daemon`, `mimo`).
   */
  registerEngine(engine: TtsEngine): void {
    this.engines.set(engine.kind, engine);
    if (this.fallbackNotifiedForEngine === engine.kind) {
      this.fallbackNotifiedForEngine = null;
    }
  }

  unregisterEngine(kind: TtsEngineKind): void {
    this.engines.delete(kind);
  }

  hasRegisteredEngine(kind: TtsEngineKind): boolean {
    return kind === "system" || this.engines.has(kind);
  }

  /**
   * Queue a (possibly long) note for reading. Sentences are fed to the playback
   * queue in bounded batches with backpressure, so the tail is never dropped.
   * Returns the total number of accepted sentences (queued or waiting to be queued).
   */
  speakSentences(sentences: readonly string[]): number {
    this.fallbackNotifiedForEngine = null;
    this.pendingSentences = [];
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (trimmed) {
        this.pendingSentences.push(trimmed);
      }
    }
    const total = this.pendingSentences.length;
    this.refillQueue();
    return total;
  }

  /** Feed the next batch while the playback queue is below its low-water mark. */
  private refillQueue(): number {
    if (this.pendingSentences.length === 0) {
      return 0;
    }
    if (this.queue.state !== "idle" && this.queue.pendingCount > SpeechPlayer.QUEUE_LOW_WATER) {
      return 0;
    }
    const batch = this.pendingSentences.splice(0, SpeechPlayer.QUEUE_BATCH);
    let queued = 0;
    for (const sentence of batch) {
      if (this.queue.enqueue(sentence)) {
        queued += 1;
      }
    }
    return queued;
  }

  pause(): boolean {
    return this.queue.pause();
  }

  resume(): boolean {
    return this.queue.resume();
  }

  togglePause(): boolean {
    if (this.queue.state === "playing") {
      return this.pause();
    }
    if (this.queue.state === "paused") {
      return this.resume();
    }
    return false;
  }

  skipCurrent(): boolean {
    return this.queue.skipCurrent();
  }

  waitUntilDrained(): Promise<void> {
    return this.queue.waitUntilDrained();
  }

  cancel(): void {
    this.pendingSentences = [];
    const activeEngine = this.engines.get(this.config.engine);
    activeEngine?.interrupt?.();
    this.queue.cancel();
  }

  async dispose(): Promise<void> {
    this.cancel();
    this.queue.dispose();
    const closing: Array<Promise<void>> = [];
    for (const engine of this.engines.values()) {
      closing.push(engine.close().catch(() => undefined));
    }
    this.engines.clear();
    await Promise.all(closing);
  }

  private async synthesizeSentence(
    sentence: string,
    signal: AbortSignal,
  ): Promise<TtsSynthResult | null> {
    if (signal.aborted) {
      return null;
    }

    const requestedEngine = this.config.engine;
    const mounted = this.engines.get(requestedEngine);
    if (requestedEngine !== "system" && mounted) {
      const synthOptions: TtsSynthOptions = {
        voice: this.config.voice || undefined,
        rate: this.config.rate,
        signal,
      };
      return mounted.synthesize(sentence, synthOptions);
    }

    if (requestedEngine !== "system" && this.fallbackNotifiedForEngine !== requestedEngine) {
      this.fallbackNotifiedForEngine = requestedEngine;
      this.hooks.onEngineFallback?.(requestedEngine, "system");
    }

    // Zero-config fallback to system speech synthesis so read-aloud works out of the box.
    return {
      audio: TEXT_ENCODER.encode(sentence),
      mime: SYSTEM_TEXT_MIME,
    };
  }
}
