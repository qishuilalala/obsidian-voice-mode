import {
  MODEL_BUNDLES,
  MimoTtsEngine,
  OpenAiCompatTtsEngine,
  buildMemfsSherpaGlue,
  createAsrReplacer,
  isCloudAsrEngine,
  isCloudTtsEngine,
  redactSecrets,
  type TtsEngineKind,
} from "@voice-mode/core";
import {
  AecBargeInMonitor,
  OfflineDictationSession,
  SherpaWorkerClient,
  VitsWasmTtsEngine,
  createSherpaWorkerScript,
  resolveBargeInPolicy,
  type BargeInPolicyDecision,
  type DictationMode,
  type DictationSessionState,
  type PlaybackQueueState,
} from "@voice-mode/browser";
import { MarkdownView, Notice, Platform, Plugin } from "obsidian";
import { getVaultBasePath, openExternalDirectory } from "./desktop-fs.ts";
import {
  extractReadableText,
  insertDictatedText,
  insertIntoFocusedInput,
  isMarkdownEditorFocused,
  resolveDeepActiveElement,
} from "./editor-bridge.ts";
import {
  DesktopModelManager,
  type DictationStackStatus,
  type ModelDownloadProgress,
} from "./model-manager.ts";
import { createObsidianFetchWithCorsFallback } from "./obsidian-http.ts";
import {
  detectRuntimeCapabilities,
  resolveEffectiveAsrEngine,
  resolveEffectiveTtsEngine,
  type RuntimeCapabilities,
} from "./runtime-guard.ts";
import {
  ObsidianSecretStore,
  createDefaultSettings,
  getTtsSecretId,
  hasSecretStorage,
  normalizeSettings,
  stripSecretsFromSettings,
  type VoiceModeSettings,
} from "./settings.ts";
import {
  VoiceModeSettingTab,
  detectDesktopOsHint,
  type VoiceModePluginHost,
} from "./settings-tab.ts";
import { SpeechPlayer } from "./speech-player.ts";

type VoiceStatusKind = "idle" | "listening" | "busy" | "speaking" | "error";

interface BrowserSpeechRecognitionAlternative {
  readonly transcript: string;
}

interface BrowserSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: BrowserSpeechRecognitionAlternative | undefined;
}

interface BrowserSpeechRecognitionEvent {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: BrowserSpeechRecognitionResult | undefined;
  };
}

interface BrowserSpeechRecognitionErrorEvent {
  readonly error: string;
}

interface BrowserSpeechRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  onerror: ((event: BrowserSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

const STATUS_CLASS_MAP: Readonly<Record<VoiceStatusKind, string>> = {
  idle: "vm-is-idle",
  listening: "vm-is-listening",
  busy: "vm-is-busy",
  speaking: "vm-is-speaking",
  error: "vm-is-error",
};

const STATUS_LABEL_MAP: Readonly<Record<VoiceStatusKind, string>> = {
  idle: "Voice idle",
  listening: "Listening",
  busy: "Transcribing",
  speaking: "Reading aloud",
  error: "Voice error",
};

/**
 * Map a BCP-47 locale code to one of SenseVoice's 6 valid language identifiers
 * (`auto`, `zh`, `en`, `ja`, `ko`, `yue`). Using `auto` for Chinese/English locales
 * preserves seamless Mandarin + English code-switching within the same sentence.
 */
export function resolveSenseVoiceLanguage(locale: string): string {
  const normalized = locale.trim().toLowerCase();
  if (normalized.startsWith("ja")) {
    return "ja";
  }
  if (normalized.startsWith("ko")) {
    return "ko";
  }
  if (normalized === "yue" || normalized.startsWith("yue-") || normalized === "zh-hk") {
    return "yue";
  }
  return "auto";
}

function isMicrophonePermissionError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  return (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    /permission denied|not allowed/i.test(message)
  );
}

export default class VoiceModePlugin extends Plugin implements VoiceModePluginHost {
  settings: VoiceModeSettings = createDefaultSettings();
  capabilities: RuntimeCapabilities = detectRuntimeCapabilities(
    Platform.isMobile,
    detectDesktopOsHint(),
  );

  private secretStore: ObsidianSecretStore = new ObsidianSecretStore(null);
  private corsFetch: typeof fetch = createObsidianFetchWithCorsFallback({
    isDesktop: Platform.isDesktop,
  });
  private speechPlayer: SpeechPlayer | null = null;
  private vitsTtsEngine: VitsWasmTtsEngine | null = null;
  private openAiTtsEngine: OpenAiCompatTtsEngine | null = null;
  private mimoTtsEngine: MimoTtsEngine | null = null;
  private httpTtsConfigKey = "";
  private modelManager: DesktopModelManager | null = null;
  private modelManagerConfigKey = "";
  private workerClient: SherpaWorkerClient | null = null;
  private bargeInWorkerClient: SherpaWorkerClient | null = null;
  private offlineSession: OfflineDictationSession | null = null;
  private bargeInMonitor: AecBargeInMonitor | null = null;
  private bargeInStateEpoch = 0;
  private lastBargeInDecision: BargeInPolicyDecision | null = null;
  private aecDowngradeNotified = false;
  private downloadAbortController: AbortController | null = null;

  private statusBarEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private subtitleOverlayEl: HTMLElement | null = null;
  private subtitleCardEl: HTMLElement | null = null;
  private subtitleRoleEl: HTMLElement | null = null;
  private subtitleControlsEl: HTMLElement | null = null;
  private subtitlePauseBtnEl: HTMLButtonElement | null = null;
  private subtitleTextEl: HTMLElement | null = null;
  private subtitleHideTimer: number | null = null;
  private activeRecognition: BrowserSpeechRecognition | null = null;
  private listening = false;
  private startingDictation = false;
  private dictationStartEpoch = 0;
  private readAloudStartEpoch = 0;
  private readingNotePath: string | null = null;
  private pointerHoldActive = false;
  private recognitionErrored = false;
  private overflowNotified = false;
  private currentStatus: VoiceStatusKind = "idle";

  async onload(): Promise<void> {
    this.capabilities = detectRuntimeCapabilities(Platform.isMobile, detectDesktopOsHint());
    this.secretStore = new ObsidianSecretStore(
      hasSecretStorage(this.app) ? this.app.secretStorage : null,
    );
    this.corsFetch = createObsidianFetchWithCorsFallback({ isDesktop: Platform.isDesktop });
    await this.loadSettings();

    const effectiveTts = this.getEffectiveTtsEngine();
    this.speechPlayer = new SpeechPlayer(
      {
        engine: effectiveTts,
        voice: this.settings.ttsVoice,
        rate: this.settings.speechRate,
        language: this.settings.dictationLanguage,
      },
      {
        onStateChange: (state) => {
          this.handlePlaybackStateChange(state);
        },
        onSentenceStart: (sentence) => {
          this.showSubtitleOverlay("Reading aloud", sentence, undefined, true);
        },
        onEngineFallback: (requested) => {
          if (requested === "kokoro-daemon") {
            new Notice(
              "Local Kokoro voice daemon is not connected; falling back to system speech synthesis.",
            );
            return;
          }
          new Notice(
            `Speech engine "${requested}" is unavailable; falling back to system speech synthesis.`,
          );
        },
        onDrop: () => {
          if (!this.overflowNotified) {
            this.overflowNotified = true;
            new Notice(
              "Selection exceeds the 2,000-sentence read-aloud queue limit; trailing sentences were omitted.",
            );
          }
        },
        onError: (err) => {
          const message = redactSecrets(err instanceof Error ? err.message : String(err));
          this.stopReadAloudSilently();
          this.setStatus("error");
          new Notice(`Read-aloud failed: ${message}`);
        },
      },
      () => activeWindow,
    );
    this.syncSpeechPlayerEngines(true);

    this.mountStatusBar();
    this.mountSubtitleOverlay(activeDocument);

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (!this.settings.stopReadAloudOnNoteSwitch || !this.speechPlayer?.isActive) {
          return;
        }
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        const activePath = activeView?.file?.path ?? null;
        if (activePath !== this.readingNotePath) {
          this.stopReadAloudSilently();
        }
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!this.settings.stopReadAloudOnNoteSwitch || !this.speechPlayer?.isActive) {
          return;
        }
        const nextPath = file?.path ?? null;
        if (nextPath !== this.readingNotePath) {
          this.stopReadAloudSilently();
        }
      }),
    );

    this.registerDomEvent(window, "pagehide", () => {
      if (this.speechPlayer?.isActive) {
        this.stopReadAloudSilently();
      }
    });

    this.addRibbonIcon("mic", "Toggle voice dictation", () => {
      void this.toggleDictation();
    });

    this.addCommand({
      id: "toggle-dictation",
      name: "Toggle voice dictation",
      callback: () => {
        void this.toggleDictation();
      },
    });

    this.addCommand({
      id: "dictate-single-utterance",
      name: "Dictate single utterance",
      callback: () => {
        void this.toggleDictation("single");
      },
    });

    this.addCommand({
      id: "read-aloud",
      name: "Read selection or note aloud",
      callback: () => {
        void this.readSelectionOrNoteAloud();
      },
    });

    this.addCommand({
      id: "pause-resume-read-aloud",
      name: "Pause or resume read-aloud",
      callback: () => {
        this.togglePauseReadAloud();
      },
    });

    this.addCommand({
      id: "skip-read-aloud-sentence",
      name: "Skip current read-aloud sentence",
      callback: () => {
        this.skipReadAloudSentence();
      },
    });

    this.addCommand({
      id: "stop-read-aloud",
      name: "Stop read-aloud",
      callback: () => {
        this.stopReadAloud();
      },
    });

    this.addCommand({
      id: "check-runtime-status",
      name: "Check voice runtime status",
      callback: () => {
        void this.showRuntimeStatusNotice();
      },
    });

    this.addSettingTab(new VoiceModeSettingTab(this.app, this));
  }

  onunload(): void {
    this.dictationStartEpoch += 1;
    this.readAloudStartEpoch += 1;
    this.bargeInStateEpoch += 1;
    this.readingNotePath = null;
    this.startingDictation = false;
    this.pointerHoldActive = false;
    this.cancelModelDownload();
    this.stopBrowserRecognition();
    this.clearSubtitleHideTimer();

    if (this.bargeInMonitor) {
      void this.bargeInMonitor.stop();
      this.bargeInMonitor = null;
    }

    if (this.offlineSession) {
      void this.offlineSession.abort();
      this.offlineSession = null;
    }

    this.vitsTtsEngine = null;
    this.openAiTtsEngine = null;
    this.mimoTtsEngine = null;
    this.httpTtsConfigKey = "";

    if (this.speechPlayer) {
      void this.speechPlayer.dispose();
      this.speechPlayer = null;
    }

    if (this.workerClient) {
      void this.workerClient.dispose();
      this.workerClient = null;
    }

    if (this.bargeInWorkerClient) {
      void this.bargeInWorkerClient.dispose();
      this.bargeInWorkerClient = null;
    }

    this.modelManager = null;

    if (this.subtitleOverlayEl) {
      this.subtitleOverlayEl.remove();
      this.subtitleOverlayEl = null;
      this.subtitleCardEl = null;
      this.subtitleRoleEl = null;
      this.subtitleControlsEl = null;
      this.subtitlePauseBtnEl = null;
      this.subtitleTextEl = null;
    }

    this.statusBarEl = null;
    this.statusLabelEl = null;
    this.secretStore = new ObsidianSecretStore(null);
  }

  async loadSettings(): Promise<void> {
    const raw: unknown = await this.loadData();
    Object.assign(this.settings, normalizeSettings(raw));
  }

  async saveSettings(): Promise<void> {
    const normalized = normalizeSettings(stripSecretsFromSettings(this.settings));
    Object.assign(this.settings, normalized);
    await this.saveData(stripSecretsFromSettings(this.settings));

    this.lastBargeInDecision = null;
    this.applySubtitleCardModifiers();

    if (this.speechPlayer) {
      const effectiveTts = this.getEffectiveTtsEngine();
      this.speechPlayer.updateConfig({
        engine: effectiveTts,
        voice: this.settings.ttsVoice,
        rate: this.settings.speechRate,
        language: this.settings.dictationLanguage,
      });
      this.syncSpeechPlayerEngines();
      if (this.bargeInMonitor) {
        this.bargeInMonitor.updateMode(this.settings.bargeInMode);
      }
      if (this.speechPlayer.state === "playing") {
        void this.syncBargeInForPlaybackState("playing");
      }
    }

    const resolvedLanguage = resolveSenseVoiceLanguage(this.settings.dictationLanguage);

    if (this.offlineSession) {
      this.offlineSession.updateEndpointPolicy({ silenceMs: this.settings.endpointSilenceMs });
      this.offlineSession.updateLanguage(resolvedLanguage);
    }

    if (this.workerClient) {
      this.workerClient.updateModelConfig("asr-offline", {
        language: resolvedLanguage,
        useItn: true,
      });
      this.workerClient.updateIdleUnloadMs(this.resolveWorkerIdleUnloadMs());
    }

    if (this.bargeInWorkerClient) {
      this.bargeInWorkerClient.updateIdleUnloadMs(this.resolveWorkerIdleUnloadMs());
    }

    if (!this.settings.enableSubtitleOverlay) {
      this.hideSubtitleOverlay();
    }
  }

  getVaultBasePath(): string | null {
    return getVaultBasePath(this.app.vault.adapter as { getBasePath?: () => string });
  }

  getBargeInDecision(): BargeInPolicyDecision | null {
    return this.lastBargeInDecision;
  }

  async getModelStatus(): Promise<DictationStackStatus | null> {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      return null;
    }
    return manager.checkStatus();
  }

  isDownloadingModels(): boolean {
    return this.downloadAbortController !== null;
  }

  async startModelDownload(
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<DictationStackStatus> {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      throw new Error("Local offline WASM models are only available on desktop.");
    }
    if (this.downloadAbortController) {
      return manager.downloadDictationStack({
        signal: this.downloadAbortController.signal,
        onProgress,
      });
    }

    const controller = new AbortController();
    this.downloadAbortController = controller;
    try {
      const status = await manager.downloadDictationStack({
        signal: controller.signal,
        onProgress,
      });
      if (status.ready && this.settings.asrEngine === "system") {
        this.settings.asrEngine = "sensevoice-wasm";
        await this.saveSettings();
        new Notice(
          "Offline dictation models verified and ready. Switched recognition engine to SenseVoice WASM.",
        );
      } else if (status.ready) {
        new Notice("Offline dictation models verified and ready.");
      }
      return status;
    } finally {
      if (this.downloadAbortController === controller) {
        this.downloadAbortController = null;
      }
    }
  }

  async startVitsModelDownload(
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<DictationStackStatus> {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      throw new Error("Local offline WASM models are only available on desktop.");
    }
    if (this.downloadAbortController) {
      return manager.downloadVitsStack({
        signal: this.downloadAbortController.signal,
        onProgress,
      });
    }

    const controller = new AbortController();
    this.downloadAbortController = controller;
    try {
      const status = await manager.downloadVitsStack({
        signal: controller.signal,
        onProgress,
      });
      if (status.vitsReady && this.settings.ttsEngine === "system") {
        this.settings.ttsEngine = "vits-wasm";
        await this.saveSettings();
        new Notice(
          "Optional local VITS model verified and ready. Switched speech engine to VITS WASM.",
        );
      } else if (status.vitsReady) {
        new Notice("Optional local VITS model verified and ready.");
      }
      return status;
    } finally {
      if (this.downloadAbortController === controller) {
        this.downloadAbortController = null;
      }
    }
  }

  cancelModelDownload(): void {
    if (this.downloadAbortController) {
      this.downloadAbortController.abort();
      this.downloadAbortController = null;
    }
  }

  async clearCachedModels(): Promise<void> {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      return;
    }
    this.dictationStartEpoch += 1;
    this.readAloudStartEpoch += 1;
    this.bargeInStateEpoch += 1;
    this.startingDictation = false;
    this.pointerHoldActive = false;
    if (this.speechPlayer?.isActive) {
      this.stopReadAloudSilently();
    }
    if (this.bargeInMonitor) {
      await this.bargeInMonitor.stop();
    }
    if (this.offlineSession && this.offlineSession.state !== "idle") {
      await this.offlineSession.abort();
    }
    if (this.workerClient) {
      await this.workerClient.unload();
    }
    if (this.bargeInWorkerClient) {
      await this.bargeInWorkerClient.unload();
    }
    await manager.clearCachedModels();
    new Notice("Cleared cached offline speech models outside the vault.");
  }

  async openModelCacheFolder(): Promise<void> {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      return;
    }
    await openExternalDirectory(manager.resolveCacheDir(), { isDesktop: Platform.isDesktop });
  }

  private getEffectiveAsrEngine() {
    return resolveEffectiveAsrEngine(
      this.settings.asrEngine,
      this.capabilities,
      this.settings.allowCloudFallbackOnMobile,
    );
  }

  private getEffectiveTtsEngine(): TtsEngineKind {
    return resolveEffectiveTtsEngine(
      this.settings.ttsEngine,
      this.capabilities,
      this.settings.allowCloudFallbackOnMobile,
    );
  }

  private resolveWorkerIdleUnloadMs(): number {
    return this.settings.workerIdleUnloadMinutes > 0
      ? this.settings.workerIdleUnloadMinutes * 60_000
      : 0;
  }

  private ensureDesktopModelManager(): DesktopModelManager | null {
    if (!this.capabilities.allowLocalWasmModels || !Platform.isDesktop) {
      return null;
    }
    const vaultBasePath = this.getVaultBasePath();
    const configKey = JSON.stringify([
      this.settings.customModelCacheDir,
      this.settings.modelMirrorHost,
      vaultBasePath,
    ]);
    if (this.modelManager && this.modelManagerConfigKey === configKey) {
      return this.modelManager;
    }

    if (this.bargeInMonitor) {
      void this.bargeInMonitor.stop();
      this.bargeInMonitor = null;
    }

    if (this.vitsTtsEngine) {
      void this.vitsTtsEngine.close();
      this.vitsTtsEngine = null;
    }

    if (this.workerClient) {
      void this.workerClient.dispose();
      this.workerClient = null;
      this.offlineSession = null;
    }

    if (this.bargeInWorkerClient) {
      void this.bargeInWorkerClient.dispose();
      this.bargeInWorkerClient = null;
    }

    this.modelManagerConfigKey = configKey;
    this.modelManager = new DesktopModelManager({
      customCacheDir: this.settings.customModelCacheDir,
      vaultBasePath,
      preferredModelHost: this.settings.modelMirrorHost,
      vitsBundle: MODEL_BUNDLES["vits-zh-ll"],
    });
    return this.modelManager;
  }

  private ensureSherpaWorkerClient(): SherpaWorkerClient | null {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      return null;
    }

    if (!this.workerClient) {
      this.workerClient = new SherpaWorkerClient({
        createWorkerSource: async () => {
          const glue = await manager.readWasmGlueTexts();
          return createSherpaWorkerScript(buildMemfsSherpaGlue(glue));
        },
        loadModelBinaries: (target, includeWasm) => manager.readTargetBinaries(target, includeWasm),
        modelConfigs: {
          "asr-offline": {
            language: resolveSenseVoiceLanguage(this.settings.dictationLanguage),
            useItn: true,
          },
        },
        idleUnloadMs: this.resolveWorkerIdleUnloadMs(),
      });
    }

    return this.workerClient;
  }

  private syncSpeechPlayerEngines(forceRecreateHttp = false): void {
    if (!this.speechPlayer) {
      return;
    }

    const workerClient = this.ensureSherpaWorkerClient();
    if (workerClient) {
      if (!this.vitsTtsEngine) {
        this.vitsTtsEngine = new VitsWasmTtsEngine({
          workerClient,
          voice: this.settings.ttsVoice || undefined,
          rate: this.settings.speechRate,
          disposeWorkerOnClose: false,
        });
      } else {
        this.vitsTtsEngine.updateVoice(
          this.settings.ttsVoice || "suyingxue",
          this.settings.speechRate,
        );
      }
      this.speechPlayer.registerEngine(this.vitsTtsEngine);
    } else if (this.vitsTtsEngine) {
      void this.vitsTtsEngine.close();
      this.vitsTtsEngine = null;
      this.speechPlayer.unregisterEngine("vits-wasm");
    }

    const nextHttpKey = JSON.stringify([
      this.settings.ttsPresetId,
      this.settings.ttsEndpointUrl,
      this.settings.ttsModel,
      this.settings.ttsVoice,
    ]);

    if (
      forceRecreateHttp ||
      nextHttpKey !== this.httpTtsConfigKey ||
      !this.openAiTtsEngine ||
      !this.mimoTtsEngine
    ) {
      const prevOpenAi = this.openAiTtsEngine;
      const prevMimo = this.mimoTtsEngine;

      this.openAiTtsEngine = new OpenAiCompatTtsEngine({
        presetId: this.settings.ttsPresetId,
        baseUrl: this.settings.ttsEndpointUrl || undefined,
        model: this.settings.ttsModel || undefined,
        voice: this.settings.ttsVoice || undefined,
        apiKey: () => {
          const secretId = getTtsSecretId(
            this.settings,
            "openai-compat",
            this.settings.ttsPresetId,
          );
          return secretId ? this.secretStore.getSecret(secretId) : null;
        },
        fetchImpl: this.corsFetch,
      });

      this.mimoTtsEngine = new MimoTtsEngine({
        baseUrl: this.settings.ttsEndpointUrl || undefined,
        model: this.settings.ttsModel || undefined,
        voice: this.settings.ttsVoice || undefined,
        apiKey: () => {
          const secretId = getTtsSecretId(this.settings, "mimo");
          return secretId ? this.secretStore.getSecret(secretId) : null;
        },
        fetchImpl: this.corsFetch,
      });

      this.speechPlayer.registerEngine(this.openAiTtsEngine);
      this.speechPlayer.registerEngine(this.mimoTtsEngine);
      this.httpTtsConfigKey = nextHttpKey;

      if (!this.speechPlayer.isActive) {
        void prevOpenAi?.close().catch(() => undefined);
        void prevMimo?.close().catch(() => undefined);
      }
    }
  }

  private ensureBargeInWorkerClient(): SherpaWorkerClient | null {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      return null;
    }

    if (!this.bargeInWorkerClient) {
      this.bargeInWorkerClient = new SherpaWorkerClient({
        createWorkerSource: async () => {
          const glue = await manager.readWasmGlueTexts();
          return createSherpaWorkerScript(buildMemfsSherpaGlue(glue));
        },
        loadModelBinaries: (target, includeWasm) => manager.readTargetBinaries(target, includeWasm),
        modelConfigs: {
          vad: {
            threshold: 0.35,
            minSpeechDuration: 0.12,
            minSilenceDuration: 0.35,
          },
        },
        idleUnloadMs: this.resolveWorkerIdleUnloadMs(),
      });
    }

    return this.bargeInWorkerClient;
  }

  private ensureBargeInMonitor(): AecBargeInMonitor | null {
    const vadWorkerClient = this.ensureBargeInWorkerClient();
    if (!vadWorkerClient) {
      return null;
    }
    if (!this.bargeInMonitor) {
      this.bargeInMonitor = new AecBargeInMonitor({
        workerClient: vadWorkerClient,
        bargeInMode: this.settings.bargeInMode,
        isSafari: Platform.isSafari,
        isMobile: this.capabilities.isMobile,
        onBargeIn: () => {
          this.readingNotePath = null;
          this.speechPlayer?.cancel();
          this.hideSubtitleOverlay();
          if (!this.isDictationBusy() && this.currentStatus !== "error") {
            this.setStatus("idle");
          }
          new Notice("Read-aloud interrupted by voice.");
        },
        onDowngrade: (decision) => {
          this.lastBargeInDecision = decision;
          if (decision.reason === "native-aec-inactive" && !this.aecDowngradeNotified) {
            this.aecDowngradeNotified = true;
            new Notice(
              "Native echo cancellation is inactive on the current audio device; hands-free barge-in downgraded to manual stop.",
            );
          }
        },
        onError: () => {
          // Optional hands-free barge-in degrades quietly to manual stop if mic capture is unavailable.
        },
      });
    }
    return this.bargeInMonitor;
  }

  private handlePlaybackStateChange(state: PlaybackQueueState): void {
    if (state === "playing") {
      this.setStatus("speaking");
      if (this.subtitleRoleEl?.getText() === "Read-aloud paused") {
        this.subtitleRoleEl.setText("Reading aloud");
      }
      this.updateSubtitlePlaybackControls(true, false);
      void this.syncBargeInForPlaybackState("playing");
      return;
    }

    if (state === "paused") {
      void this.syncBargeInForPlaybackState("paused");
      this.setStatus("speaking", "Read-aloud paused");
      this.subtitleRoleEl?.setText("Read-aloud paused");
      this.updateSubtitlePlaybackControls(true, true);
      return;
    }

    void this.syncBargeInForPlaybackState(state);
    this.readingNotePath = null;
    this.updateSubtitlePlaybackControls(false, false);
    if (!this.isDictationBusy() && this.currentStatus !== "error") {
      this.setStatus("idle");
      this.hideSubtitleOverlay();
    }
  }

  private async syncBargeInForPlaybackState(state: PlaybackQueueState): Promise<void> {
    const epoch = ++this.bargeInStateEpoch;
    if (state !== "playing") {
      await this.bargeInMonitor?.stop();
      return;
    }

    const effectiveTts = this.getEffectiveTtsEngine();
    const usesSystemTts =
      effectiveTts === "system" || !this.speechPlayer?.hasRegisteredEngine(effectiveTts);

    if (
      usesSystemTts ||
      this.settings.bargeInMode === "manual" ||
      !this.capabilities.allowLocalWasmModels
    ) {
      this.lastBargeInDecision = resolveBargeInPolicy({
        requestedMode: this.settings.bargeInMode,
        usesSystemTts,
        isMobile: this.capabilities.isMobile,
        isSafari: Platform.isSafari,
        nativeAecActive: false,
      });
      await this.bargeInMonitor?.stop();
      return;
    }

    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      await this.bargeInMonitor?.stop();
      return;
    }

    const status = await manager.checkStatus().catch(() => null);
    if (epoch !== this.bargeInStateEpoch || this.speechPlayer?.state !== "playing") {
      return;
    }
    if (!status || !status.vadReady || !status.wasmReady) {
      await this.bargeInMonitor?.stop();
      return;
    }

    const monitor = this.ensureBargeInMonitor();
    if (!monitor) {
      return;
    }

    try {
      const res = await monitor.start({
        bargeInMode: this.settings.bargeInMode,
        usesSystemTts: false,
        isSafari: Platform.isSafari,
        isMobile: this.capabilities.isMobile,
      });
      if (epoch !== this.bargeInStateEpoch || this.speechPlayer?.state !== "playing") {
        await monitor.stop();
        return;
      }
      this.lastBargeInDecision = {
        policy: res.activePolicy,
        reason: res.reason,
        allowHandsFreeBargeIn: res.activePolicy === "auto",
      };
    } catch {
      await monitor.stop();
    }
  }

  private ensureOfflineDictationSession(): OfflineDictationSession | null {
    const workerClient = this.ensureSherpaWorkerClient();
    if (!workerClient) {
      return null;
    }

    if (!this.offlineSession) {
      this.offlineSession = new OfflineDictationSession({
        workerClient,
        endpointPolicy: {
          silenceMs: this.settings.endpointSilenceMs,
        },
        language: resolveSenseVoiceLanguage(this.settings.dictationLanguage),
        onStateChange: (state) => {
          this.handleOfflineStateChange(state);
        },
        onSpeechActivity: (isSpeech) => {
          if (this.offlineSession?.state === "listening") {
            this.showSubtitleOverlay(
              "Offline dictation",
              isSpeech ? "Listening (speech detected)..." : "Listening...",
            );
          }
        },
        onFinalTranscript: (rawText) => {
          const replacer = createAsrReplacer(this.settings.asrReplacements);
          const committed = replacer(rawText).trim();
          if (committed) {
            this.commitDictatedText(committed);
            this.showSubtitleOverlay("Inserted", committed, 2400);
          }
        },
        onError: (err) => {
          this.listening = false;
          this.setStatus("error");
          this.hideSubtitleOverlay();
          if (isMicrophonePermissionError(err)) {
            new Notice(
              "Microphone permission was denied. Grant microphone access to Obsidian in your OS privacy settings and try again.",
              7000,
            );
            return;
          }
          const message = redactSecrets(err.message || String(err));
          new Notice(`Offline dictation error: ${message}`);
        },
      });
    }

    this.offlineSession.updateEndpointPolicy({ silenceMs: this.settings.endpointSilenceMs });
    this.offlineSession.updateLanguage(resolveSenseVoiceLanguage(this.settings.dictationLanguage));
    return this.offlineSession;
  }

  private handleOfflineStateChange(state: DictationSessionState): void {
    switch (state) {
      case "starting":
        this.listening = true;
        this.setStatus("busy", "Loading model");
        this.showSubtitleOverlay("Offline dictation", "Loading local SenseVoice model...");
        break;
      case "listening":
        this.listening = true;
        this.setStatus("listening");
        this.showSubtitleOverlay(
          "Offline dictation",
          this.offlineSession?.mode === "push-to-talk"
            ? "Push to talk active — speak now..."
            : "Listening...",
        );
        break;
      case "transcribing":
      case "stopping":
        this.listening = false;
        this.setStatus("busy", "Transcribing");
        this.showSubtitleOverlay("Offline dictation", "Transcribing offline...");
        break;
      case "idle":
        this.listening = false;
        if (!this.speechPlayer?.isActive && this.currentStatus !== "error") {
          this.setStatus("idle");
        }
        break;
    }
  }

  private isDictationBusy(): boolean {
    if (this.startingDictation || this.listening) {
      return true;
    }
    const state = this.offlineSession?.state;
    return state !== undefined && state !== "idle";
  }

  private clearSubtitleHideTimer(): void {
    if (this.subtitleHideTimer !== null) {
      window.clearTimeout(this.subtitleHideTimer);
      this.subtitleHideTimer = null;
    }
  }

  private mountStatusBar(): void {
    if (Platform.isMobile) {
      return;
    }
    const item = this.addStatusBarItem();
    item.addClass("vm-status-bar", STATUS_CLASS_MAP.idle);
    const badge = item.createSpan({ cls: "vm-status-badge" });
    badge.createSpan({ cls: "vm-status-dot" });
    this.statusLabelEl = badge.createSpan({
      cls: "vm-status-label",
      text: STATUS_LABEL_MAP.idle,
    });
    this.statusBarEl = item;

    const releasePointerHold = (): void => {
      if (!this.pointerHoldActive) {
        return;
      }
      this.pointerHoldActive = false;
      if (this.startingDictation) {
        this.dictationStartEpoch += 1;
        this.startingDictation = false;
      }
      if (this.offlineSession && this.offlineSession.state !== "idle") {
        void this.offlineSession.stop({ flush: true });
      }
    };

    this.registerDomEvent(item, "pointerdown", (ev: PointerEvent) => {
      if (ev.button !== 0 || this.speechPlayer?.isActive) {
        return;
      }
      if (this.settings.dictationMode === "push-to-talk" && !this.isDictationBusy()) {
        this.pointerHoldActive = true;
        void this.toggleDictation("push-to-talk", true);
      }
    });

    this.registerDomEvent(window, "pointerup", releasePointerHold);
    this.registerDomEvent(window, "pointercancel", releasePointerHold);
    this.registerDomEvent(window, "blur", releasePointerHold);

    this.registerDomEvent(item, "click", () => {
      if (this.speechPlayer?.isActive) {
        this.stopReadAloud();
        return;
      }
      if (this.settings.dictationMode === "push-to-talk") {
        return;
      }
      void this.toggleDictation();
    });
  }

  private mountSubtitleOverlay(targetDoc: Document): void {
    if (this.subtitleOverlayEl) {
      this.subtitleOverlayEl.remove();
      this.subtitleOverlayEl = null;
      this.subtitleCardEl = null;
      this.subtitleRoleEl = null;
      this.subtitleControlsEl = null;
      this.subtitlePauseBtnEl = null;
      this.subtitleTextEl = null;
    }
    const body = targetDoc.body;
    if (!body) {
      return;
    }
    const overlay = body.createDiv({ cls: "vm-subtitle-overlay vm-subtitle-hidden" });
    const card = overlay.createDiv({ cls: "vm-subtitle-card" });
    const header = card.createDiv({ cls: "vm-subtitle-header" });
    this.subtitleRoleEl = header.createSpan({ cls: "vm-subtitle-role" });

    const controls = header.createDiv({ cls: "vm-subtitle-controls vm-subtitle-hidden" });
    const pauseBtn = controls.createEl("button", {
      cls: "vm-subtitle-btn",
      text: "Pause",
    });
    pauseBtn.type = "button";
    const nextBtn = controls.createEl("button", {
      cls: "vm-subtitle-btn",
      text: "Next",
    });
    nextBtn.type = "button";
    const stopBtn = controls.createEl("button", {
      cls: "vm-subtitle-btn",
      text: "Stop",
    });
    stopBtn.type = "button";

    pauseBtn.addEventListener("click", (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.togglePauseReadAloud();
    });
    nextBtn.addEventListener("click", (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.skipReadAloudSentence();
    });
    stopBtn.addEventListener("click", (ev: MouseEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.stopReadAloud();
    });

    this.subtitleTextEl = card.createDiv({ cls: "vm-subtitle-text" });
    this.subtitleCardEl = card;
    this.subtitleControlsEl = controls;
    this.subtitlePauseBtnEl = pauseBtn;
    this.subtitleOverlayEl = overlay;
    this.applySubtitleCardModifiers();
  }

  private applySubtitleCardModifiers(): void {
    if (!this.subtitleCardEl) {
      return;
    }
    for (const size of ["small", "medium", "large"] as const) {
      this.subtitleCardEl.removeClass(`vm-subtitle-size-${size}`);
    }
    for (const width of ["narrow", "medium", "wide"] as const) {
      this.subtitleCardEl.removeClass(`vm-subtitle-width-${width}`);
    }
    this.subtitleCardEl.addClass(`vm-subtitle-size-${this.settings.subtitleFontSize}`);
    this.subtitleCardEl.addClass(`vm-subtitle-width-${this.settings.subtitleWidth}`);
  }

  private updateSubtitlePlaybackControls(visible: boolean, isPaused: boolean): void {
    if (!this.subtitleControlsEl || !this.subtitlePauseBtnEl) {
      return;
    }
    if (visible) {
      this.subtitleControlsEl.removeClass("vm-subtitle-hidden");
      this.subtitlePauseBtnEl.setText(isPaused ? "Resume" : "Pause");
    } else {
      this.subtitleControlsEl.addClass("vm-subtitle-hidden");
    }
  }

  private setStatus(next: VoiceStatusKind, labelOverride?: string): void {
    this.currentStatus = next;
    if (!this.statusBarEl || !this.statusLabelEl) {
      return;
    }
    for (const cls of Object.values(STATUS_CLASS_MAP)) {
      this.statusBarEl.removeClass(cls);
    }
    this.statusBarEl.addClass(STATUS_CLASS_MAP[next]);
    this.statusLabelEl.setText(labelOverride ?? STATUS_LABEL_MAP[next]);
  }

  private showSubtitleOverlay(
    role: string,
    text: string,
    autoHideMs?: number,
    showReadAloudControls = false,
  ): void {
    if (!this.settings.enableSubtitleOverlay) {
      return;
    }
    if (!this.subtitleOverlayEl || this.subtitleOverlayEl.ownerDocument !== activeDocument) {
      this.mountSubtitleOverlay(activeDocument);
    }
    if (!this.subtitleOverlayEl) {
      return;
    }
    this.clearSubtitleHideTimer();
    this.applySubtitleCardModifiers();
    this.subtitleRoleEl?.setText(role);
    this.subtitleTextEl?.setText(text);
    this.updateSubtitlePlaybackControls(
      showReadAloudControls && Boolean(this.speechPlayer?.isActive),
      Boolean(this.speechPlayer?.isPaused),
    );
    this.subtitleOverlayEl.removeClass("vm-subtitle-visible");
    this.subtitleOverlayEl.removeClass("vm-subtitle-hidden");
    this.subtitleOverlayEl.addClass("vm-subtitle-visible");

    if (autoHideMs && autoHideMs > 0) {
      this.subtitleHideTimer = window.setTimeout(() => {
        this.subtitleHideTimer = null;
        this.hideSubtitleOverlay();
      }, autoHideMs);
    }
  }

  private hideSubtitleOverlay(): void {
    this.clearSubtitleHideTimer();
    this.updateSubtitlePlaybackControls(false, false);
    if (!this.subtitleOverlayEl) {
      return;
    }
    this.subtitleOverlayEl.removeClass("vm-subtitle-visible");
    this.subtitleOverlayEl.addClass("vm-subtitle-hidden");
  }

  async toggleDictation(modeOverride?: DictationMode, fromPointerHold = false): Promise<void> {
    if (this.startingDictation) {
      this.dictationStartEpoch += 1;
      this.startingDictation = false;
      this.pointerHoldActive = false;
      if (this.offlineSession && this.offlineSession.state !== "idle") {
        await this.offlineSession.stop({ flush: false });
      }
      if (!this.speechPlayer?.isActive && this.currentStatus !== "error") {
        this.setStatus("idle");
        this.hideSubtitleOverlay();
      }
      new Notice("Offline voice dictation stopped.");
      return;
    }

    if (this.offlineSession && this.offlineSession.state !== "idle") {
      this.pointerHoldActive = false;
      await this.offlineSession.stop({ flush: true });
      new Notice("Offline voice dictation stopped.");
      return;
    }

    if (this.activeRecognition || this.listening) {
      this.stopBrowserRecognition();
      new Notice("Voice dictation stopped.");
      return;
    }

    if (
      this.capabilities.isMobile &&
      !this.settings.allowCloudFallbackOnMobile &&
      this.settings.asrEngine !== "system" &&
      isCloudAsrEngine(this.settings.asrEngine)
    ) {
      new Notice(
        "Cloud speech recognition is disabled on mobile by privacy settings; using system speech recognition.",
      );
    }

    const effectiveAsr = this.getEffectiveAsrEngine();
    const mode = modeOverride ?? this.settings.dictationMode;

    if (effectiveAsr === "sensevoice-wasm") {
      await this.startOfflineSenseVoiceDictation(mode, fromPointerHold);
      return;
    }

    if (effectiveAsr !== "system") {
      new Notice(
        `Speech recognition engine "${effectiveAsr}" is scheduled for a subsequent milestone. Choose SenseVoice WASM on desktop for offline dictation.`,
      );
      return;
    }

    await this.startBrowserSpeechRecognitionFallback();
  }

  private async startOfflineSenseVoiceDictation(
    mode: DictationMode,
    fromPointerHold: boolean,
  ): Promise<void> {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      this.pointerHoldActive = false;
      new Notice("Local offline WASM dictation is disabled on mobile devices.");
      return;
    }

    const startEpoch = ++this.dictationStartEpoch;
    this.startingDictation = true;

    try {
      let status: DictationStackStatus;
      try {
        status = await manager.checkStatus();
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        new Notice(`Could not verify external model cache: ${msg}`);
        return;
      }

      if (startEpoch !== this.dictationStartEpoch || (fromPointerHold && !this.pointerHoldActive)) {
        return;
      }

      if (!status.ready) {
        this.pointerHoldActive = false;
        new Notice(
          "Offline dictation models are not installed yet. Open Voice Mode settings to download and verify them.",
          7000,
        );
        return;
      }

      const session = this.ensureOfflineDictationSession();
      if (!session) {
        this.pointerHoldActive = false;
        return;
      }

      // Stop active read-aloud and release any AEC barge-in mic capture before opening dictation mic.
      this.stopReadAloudSilently();
      if (this.bargeInMonitor) {
        await this.bargeInMonitor.stop();
      }
      if (startEpoch !== this.dictationStartEpoch || (fromPointerHold && !this.pointerHoldActive)) {
        return;
      }

      try {
        await session.start(mode);
      } catch {
        this.pointerHoldActive = false;
        // Detailed error Notice is already surfaced via OfflineDictationSession.onError.
        return;
      }

      if (startEpoch !== this.dictationStartEpoch || (fromPointerHold && !this.pointerHoldActive)) {
        await session.stop({ flush: true });
        return;
      }

      new Notice(
        mode === "single"
          ? "Offline dictation started (single utterance)."
          : mode === "push-to-talk"
            ? "Push-to-talk started — invoke again or release to transcribe."
            : "Offline dictation started (SenseVoice WASM).",
      );
    } finally {
      if (this.dictationStartEpoch === startEpoch) {
        this.startingDictation = false;
      }
    }
  }

  private async startBrowserSpeechRecognitionFallback(): Promise<void> {
    const win = activeWindow as SpeechRecognitionWindow;
    const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      new Notice(
        this.capabilities.isMobile
          ? "System speech recognition is unavailable in this mobile runtime."
          : "Browser speech recognition is unavailable in this desktop build. Switch recognition engine to SenseVoice WASM in settings for offline dictation.",
      );
      return;
    }

    const startEpoch = ++this.dictationStartEpoch;
    this.startingDictation = true;

    try {
      this.stopReadAloudSilently();
      if (this.bargeInMonitor) {
        await this.bargeInMonitor.stop();
      }
      if (startEpoch !== this.dictationStartEpoch) {
        return;
      }

      const recognition = new RecognitionCtor();
      recognition.lang = this.settings.dictationLanguage;
      recognition.continuous = this.settings.dictationMode !== "single";
      recognition.interimResults = true;

      const replacer = createAsrReplacer(this.settings.asrReplacements);

      recognition.onresult = (event) => {
        let interimText = "";
        let finalText = "";

        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const transcript = result?.[0]?.transcript ?? "";
          if (!transcript) {
            continue;
          }
          if (result?.isFinal) {
            finalText += transcript;
          } else {
            interimText += transcript;
          }
        }

        if (interimText.trim()) {
          this.showSubtitleOverlay("Dictating", interimText.trim());
        }

        if (finalText.trim()) {
          const committed = replacer(finalText).trim();
          if (committed) {
            this.commitDictatedText(committed);
            this.showSubtitleOverlay("Inserted", committed, 2200);
          }
        }
      };

      recognition.onerror = (event) => {
        this.listening = false;
        this.recognitionErrored = true;
        this.activeRecognition = null;
        this.setStatus("error");
        this.hideSubtitleOverlay();
        if (!this.capabilities.isMobile && event.error === "network") {
          new Notice(
            "Browser speech recognition is unavailable in this desktop build. Switch recognition engine to SenseVoice WASM in settings for 100% offline dictation.",
            7000,
          );
          return;
        }
        new Notice(`Voice dictation error: ${event.error}.`);
      };

      recognition.onend = () => {
        if (this.activeRecognition === recognition) {
          this.activeRecognition = null;
        }
        this.listening = false;
        if (this.recognitionErrored) {
          return;
        }
        if (!this.speechPlayer?.isActive) {
          this.setStatus("idle");
        }
      };

      try {
        this.activeRecognition = recognition;
        this.listening = true;
        this.recognitionErrored = false;
        this.setStatus("listening");
        this.showSubtitleOverlay("Dictating", "Listening...");
        recognition.start();
        new Notice("Voice dictation started.");
      } catch (err) {
        this.activeRecognition = null;
        this.listening = false;
        this.recognitionErrored = true;
        this.setStatus("error");
        this.hideSubtitleOverlay();
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        new Notice(`Could not start voice dictation: ${message}`);
      }
    } finally {
      if (this.dictationStartEpoch === startEpoch) {
        this.startingDictation = false;
      }
    }
  }

  private stopBrowserRecognition(): void {
    const recognition = this.activeRecognition;
    this.activeRecognition = null;
    this.listening = false;
    this.recognitionErrored = false;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // Ignore stop errors if recognition already ended.
      }
    }
    if (!this.speechPlayer?.isActive && this.currentStatus !== "idle") {
      this.setStatus("idle");
    }
    this.hideSubtitleOverlay();
  }

  commitDictatedText(text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeEl = resolveDeepActiveElement(activeDocument);

    // 1. If the active MarkdownView CodeMirror 6 editor owns focus, always route through CM6 API
    //    instead of hijacking its internal contenteditable DOM directly.
    if (view?.editor && isMarkdownEditorFocused(view.containerEl, activeEl)) {
      insertDictatedText(view.editor, text);
      return;
    }

    // 2. Otherwise insert into an external focused input (e.g. sidebar Copilot Lexical / AI chat box).
    if (insertIntoFocusedInput(activeDocument, text)) {
      return;
    }

    // 3. Fallback to the active Markdown editor if focus briefly moved to chrome (ribbon/status bar).
    if (view?.editor) {
      insertDictatedText(view.editor, text);
      return;
    }

    new Notice("No active editor or text input found for dictated text.");
  }

  private async readSelectionOrNoteAloud(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor) {
      new Notice("Open a Markdown note to read aloud.");
      return;
    }

    const sentences = extractReadableText(view.editor, {
      maxSentenceChars: this.settings.maxSentenceChars,
      tablePolicy: this.settings.markdownTablePolicy,
    });

    if (sentences.length === 0) {
      new Notice("No readable text found in the selection or note.");
      return;
    }

    const startEpoch = ++this.readAloudStartEpoch;
    if (
      this.capabilities.isMobile &&
      !this.settings.allowCloudFallbackOnMobile &&
      isCloudTtsEngine(this.settings.ttsEngine)
    ) {
      new Notice(
        "Cloud speech synthesis is disabled on mobile by privacy settings; using system speech synthesis.",
      );
    }
    const effectiveTts = this.getEffectiveTtsEngine();

    if (effectiveTts === "vits-wasm") {
      const manager = this.ensureDesktopModelManager();
      if (!manager) {
        new Notice("Local offline VITS speech synthesis is only available on desktop.");
        return;
      }
      let status: DictationStackStatus;
      try {
        status = await manager.checkStatus();
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        new Notice(`Could not verify external model cache: ${msg}`);
        return;
      }
      if (startEpoch !== this.readAloudStartEpoch) {
        return;
      }
      if (!status.vitsReady) {
        new Notice(
          "Optional local VITS model is not installed yet. Download it in Voice Mode settings or switch speech engine to system.",
        );
        return;
      }
    }

    this.dictationStartEpoch += 1;
    this.startingDictation = false;
    this.pointerHoldActive = false;
    if (this.offlineSession && this.offlineSession.state !== "idle") {
      void this.offlineSession.abort();
    }
    if (this.listening || this.activeRecognition) {
      this.stopBrowserRecognition();
    }

    this.syncSpeechPlayerEngines();
    this.overflowNotified = false;
    this.speechPlayer?.cancel();
    this.readingNotePath = view.file?.path ?? null;
    const queued = this.speechPlayer?.speakSentences(sentences) ?? 0;
    if (queued > 0) {
      new Notice(`Reading ${queued} ${queued === 1 ? "sentence" : "sentences"} aloud.`);
    }
  }

  private togglePauseReadAloud(): void {
    if (!this.speechPlayer?.isActive) {
      new Notice("Read-aloud is not currently active.");
      return;
    }
    this.speechPlayer.togglePause();
  }

  private skipReadAloudSentence(): void {
    if (!this.speechPlayer?.isActive) {
      new Notice("Read-aloud is not currently active.");
      return;
    }
    this.speechPlayer.skipCurrent();
  }

  private stopReadAloudSilently(): void {
    this.readAloudStartEpoch += 1;
    this.readingNotePath = null;
    this.speechPlayer?.cancel();
    void this.bargeInMonitor?.stop();
    this.hideSubtitleOverlay();
    if (!this.isDictationBusy() && this.currentStatus !== "error") {
      this.setStatus("idle");
    }
  }

  private stopReadAloud(): void {
    if (!this.speechPlayer?.isActive) {
      new Notice("Read-aloud is not currently playing.");
      return;
    }
    this.stopReadAloudSilently();
    new Notice("Read-aloud stopped.");
  }

  private async showRuntimeStatusNotice(): Promise<void> {
    const effectiveAsr = this.getEffectiveAsrEngine();
    const effectiveTts = this.getEffectiveTtsEngine();
    const usesSystemTts =
      effectiveTts === "system" || !this.speechPlayer?.hasRegisteredEngine(effectiveTts);
    const bargeIn =
      this.lastBargeInDecision ??
      resolveBargeInPolicy({
        requestedMode: this.settings.bargeInMode,
        usesSystemTts,
        isMobile: this.capabilities.isMobile,
        isSafari: Platform.isSafari,
        nativeAecActive: false,
      });

    let wasmLabel = "disabled (mobile OOM safeguard)";
    if (this.capabilities.allowLocalWasmModels) {
      const status = await this.getModelStatus().catch(() => null);
      const vitsLabel = status?.vitsReady ? ", VITS ready" : "";
      wasmLabel = status?.ready
        ? `ready (SHA256 verified${vitsLabel}, budget ${this.capabilities.maxLocalModelMemoryMb} MB)`
        : `not downloaded${vitsLabel} (budget ${this.capabilities.maxLocalModelMemoryMb} MB)`;
    }

    const secretLabel = this.secretStore.available
      ? `ready (${this.secretStore.listSecrets().length} stored)`
      : "unavailable (upgrade >= 1.11.4)";

    new Notice(
      `Host: ${this.capabilities.hostClass} | ASR: ${effectiveAsr} (${this.settings.dictationMode}) | TTS: ${effectiveTts} | Local WASM: ${wasmLabel} | Secret storage: ${secretLabel} | Barge-in: ${bargeIn.policy}`,
      6500,
    );
  }
}
