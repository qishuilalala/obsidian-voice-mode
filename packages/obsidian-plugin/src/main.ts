import { t, type UiMessage } from "./i18n.ts";
import {
  DaemonClient,
  MODEL_BUNDLES,
  MimoTtsEngine,
  OpenAiCompatAsrTransport,
  OpenAiCompatTtsEngine,
  buildMemfsSherpaGlue,
  createAsrReplacer,
  isCloudAsrEngine,
  isCloudTtsEngine,
  redactSecrets,
  resolveDaemonBaseUrl,
  resolveTranscriptionsEndpointUrl,
  stripEmotionTags,
  type AsrTransport,
  type TtsEngineKind,
} from "@voice-mode/core";
import {
  AecBargeInMonitor,
  CloudDictationSession,
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
  DEFAULT_LOCAL_DAEMON_URL,
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
import {
  VoiceQaModal,
  extractNoteQaContext,
  polishDictatedTranscript,
} from "./voice-qa-modal.ts";

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

const STATUS_LABEL_MAP: Readonly<Record<VoiceStatusKind, UiMessage>> = {
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
  private daemonTtsClient: DaemonClient | null = null;
  private daemonTtsConfigKey = "";
  private daemonTtsFallbackNotified = false;
  private daemonTtsFallbackTarget: "vits-wasm" | "system" | null = null;
  private httpTtsConfigKey = "";
  private modelManager: DesktopModelManager | null = null;
  private modelManagerConfigKey = "";
  private workerClient: SherpaWorkerClient | null = null;
  private bargeInWorkerClient: SherpaWorkerClient | null = null;
  private offlineSession: OfflineDictationSession | null = null;
  private asrTransport: OpenAiCompatAsrTransport | null = null;
  private cloudSession: CloudDictationSession | null = null;
  private cloudAsrConfigKey = "";
  private daemonAsrClient: DaemonClient | null = null;
  private daemonSession: CloudDictationSession | null = null;
  private daemonAsrConfigKey = "";
  private daemonAsrFallbackNotified = false;
  private readonly polishAbortControllers = new Set<AbortController>();
  private polishFallbackNotified = false;
  private dictationTargetOverride: ((text: string) => void) | null = null;
  private dictationTargetSettled: (() => void) | null = null;
  private activeQaModal: VoiceQaModal | null = null;
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
  private settingsWriteEpoch = 0;
  private readingNotePath: string | null = null;
  /** Sentence list and next index of the current run (P4 resume). */
  private activeReadAloudIndex = 0;
  /** Guards against concurrent WAV export commands. */
  private exportInProgress = false;
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
        onSentenceStart: (sentence, index, total) => {
          this.activeReadAloudIndex += 1;
          if (this.readingNotePath) {
            this.settings.readAloudResume = {
              path: this.readingNotePath,
              sentenceIndex: this.activeReadAloudIndex,
            };
            void this.saveSettings();
          }
          const progress = total > 1 ? ` (${index + 1}/${total})` : "";
          this.showSubtitleOverlay(t("Reading aloud") + progress, sentence, undefined, true);
        },
        onEngineFallback: (requested) => {
          if (requested === "kokoro-daemon") {
            new Notice(
              t("Local Kokoro voice daemon is not connected; falling back to system speech synthesis."),
            );
            return;
          }
          new Notice(
            t("Speech engine \"{0}\" is unavailable; falling back to system speech synthesis (voice may change).", requested),
          );
        },
        onDrop: () => {
          if (!this.overflowNotified) {
            this.overflowNotified = true;
            new Notice(
              t("Selection exceeds the 2,000-sentence read-aloud queue limit; trailing sentences were omitted."),
            );
          }
        },
        onError: (err) => {
          const message = redactSecrets(err instanceof Error ? err.message : String(err));
          this.stopReadAloudSilently();
          this.setStatus("error");
          new Notice(t("Read-aloud failed: {0}", message));
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

    this.addRibbonIcon("mic", t("Toggle voice dictation"), () => {
      void this.toggleDictation();
    });

    this.addCommand({
      id: "toggle-dictation",
      name: t("Toggle voice dictation"),
      callback: () => {
        void this.toggleDictation();
      },
    });

    this.addCommand({
      id: "dictate-single-utterance",
      name: t("Dictate single utterance"),
      callback: () => {
        void this.toggleDictation("single");
      },
    });

    this.addCommand({
      id: "read-aloud",
      name: t("Read selection or note aloud"),
      callback: () => {
        void this.readSelectionOrNoteAloud();
      },
    });

    this.addCommand({
      id: "pause-resume-read-aloud",
      name: t("Pause or resume read-aloud"),
      callback: () => {
        this.togglePauseReadAloud();
      },
    });

    this.addCommand({
      id: "skip-read-aloud-sentence",
      name: t("Skip current read-aloud sentence"),
      callback: () => {
        this.skipReadAloudSentence();
      },
    });

    this.addCommand({
      id: "stop-read-aloud",
      name: t("Stop read-aloud"),
      callback: () => {
        this.stopReadAloud();
      },
    });

    this.addCommand({
      id: "export-read-aloud-wav",
      name: t("Export read-aloud as WAV"),
      callback: () => {
        void this.exportReadAloudWav();
      },
    });

    this.addCommand({
      id: "resume-read-aloud",
      name: t("Resume read-aloud"),
      callback: () => {
        void this.resumeReadAloud();
      },
    });

    this.addCommand({
      id: "ask-ai-about-note",
      name: t("Ask AI about selection or note"),
      callback: () => {
        this.openVoiceQaModal();
      },
    });

    this.addCommand({
      id: "check-runtime-status",
      name: t("Check voice runtime status"),
      callback: () => {
        void this.showRuntimeStatusNotice();
      },
    });

    this.addCommand({
      id: "copy-runtime-status",
      name: t("Copy voice runtime status"),
      callback: () => {
        void this.copyRuntimeStatus();
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
    this.notifyDictationTargetSettled();

    if (this.activeQaModal) {
      const modal = this.activeQaModal;
      this.activeQaModal = null;
      modal.close();
    }

    for (const controller of this.polishAbortControllers) {
      controller.abort();
    }
    this.polishAbortControllers.clear();

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

    if (this.cloudSession) {
      void this.cloudSession.abort();
      this.cloudSession = null;
    }

    if (this.daemonSession) {
      void this.daemonSession.abort();
      this.daemonSession = null;
    }

    if (this.asrTransport) {
      void this.asrTransport.close();
      this.asrTransport = null;
    }
    this.cloudAsrConfigKey = "";

    if (this.daemonAsrClient) {
      void this.daemonAsrClient.close();
      this.daemonAsrClient = null;
    }
    this.daemonAsrConfigKey = "";

    this.vitsTtsEngine = null;
    this.openAiTtsEngine = null;
    this.mimoTtsEngine = null;
    this.daemonTtsClient = null;
    this.daemonTtsConfigKey = "";
    this.daemonTtsFallbackNotified = false;
    this.daemonTtsFallbackTarget = null;
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
    const epoch = this.settingsWriteEpoch;
    const raw: unknown = await this.loadData();
    if (epoch === this.settingsWriteEpoch) {
      Object.assign(this.settings, normalizeSettings(raw));
    }
  }

  async saveSettings(): Promise<void> {
    this.settingsWriteEpoch += 1;
    const normalized = normalizeSettings(stripSecretsFromSettings(this.settings));
    Object.assign(this.settings, normalized);
    await this.saveData(stripSecretsFromSettings(this.settings));

    this.lastBargeInDecision = null;
    this.polishFallbackNotified = false;
    this.daemonTtsFallbackNotified = false;
    this.daemonTtsFallbackTarget = null;
    this.daemonAsrFallbackNotified = false;
    this.daemonTtsClient?.resetHealthCache();
    this.daemonAsrClient?.resetHealthCache();
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

    if (this.cloudSession) {
      const nextCloudKey = JSON.stringify([
        this.settings.asrEndpointUrl,
        this.settings.asrModel,
      ]);
      if (nextCloudKey !== this.cloudAsrConfigKey && this.cloudSession.state === "idle") {
        const prevTransport = this.asrTransport;
        this.cloudSession = null;
        this.asrTransport = null;
        this.cloudAsrConfigKey = "";
        void prevTransport?.close().catch(() => undefined);
        if (this.getEffectiveAsrEngine() === "openai-compat") {
          this.ensureCloudDictationSession();
        }
      } else {
        this.cloudSession.updateEndpointPolicy({ silenceMs: this.settings.endpointSilenceMs });
        this.cloudSession.updateLanguage(this.settings.dictationLanguage);
      }
    }

    if (this.daemonSession) {
      const nextDaemonKey = JSON.stringify([this.settings.daemonUrl]);
      if (nextDaemonKey !== this.daemonAsrConfigKey && this.daemonSession.state === "idle") {
        const prevDaemon = this.daemonAsrClient;
        this.daemonSession = null;
        this.daemonAsrClient = null;
        this.daemonAsrConfigKey = "";
        void prevDaemon?.close().catch(() => undefined);
      } else {
        this.daemonSession.updateEndpointPolicy({ silenceMs: this.settings.endpointSilenceMs });
        this.daemonSession.updateLanguage(this.settings.dictationLanguage);
      }
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
      throw new Error(t("Local offline WASM models are only available on desktop."));
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
          t("Offline dictation models verified and ready. Switched recognition engine to SenseVoice WASM."),
        );
      } else if (status.ready) {
        new Notice(t("Offline dictation models verified and ready."));
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
      throw new Error(t("Local offline WASM models are only available on desktop."));
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
          t("Optional local VITS model verified and ready. Switched speech engine to VITS WASM."),
        );
      } else if (status.vitsReady) {
        new Notice(t("Optional local VITS model verified and ready."));
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
    this.notifyDictationTargetSettled();
    if (this.speechPlayer?.isActive) {
      this.stopReadAloudSilently();
    }
    if (this.bargeInMonitor) {
      await this.bargeInMonitor.stop();
    }
    if (this.offlineSession && this.offlineSession.state !== "idle") {
      await this.offlineSession.abort();
    }
    if (this.cloudSession && this.cloudSession.state !== "idle") {
      await this.cloudSession.abort();
    }
    if (this.daemonSession && this.daemonSession.state !== "idle") {
      await this.daemonSession.abort();
    }
    if (this.workerClient) {
      await this.workerClient.unload();
    }
    if (this.bargeInWorkerClient) {
      await this.bargeInWorkerClient.unload();
    }
    await manager.clearCachedModels();
    new Notice(t("Cleared cached offline speech models outside the vault."));
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
      this.settings.asrEndpointUrl,
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
    try {
      this.modelManager = new DesktopModelManager({
        customCacheDir: this.settings.customModelCacheDir,
        vaultBasePath,
        preferredModelHost: this.settings.modelMirrorHost,
        vitsBundle: MODEL_BUNDLES["vits-zh-ll"],
      });
    } catch {
      this.modelManager = null;
    }
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

    if (this.capabilities.allowLocalDaemon) {
      const nextDaemonTtsKey = JSON.stringify([this.settings.daemonUrl]);
      if (
        forceRecreateHttp ||
        nextDaemonTtsKey !== this.daemonTtsConfigKey ||
        !this.daemonTtsClient
      ) {
        const prevDaemonTts = this.daemonTtsClient;
        const textEncoder = new TextEncoder();
        try {
          this.daemonTtsClient = new DaemonClient({
            baseUrl: this.settings.daemonUrl || DEFAULT_LOCAL_DAEMON_URL,
            token: () =>
              this.settings.daemonTokenSecretId
                ? this.secretStore.getSecret(this.settings.daemonTokenSecretId)
                : null,
            voice: this.settings.ttsVoice || undefined,
            rate: this.settings.speechRate,
            fetchImpl: (input, init) => this.callNativeBrowserFetch(input, init),
            fallbackTts: {
              kind: "system",
              mime: "text/plain;charset=utf-8",
              synthesize: async (text, options) => {
                const status = await this.getModelStatus().catch(() => null);
                if (status?.vitsReady && this.vitsTtsEngine) {
                  this.daemonTtsFallbackTarget = "vits-wasm";
                  if (!this.daemonTtsFallbackNotified) {
                    this.daemonTtsFallbackNotified = true;
                    new Notice(
                      t("Local voice daemon is offline or unauthorized; falling back to VITS WASM."),
                    );
                  }
                  return this.vitsTtsEngine.synthesize(text, options);
                }
                this.daemonTtsFallbackTarget = "system";
                void this.bargeInMonitor?.stop();
                if (!this.daemonTtsFallbackNotified) {
                  this.daemonTtsFallbackNotified = true;
                  new Notice(
                    t("Local voice daemon is offline or unauthorized; falling back to system speech synthesis."),
                  );
                }
                return {
                  audio: textEncoder.encode(stripEmotionTags(text).trim()),
                  mime: "text/plain;charset=utf-8",
                };
              },
              close: async () => {},
            },
          });
          this.speechPlayer.registerEngine(this.daemonTtsClient.tts);
          this.daemonTtsConfigKey = nextDaemonTtsKey;
        } catch {
          this.daemonTtsClient = null;
          this.daemonTtsConfigKey = "";
          this.speechPlayer.unregisterEngine("kokoro-daemon");
        }
        if (!this.speechPlayer.isActive) {
          void prevDaemonTts?.close().catch(() => undefined);
        }
      } else {
        this.daemonTtsClient.updateVoice(this.settings.ttsVoice, this.settings.speechRate);
      }
    } else if (this.daemonTtsClient) {
      void this.daemonTtsClient.close();
      this.daemonTtsClient = null;
      this.daemonTtsConfigKey = "";
      this.speechPlayer.unregisterEngine("kokoro-daemon");
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
          new Notice(t("Read-aloud interrupted by voice."));
        },
        onDowngrade: (decision) => {
          this.lastBargeInDecision = decision;
          if (decision.reason === "native-aec-inactive" && !this.aecDowngradeNotified) {
            this.aecDowngradeNotified = true;
            new Notice(
              t("Native echo cancellation is inactive on the current audio device; hands-free barge-in downgraded to manual stop."),
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
      if (this.subtitleRoleEl?.getText() === t("Read-aloud paused")) {
        this.subtitleRoleEl.setText(t("Reading aloud"));
      }
      this.updateSubtitlePlaybackControls(true, false);
      void this.syncBargeInForPlaybackState("playing");
      return;
    }

    if (state === "paused") {
      void this.syncBargeInForPlaybackState("paused");
      this.setStatus("speaking", t("Read-aloud paused"));
      this.subtitleRoleEl?.setText(t("Read-aloud paused"));
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
      effectiveTts === "system" ||
      !this.speechPlayer?.hasRegisteredEngine(effectiveTts) ||
      (effectiveTts === "kokoro-daemon" && this.daemonTtsFallbackTarget === "system");

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
              t("Offline dictation"),
              isSpeech ? t("Listening (speech detected)...") : t("Listening..."),
            );
          }
        },
        onFinalTranscript: (rawText) => {
          const target = this.dictationTargetOverride ?? undefined;
          this.notifyDictationTargetSettled();
          void this.processAndCommitDictation(rawText, target);
        },
        onError: (err) => {
          this.listening = false;
          this.notifyDictationTargetSettled();
          this.setStatus("error");
          this.hideSubtitleOverlay();
          if (isMicrophonePermissionError(err)) {
            new Notice(
              t("Microphone permission was denied. Grant microphone access to Obsidian in your OS privacy settings and try again."),
              7000,
            );
            return;
          }
          const message = redactSecrets(err.message || String(err));
          new Notice(t("Offline dictation error: {0}", message));
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
        this.setStatus("busy", t("Loading model"));
        this.showSubtitleOverlay(t("Offline dictation"), t("Loading local SenseVoice model..."));
        break;
      case "listening":
        this.listening = true;
        this.setStatus("listening");
        this.showSubtitleOverlay(
          t("Offline dictation"),
          this.offlineSession?.mode === "push-to-talk"
            ? t("Push to talk active — speak now...")
            : t("Listening..."),
        );
        break;
      case "transcribing":
      case "stopping":
        this.listening = false;
        this.setStatus("busy", t("Transcribing"));
        this.showSubtitleOverlay(t("Offline dictation"), t("Transcribing offline..."));
        break;
      case "idle":
        this.listening = false;
        this.notifyDictationTargetSettled();
        if (
          this.polishAbortControllers.size === 0 &&
          !this.speechPlayer?.isActive &&
          this.currentStatus !== "error"
        ) {
          this.setStatus("idle");
        }
        break;
    }
  }

  private callNativeBrowserFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    if (typeof activeWindow !== "undefined" && typeof activeWindow.fetch === "function") {
      return activeWindow.fetch(input, init);
    }
    return window.fetch(input, init);
  }

  private ensureCloudAsrTransport(): OpenAiCompatAsrTransport {
    const nextKey = JSON.stringify([this.settings.asrEndpointUrl, this.settings.asrModel]);
    if (
      !this.asrTransport ||
      ((!this.cloudSession || this.cloudSession.state === "idle") &&
        nextKey !== this.cloudAsrConfigKey)
    ) {
      const prevTransport = this.asrTransport;
      this.asrTransport = new OpenAiCompatAsrTransport({
        baseUrl: this.settings.asrEndpointUrl || undefined,
        model: this.settings.asrModel || undefined,
        language: this.settings.dictationLanguage,
        apiKey: () =>
          this.settings.asrApiKeySecretId
            ? this.secretStore.getSecret(this.settings.asrApiKeySecretId)
            : null,
        fetchImpl: (input, init) => this.corsFetch(input, init),
      });
      this.cloudAsrConfigKey = nextKey;
      this.cloudSession = null;
      if (prevTransport) {
        void prevTransport.close().catch(() => undefined);
      }
    }
    return this.asrTransport;
  }

  private createTransportDictationSession(
    transport: AsrTransport,
    roleLabel: "Cloud dictation" | "Daemon dictation",
    getSession: () => CloudDictationSession | null,
  ): CloudDictationSession {
    return new CloudDictationSession({
      transport,
      endpointPolicy: {
        silenceMs: this.settings.endpointSilenceMs,
      },
      language: this.settings.dictationLanguage,
      onStateChange: (state) => {
        this.handleTransportSessionStateChange(state, roleLabel, getSession);
      },
      onSpeechActivity: (isSpeech) => {
        if (getSession()?.state === "listening") {
          this.showSubtitleOverlay(
            t(roleLabel),
            isSpeech ? t("Listening (speech detected)...") : t("Listening..."),
          );
        }
      },
      onFinalTranscript: (rawText) => {
        const target = this.dictationTargetOverride ?? undefined;
        this.notifyDictationTargetSettled();
        void this.processAndCommitDictation(rawText, target);
      },
      onError: (err) => {
        this.listening = false;
        this.notifyDictationTargetSettled();
        this.setStatus("error");
        this.hideSubtitleOverlay();
        if (isMicrophonePermissionError(err)) {
          new Notice(
            t("Microphone permission was denied. Grant microphone access to Obsidian in your OS privacy settings and try again."),
            7000,
          );
          return;
        }
        const message = redactSecrets(err.message || String(err));
        new Notice(t("{0} error: {1}", t(roleLabel), message));
      },
    });
  }

  private handleTransportSessionStateChange(
    state: DictationSessionState,
    roleLabel: "Cloud dictation" | "Daemon dictation",
    getSession: () => CloudDictationSession | null,
  ): void {
    switch (state) {
      case "starting":
        this.listening = true;
        this.setStatus("busy", t("Starting mic"));
        this.showSubtitleOverlay(t(roleLabel), t("Opening microphone..."));
        break;
      case "listening":
        this.listening = true;
        this.setStatus("listening");
        this.showSubtitleOverlay(
          t(roleLabel),
          getSession()?.mode === "push-to-talk"
            ? t("Push to talk active — speak now...")
            : t("Listening..."),
        );
        break;
      case "transcribing":
      case "stopping":
        this.listening = false;
        this.setStatus("busy", t("Transcribing"));
        this.showSubtitleOverlay(t(roleLabel), t("Transcribing..."));
        break;
      case "idle":
        this.listening = false;
        this.notifyDictationTargetSettled();
        if (
          this.polishAbortControllers.size === 0 &&
          !this.speechPlayer?.isActive &&
          this.currentStatus !== "error"
        ) {
          this.setStatus("idle");
        }
        break;
    }
  }

  private ensureCloudDictationSession(): CloudDictationSession {
    const transport = this.ensureCloudAsrTransport();
    if (!this.cloudSession) {
      this.cloudSession = this.createTransportDictationSession(
        transport,
        "Cloud dictation",
        () => this.cloudSession,
      );
    }
    this.cloudSession.updateEndpointPolicy({ silenceMs: this.settings.endpointSilenceMs });
    this.cloudSession.updateLanguage(this.settings.dictationLanguage);
    return this.cloudSession;
  }

  private createDaemonMidSessionFallbackAsr(): AsrTransport {
    return {
      kind: "openai-compat",
      transcribe: async (pcm16k, options) => {
        const modelStatus = await this.getModelStatus().catch(() => null);
        if (modelStatus?.ready) {
          const worker = this.ensureSherpaWorkerClient();
          if (worker) {
            try {
              const res = await worker.transcribe(pcm16k, {
                sampleRate: options?.sampleRate,
                language: resolveSenseVoiceLanguage(
                  options?.language ?? this.settings.dictationLanguage,
                ),
              });
              if (!this.daemonAsrFallbackNotified) {
                this.daemonAsrFallbackNotified = true;
                new Notice(
                  t("Local voice daemon is offline or unauthorized; falling back to SenseVoice WASM offline dictation."),
                );
              }
              return { text: res.text.trim(), isFinal: true };
            } catch {
              // Fall through to OpenAI-compatible ASR if local Worker cannot run in current host.
            }
          }
        }
        if (this.isOpenAiCompatAsrReady()) {
          if (!this.daemonAsrFallbackNotified) {
            this.daemonAsrFallbackNotified = true;
            new Notice(
              t("Local voice daemon is offline or unauthorized; falling back to OpenAI-compatible dictation."),
            );
          }
          return this.ensureCloudAsrTransport().transcribe(pcm16k, options);
        }
        throw new Error(
          t("Local voice daemon disconnected mid-session and no fallback ASR engine is configured."),
        );
      },
      close: async () => {},
    };
  }

  private ensureDaemonAsrClient(): DaemonClient {
    const rawBase = this.settings.daemonUrl || DEFAULT_LOCAL_DAEMON_URL;
    let safeBase = DEFAULT_LOCAL_DAEMON_URL;
    try {
      safeBase = resolveDaemonBaseUrl(rawBase);
    } catch {
      safeBase = DEFAULT_LOCAL_DAEMON_URL;
    }
    const nextKey = JSON.stringify([safeBase]);
    if (
      !this.daemonAsrClient ||
      ((!this.daemonSession || this.daemonSession.state === "idle") &&
        nextKey !== this.daemonAsrConfigKey)
    ) {
      const prev = this.daemonAsrClient;
      this.daemonAsrClient = new DaemonClient({
        baseUrl: safeBase,
        token: () =>
          this.settings.daemonTokenSecretId
            ? this.secretStore.getSecret(this.settings.daemonTokenSecretId)
            : null,
        language: this.settings.dictationLanguage,
        fetchImpl: (input, init) => this.callNativeBrowserFetch(input, init),
        fallbackAsr: this.createDaemonMidSessionFallbackAsr(),
      });
      this.daemonAsrConfigKey = nextKey;
      this.daemonSession = null;
      if (prev) {
        void prev.close().catch(() => undefined);
      }
    }
    return this.daemonAsrClient;
  }

  ensureDaemonDictationSession(): CloudDictationSession {
    const client = this.ensureDaemonAsrClient();
    if (!this.daemonSession) {
      this.daemonSession = this.createTransportDictationSession(
        client.asr,
        "Daemon dictation",
        () => this.daemonSession,
      );
    }
    this.daemonSession.updateEndpointPolicy({ silenceMs: this.settings.endpointSilenceMs });
    this.daemonSession.updateLanguage(this.settings.dictationLanguage);
    return this.daemonSession;
  }

  private isMicSessionActive(): boolean {
    if (this.startingDictation || this.listening || this.activeRecognition) {
      return true;
    }
    if (this.offlineSession && this.offlineSession.state !== "idle") {
      return true;
    }
    if (this.daemonSession && this.daemonSession.state !== "idle") {
      return true;
    }
    return Boolean(this.cloudSession && this.cloudSession.state !== "idle");
  }

  private isDictationBusy(): boolean {
    return this.isMicSessionActive() || this.polishAbortControllers.size > 0;
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
      text: t(STATUS_LABEL_MAP.idle),
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
      if (this.cloudSession && this.cloudSession.state !== "idle") {
        void this.cloudSession.stop({ flush: true });
      }
      if (this.daemonSession && this.daemonSession.state !== "idle") {
        void this.daemonSession.stop({ flush: true });
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
      text: t("Pause"),
    });
    pauseBtn.type = "button";
    const nextBtn = controls.createEl("button", {
      cls: "vm-subtitle-btn",
      text: t("Next"),
    });
    nextBtn.type = "button";
    const stopBtn = controls.createEl("button", {
      cls: "vm-subtitle-btn",
      text: t("Stop"),
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
      this.subtitlePauseBtnEl.setText(isPaused ? t("Resume") : t("Pause"));
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
    this.statusLabelEl.setText(labelOverride ?? t(STATUS_LABEL_MAP[next]));
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
      const wasCloudStarting = Boolean(this.cloudSession && this.cloudSession.state !== "idle");
      const wasDaemonStarting = Boolean(this.daemonSession && this.daemonSession.state !== "idle");
      this.dictationStartEpoch += 1;
      this.startingDictation = false;
      this.pointerHoldActive = false;
      this.dictationTargetOverride = null;
      if (this.offlineSession && this.offlineSession.state !== "idle") {
        await this.offlineSession.stop({ flush: false });
      }
      if (this.cloudSession && this.cloudSession.state !== "idle") {
        await this.cloudSession.stop({ flush: false });
      }
      if (this.daemonSession && this.daemonSession.state !== "idle") {
        await this.daemonSession.stop({ flush: false });
      }
      if (!this.speechPlayer?.isActive && this.currentStatus !== "error") {
        this.setStatus("idle");
        this.hideSubtitleOverlay();
      }
      new Notice(
        wasDaemonStarting
          ? t("Daemon voice dictation stopped.")
          : wasCloudStarting
            ? t("Cloud voice dictation stopped.")
            : t("Offline voice dictation stopped."),
      );
      return;
    }

    if (this.offlineSession && this.offlineSession.state !== "idle") {
      this.pointerHoldActive = false;
      await this.offlineSession.stop({ flush: true });
      new Notice(t("Offline voice dictation stopped."));
      return;
    }

    if (this.cloudSession && this.cloudSession.state !== "idle") {
      this.pointerHoldActive = false;
      await this.cloudSession.stop({ flush: true });
      new Notice(t("Cloud voice dictation stopped."));
      return;
    }

    if (this.daemonSession && this.daemonSession.state !== "idle") {
      this.pointerHoldActive = false;
      await this.daemonSession.stop({ flush: true });
      new Notice(t("Daemon voice dictation stopped."));
      return;
    }

    if (this.activeRecognition || this.listening) {
      this.stopBrowserRecognition();
      new Notice(t("Voice dictation stopped."));
      return;
    }

    const effectiveAsr = this.getEffectiveAsrEngine();
    if (
      this.capabilities.isMobile &&
      !this.settings.allowCloudFallbackOnMobile &&
      this.settings.asrEngine !== "system" &&
      isCloudAsrEngine(this.settings.asrEngine) &&
      effectiveAsr !== this.settings.asrEngine
    ) {
      new Notice(
        t("Cloud speech recognition is disabled on mobile by privacy settings; using system speech recognition."),
      );
    }

    const mode = modeOverride ?? this.settings.dictationMode;

    if (effectiveAsr === "sensevoice-wasm") {
      await this.startOfflineSenseVoiceDictation(mode, fromPointerHold);
      return;
    }

    if (effectiveAsr === "openai-compat") {
      await this.startCloudOpenAiDictation(mode, fromPointerHold);
      return;
    }

    if (effectiveAsr === "daemon") {
      await this.startDaemonDictation(mode, fromPointerHold);
      return;
    }

    if (effectiveAsr !== "system") {
      this.notifyDictationTargetSettled();
      new Notice(
        t(
          "Speech recognition engine \"{0}\" is scheduled for a subsequent milestone. Choose SenseVoice WASM on desktop for offline dictation.",
          effectiveAsr,
        ),
      );
      return;
    }

    await this.startBrowserSpeechRecognitionFallback(mode);
  }

  private isOpenAiCompatAsrReady(): boolean {
    try {
      const endpoint = resolveTranscriptionsEndpointUrl(this.settings.asrEndpointUrl || undefined);
      if (endpoint.isLoopbackHttp) {
        return true;
      }
      const secretId = this.settings.asrApiKeySecretId;
      const apiKey = secretId ? this.secretStore.getSecret(secretId) : null;
      return Boolean(apiKey && apiKey.trim());
    } catch {
      return false;
    }
  }

  private async startDaemonDictation(
    mode: DictationMode,
    fromPointerHold: boolean,
  ): Promise<void> {
    try {
      resolveDaemonBaseUrl(this.settings.daemonUrl || DEFAULT_LOCAL_DAEMON_URL);
    } catch (err) {
      this.pointerHoldActive = false;
      this.notifyDictationTargetSettled();
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      new Notice(t("Invalid local daemon URL: {0}", msg));
      return;
    }

    const startEpoch = ++this.dictationStartEpoch;
    this.startingDictation = true;

    try {
      const client = this.ensureDaemonAsrClient();
      const health = await client.probeHealth();
      if (startEpoch !== this.dictationStartEpoch || (fromPointerHold && !this.pointerHoldActive)) {
        return;
      }

      if (!health.ok) {
        const modelStatus = await this.getModelStatus().catch(() => null);
        if (
          startEpoch !== this.dictationStartEpoch ||
          (fromPointerHold && !this.pointerHoldActive)
        ) {
          return;
        }
        if (modelStatus?.ready) {
          this.startingDictation = false;
          new Notice(
            t("Local voice daemon is offline or unauthorized; falling back to SenseVoice WASM offline dictation."),
          );
          await this.startOfflineSenseVoiceDictation(mode, fromPointerHold);
          return;
        }
        if (this.isOpenAiCompatAsrReady()) {
          this.startingDictation = false;
          new Notice(
            t("Local voice daemon is offline or unauthorized; falling back to OpenAI-compatible dictation."),
          );
          await this.startCloudOpenAiDictation(mode, fromPointerHold);
          return;
        }
        this.pointerHoldActive = false;
        this.notifyDictationTargetSettled();
        new Notice(
          t("Local voice daemon is offline or unauthorized. Start voice-daemon, download SenseVoice WASM models, or configure an OpenAI-compatible transcription API key in settings."),
        );
        return;
      }

      const session = this.ensureDaemonDictationSession();
      this.stopReadAloudSilently();
      if (this.workerClient?.isLoaded("tts-vits")) {
        void this.workerClient.unload();
      }
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
        this.notifyDictationTargetSettled();
        return;
      }

      if (startEpoch !== this.dictationStartEpoch || (fromPointerHold && !this.pointerHoldActive)) {
        await session.stop({ flush: true });
        return;
      }

      new Notice(
        mode === "single"
          ? t("Daemon dictation started (single utterance).")
          : mode === "push-to-talk"
            ? t("Push-to-talk started — invoke again or release to transcribe.")
            : t("Daemon dictation started."),
      );
    } finally {
      if (this.dictationStartEpoch === startEpoch) {
        this.startingDictation = false;
      }
    }
  }

  private async startCloudOpenAiDictation(
    mode: DictationMode,
    fromPointerHold: boolean,
  ): Promise<void> {
    let endpoint: ReturnType<typeof resolveTranscriptionsEndpointUrl>;
    try {
      endpoint = resolveTranscriptionsEndpointUrl(this.settings.asrEndpointUrl || undefined);
    } catch (err) {
      this.pointerHoldActive = false;
      this.notifyDictationTargetSettled();
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      new Notice(t("Invalid transcription endpoint URL: {0}", msg));
      return;
    }

    if (!endpoint.isLoopbackHttp) {
      const secretId = this.settings.asrApiKeySecretId;
      const apiKey = secretId ? this.secretStore.getSecret(secretId) : null;
      if (!apiKey || !apiKey.trim()) {
        this.pointerHoldActive = false;
        this.notifyDictationTargetSettled();
        new Notice(
          t("Configure a transcription API key in Voice Mode settings before starting BYOK dictation."),
        );
        return;
      }
    }

    const startEpoch = ++this.dictationStartEpoch;
    this.startingDictation = true;

    try {
      const session = this.ensureCloudDictationSession();

      // Stop active read-aloud and release any AEC barge-in mic capture before opening dictation mic.
      // If `workerClient` currently holds `tts-vits` (which blocks its Worker thread during synchronous
      // VITS generation), detach & terminate it immediately so SenseVoice starts in < 1s without queueing.
      this.stopReadAloudSilently();
      if (this.workerClient?.isLoaded("tts-vits")) {
        void this.workerClient.unload();
      }
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
        this.notifyDictationTargetSettled();
        // Detailed error Notice is already surfaced via CloudDictationSession.onError.
        return;
      }

      if (startEpoch !== this.dictationStartEpoch || (fromPointerHold && !this.pointerHoldActive)) {
        await session.stop({ flush: true });
        return;
      }

      new Notice(
        mode === "single"
          ? t("Cloud dictation started (single utterance).")
          : mode === "push-to-talk"
            ? t("Push-to-talk started — invoke again or release to transcribe.")
            : t("Cloud dictation started."),
      );
    } finally {
      if (this.dictationStartEpoch === startEpoch) {
        this.startingDictation = false;
      }
    }
  }

  private async startOfflineSenseVoiceDictation(
    mode: DictationMode,
    fromPointerHold: boolean,
  ): Promise<void> {
    const manager = this.ensureDesktopModelManager();
    if (!manager) {
      this.pointerHoldActive = false;
      new Notice(t("Local offline WASM dictation is disabled on mobile devices."));
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
        new Notice(t("Could not verify external model cache: {0}", msg));
        return;
      }

      if (startEpoch !== this.dictationStartEpoch || (fromPointerHold && !this.pointerHoldActive)) {
        return;
      }

      if (!status.ready) {
        this.pointerHoldActive = false;
        new Notice(
          t("Offline dictation models are not installed yet. Open Voice Mode settings to download and verify them."),
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
      // If `workerClient` currently holds `tts-vits` (which blocks its Worker thread during synchronous
      // VITS generation), detach & terminate it immediately so SenseVoice starts in < 1s without queueing.
      this.stopReadAloudSilently();
      if (this.workerClient?.isLoaded("tts-vits")) {
        void this.workerClient.unload();
      }
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
          ? t("Offline dictation started (single utterance).")
          : mode === "push-to-talk"
            ? t("Push-to-talk started — invoke again or release to transcribe.")
            : t("Offline dictation started (SenseVoice WASM)."),
      );
    } finally {
      if (this.dictationStartEpoch === startEpoch) {
        this.startingDictation = false;
      }
    }
  }

  private async startBrowserSpeechRecognitionFallback(
    mode: DictationMode = this.settings.dictationMode,
  ): Promise<void> {
    const win = activeWindow as SpeechRecognitionWindow;
    const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      this.notifyDictationTargetSettled();
      new Notice(
        this.capabilities.isMobile
          ? t("System speech recognition is unavailable in this mobile runtime.")
          : t("Browser speech recognition is unavailable in this desktop build. Switch recognition engine to SenseVoice WASM in settings for offline dictation."),
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
      recognition.continuous = mode !== "single";
      recognition.interimResults = true;

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
          this.showSubtitleOverlay(t("Dictating"), interimText.trim());
        }

        if (finalText.trim()) {
          const target = this.dictationTargetOverride ?? undefined;
          this.notifyDictationTargetSettled();
          void this.processAndCommitDictation(finalText, target);
        }
      };

      recognition.onerror = (event) => {
        this.listening = false;
        this.recognitionErrored = true;
        this.activeRecognition = null;
        this.notifyDictationTargetSettled();
        this.setStatus("error");
        this.hideSubtitleOverlay();
        if (!this.capabilities.isMobile && event.error === "network") {
          new Notice(
            t("Browser speech recognition is unavailable in this desktop build. Switch recognition engine to SenseVoice WASM in settings for 100% offline dictation."),
            7000,
          );
          return;
        }
        new Notice(t("Voice dictation error: {0}.", event.error));
      };

      recognition.onend = () => {
        if (this.activeRecognition === recognition) {
          this.activeRecognition = null;
        }
        this.listening = false;
        this.notifyDictationTargetSettled();
        if (this.recognitionErrored) {
          return;
        }
        if (this.polishAbortControllers.size === 0 && !this.speechPlayer?.isActive) {
          this.setStatus("idle");
        }
      };

      try {
        this.activeRecognition = recognition;
        this.listening = true;
        this.recognitionErrored = false;
        this.setStatus("listening");
        this.showSubtitleOverlay(t("Dictating"), t("Listening..."));
        recognition.start();
        new Notice(t("Voice dictation started."));
      } catch (err) {
        this.activeRecognition = null;
        this.listening = false;
        this.recognitionErrored = true;
        this.notifyDictationTargetSettled();
        this.setStatus("error");
        this.hideSubtitleOverlay();
        const message = redactSecrets(err instanceof Error ? err.message : String(err));
        new Notice(t("Could not start voice dictation: {0}", message));
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
    this.notifyDictationTargetSettled();
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
    if (
      this.polishAbortControllers.size === 0 &&
      !this.speechPlayer?.isActive &&
      this.currentStatus !== "idle"
    ) {
      this.setStatus("idle");
    }
    this.hideSubtitleOverlay();
  }

  async processAndCommitDictation(
    rawText: string,
    targetOverride?: (text: string) => void,
  ): Promise<void> {
    const replaced = createAsrReplacer(this.settings.asrReplacements)(rawText).trim();
    if (!replaced) {
      return;
    }

    let finalText = replaced;

    if (this.settings.enableLlmPolish && !targetOverride) {
      const controller = new AbortController();
      this.polishAbortControllers.add(controller);
      this.setStatus("busy", t("Polishing"));
      this.showSubtitleOverlay(t("Polishing"), t("Polishing transcript..."));

      try {
        const result = await polishDictatedTranscript(replaced, {
          settings: this.settings,
          secretStore: this.secretStore,
          fetchImpl: this.corsFetch,
          isMobile: this.capabilities.isMobile,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          this.commitDictatedTextSilently(replaced);
          return;
        }
        finalText = result.text.trim() || replaced;
        if (result.fallbackReason && !this.polishFallbackNotified) {
          this.polishFallbackNotified = true;
          new Notice(
            t("Transcript polish skipped ({0}); inserted unpolished text.", result.fallbackReason),
          );
        }
      } finally {
        this.polishAbortControllers.delete(controller);
        if (
          !controller.signal.aborted &&
          this.polishAbortControllers.size === 0 &&
          !this.isMicSessionActive() &&
          !this.speechPlayer?.isActive &&
          this.currentStatus !== "error"
        ) {
          this.setStatus("idle");
        }
      }
    }

    if (targetOverride) {
      targetOverride(finalText);
    } else {
      this.commitDictatedText(finalText);
    }
    this.showSubtitleOverlay(t("Inserted"), finalText, 2400);
  }

  private resolveTargetMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.editor) {
      return active;
    }
    const mostRecent = this.app.workspace.getMostRecentLeaf?.()?.view;
    if (mostRecent instanceof MarkdownView && mostRecent.editor) {
      return mostRecent;
    }
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.editor) {
        return leaf.view;
      }
    }
    return null;
  }

  private openVoiceQaModal(): void {
    if (!this.settings.enableVoiceQa) {
      new Notice(t("Enable optional BYOK voice assistant in Voice Mode settings first."));
      return;
    }

    if (this.activeQaModal) {
      const existing = this.activeQaModal;
      this.activeQaModal = null;
      existing.close();
    }

    const originView = this.resolveTargetMarkdownView();
    const noteTitle = originView?.file?.basename ?? undefined;
    const context = extractNoteQaContext(originView?.editor ?? null, noteTitle);

    let qaReadAloudStarted = false;
    const modal = new VoiceQaModal(this.app, context, {
      settings: this.settings,
      secretStore: this.secretStore,
      fetchImpl: this.corsFetch,
      isMobile: this.capabilities.isMobile,
      isDictating: () => this.isMicSessionActive(),
      onDictateQuestion: async (onTranscript, onSettled) => {
        if (this.isMicSessionActive()) {
          await this.toggleDictation("single");
          return;
        }
        this.dictationTargetOverride = onTranscript;
        this.dictationTargetSettled = onSettled ?? null;
        await this.toggleDictation("single");
        if (!this.isMicSessionActive()) {
          this.notifyDictationTargetSettled();
        }
      },
      onCancelDictation: () => {
        this.abortActiveDictationSilently();
      },
      onSpeakSentence: (sentence) => {
        if (!this.speechPlayer) {
          return;
        }
        if (!qaReadAloudStarted) {
          qaReadAloudStarted = true;
          this.daemonTtsFallbackNotified = false;
          this.daemonTtsFallbackTarget = null;
          this.syncSpeechPlayerEngines();
          this.overflowNotified = false;
          this.speechPlayer.cancel();
          this.readingNotePath = originView?.file?.path ?? null;
        }
        this.speechPlayer.speakSentences([sentence]);
      },
      onStopReadAloud: () => {
        qaReadAloudStarted = false;
        this.stopReadAloudSilently();
      },
      onInsertAtCursor: (answer) => {
        const targetView = originView?.editor ? originView : this.resolveTargetMarkdownView();
        if (!targetView?.editor) {
          return false;
        }
        return insertDictatedText(targetView.editor, answer);
      },
      onModalClose: () => {
        if (this.activeQaModal === modal) {
          this.activeQaModal = null;
        }
      },
    });

    this.activeQaModal = modal;
    modal.open();
  }

  private notifyDictationTargetSettled(): void {
    const settled = this.dictationTargetSettled;
    this.dictationTargetSettled = null;
    this.dictationTargetOverride = null;
    settled?.();
  }

  private abortActiveDictationSilently(): void {
    this.dictationStartEpoch += 1;
    this.startingDictation = false;
    this.pointerHoldActive = false;
    this.notifyDictationTargetSettled();
    if (this.offlineSession && this.offlineSession.state !== "idle") {
      void this.offlineSession.abort();
    }
    if (this.cloudSession && this.cloudSession.state !== "idle") {
      void this.cloudSession.abort();
    }
    if (this.daemonSession && this.daemonSession.state !== "idle") {
      void this.daemonSession.abort();
    }
    if (this.listening || this.activeRecognition) {
      this.stopBrowserRecognition();
    }
    if (
      this.polishAbortControllers.size === 0 &&
      !this.speechPlayer?.isActive &&
      this.currentStatus !== "error"
    ) {
      this.setStatus("idle");
      this.hideSubtitleOverlay();
    }
  }

  private commitDictatedTextSilently(text: string): boolean {
    try {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const activeEl = resolveDeepActiveElement(activeDocument);

      // 1. If the active MarkdownView CodeMirror 6 editor owns focus, always route through CM6 API
      //    instead of hijacking its internal contenteditable DOM directly.
      if (activeView?.editor && isMarkdownEditorFocused(activeView.containerEl, activeEl)) {
        return insertDictatedText(activeView.editor, text);
      }

      // 2. Otherwise insert into an external focused input (e.g. sidebar Copilot Lexical / AI chat box).
      if (insertIntoFocusedInput(activeDocument, text)) {
        return true;
      }

      // 3. Fallback to the active or most recent open Markdown editor if focus moved to chrome/body.
      const fallbackView = this.resolveTargetMarkdownView();
      if (fallbackView?.editor) {
        return insertDictatedText(fallbackView.editor, text);
      }
    } catch {
      // Best-effort insertion during plugin unload; ignore torn-down workspace errors.
    }
    return false;
  }

  commitDictatedText(text: string): void {
    if (!this.commitDictatedTextSilently(text)) {
      new Notice(t("No active editor or text input found for dictated text."));
    }
  }

  /**
   * Export the selection/note to a single WAV file using a WAV-producing engine
   * (local VITS or voice-daemon). System speech has no PCM to export.
   */
  private async exportReadAloudWav(): Promise<void> {
    if (this.exportInProgress) {
      new Notice(t("An export is already running."));
      return;
    }
    this.exportInProgress = true;
    try {
      await this.exportReadAloudWavInner();
    } finally {
      this.exportInProgress = false;
    }
  }

  private async exportReadAloudWavInner(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      new Notice(t("Open a note to export read-aloud audio."));
      return;
    }
    const rawSentences = extractReadableText(view.editor, {
      maxSentenceChars: this.settings.maxSentenceChars,
      tablePolicy: this.settings.markdownTablePolicy,
    });
    // P1-2 pronunciation dictionary: rewrite text before TTS (e.g. "API" -> "A P I").
    const pronunciationReplacer =
      this.settings.pronunciationDict.length > 0
        ? createAsrReplacer(this.settings.pronunciationDict)
        : null;
    const sentences = pronunciationReplacer
      ? rawSentences.map((sentence) => pronunciationReplacer(sentence))
      : rawSentences;
    if (sentences.length === 0) {
      new Notice(t("No readable text found in the selection or note."));
      return;
    }
    const effectiveTts = this.getEffectiveTtsEngine();
    if (effectiveTts === "system") {
      new Notice(
        t("Export needs a WAV speech engine (local VITS or voice-daemon), not system speech."),
      );
      return;
    }
    if (effectiveTts === "vits-wasm") {
      const manager = this.ensureDesktopModelManager();
      if (!manager) {
        new Notice(t("Local offline VITS speech synthesis is only available on desktop."));
        return;
      }
      let status: DictationStackStatus;
      try {
        status = await manager.checkStatus();
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        new Notice(t("Could not verify external model cache: {0}", msg));
        return;
      }
      if (!status.vitsReady) {
        new Notice(
          t(
            "Optional local VITS model is not installed yet. Download it in Voice Mode settings or switch speech engine to system.",
          ),
        );
        return;
      }
    }
    this.syncSpeechPlayerEngines();
    const player = this.speechPlayer;
    if (!player) {
      new Notice(t("Read-aloud is not currently active."));
      return;
    }
    const progress = new Notice(t("Exporting {0} sentences...", sentences.length), 0);
    try {
      const result = await player.exportSentences(sentences);
      progress.hide();
      if (!result.wav) {
        new Notice(t("Selected engine cannot export audio (no WAV output)."));
        return;
      }
      const buffer = result.wav.buffer.slice(
        result.wav.byteOffset,
        result.wav.byteOffset + result.wav.byteLength,
      ) as ArrayBuffer;
      const base = view.file?.basename ?? "note";
      const file = await this.app.vault.createBinary(`${base}-readaloud-${Date.now()}.wav`, buffer);
      new Notice(t("Exported {0} sentences to {1}.", result.sentences, file.path));
    } catch (err) {
      progress.hide();
      const msg = redactSecrets(err instanceof Error ? err.message : String(err));
      new Notice(t("Export failed: {0}", msg));
    }
  }

  /** Resume the last read-aloud position for the active note (P4). */
  private async resumeReadAloud(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const resume = this.settings.readAloudResume;
    const path = view?.file?.path ?? "";
    if (!view || !resume || resume.path !== path) {
      if (resume && resume.path !== path) {
        new Notice(t("Nothing to resume for this note; reading from the beginning."));
      }
      await this.readSelectionOrNoteAloud();
      return;
    }
    await this.readSelectionOrNoteAloud({ startIndex: resume.sentenceIndex });
  }

  private async readSelectionOrNoteAloud(options: { startIndex?: number } = {}): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.editor) {
      new Notice(t("Open a Markdown note to read aloud."));
      return;
    }

    const rawSentences = extractReadableText(view.editor, {
      maxSentenceChars: this.settings.maxSentenceChars,
      tablePolicy: this.settings.markdownTablePolicy,
    });
    // P1-2 pronunciation dictionary: rewrite text before TTS (e.g. "API" -> "A P I").
    const pronunciationReplacer =
      this.settings.pronunciationDict.length > 0
        ? createAsrReplacer(this.settings.pronunciationDict)
        : null;
    const sentences = pronunciationReplacer
      ? rawSentences.map((sentence) => pronunciationReplacer(sentence))
      : rawSentences;

    if (sentences.length === 0) {
      new Notice(t("No readable text found in the selection or note."));
      return;
    }

    const startEpoch = ++this.readAloudStartEpoch;
    if (
      this.capabilities.isMobile &&
      !this.settings.allowCloudFallbackOnMobile &&
      isCloudTtsEngine(this.settings.ttsEngine)
    ) {
      new Notice(
        t("Cloud speech synthesis is disabled on mobile by privacy settings; using system speech synthesis."),
      );
    }
    const effectiveTts = this.getEffectiveTtsEngine();

    if (effectiveTts === "vits-wasm") {
      const manager = this.ensureDesktopModelManager();
      if (!manager) {
        new Notice(t("Local offline VITS speech synthesis is only available on desktop."));
        return;
      }
      let status: DictationStackStatus;
      try {
        status = await manager.checkStatus();
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        new Notice(t("Could not verify external model cache: {0}", msg));
        return;
      }
      if (startEpoch !== this.readAloudStartEpoch) {
        return;
      }
      if (!status.vitsReady) {
        new Notice(
          t("Optional local VITS model is not installed yet. Download it in Voice Mode settings or switch speech engine to system."),
        );
        return;
      }
    }

    this.abortActiveDictationSilently();

    this.daemonTtsFallbackNotified = false;
    this.daemonTtsFallbackTarget = null;
    this.syncSpeechPlayerEngines();
    this.overflowNotified = false;
    this.speechPlayer?.cancel();
    this.readingNotePath = view.file?.path ?? null;
    const startIndex = Math.min(
      Math.max(0, options.startIndex ?? 0),
      Math.max(0, sentences.length - 1),
    );
    this.activeReadAloudIndex = startIndex;
    if (this.readingNotePath) {
      this.settings.readAloudResume = { path: this.readingNotePath, sentenceIndex: startIndex };
      void this.saveSettings();
    }
    const queued = this.speechPlayer?.speakSentences(sentences.slice(startIndex)) ?? 0;
    if (queued > 0) {
      new Notice(queued === 1 ? t("Reading 1 sentence aloud.") : t("Reading {0} sentences aloud.", queued));
    }
  }

  private togglePauseReadAloud(): void {
    if (!this.speechPlayer?.isActive) {
      new Notice(t("Read-aloud is not currently active."));
      return;
    }
    this.speechPlayer.togglePause();
  }

  private skipReadAloudSentence(): void {
    if (!this.speechPlayer?.isActive) {
      new Notice(t("Read-aloud is not currently active."));
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
      new Notice(t("Read-aloud is not currently playing."));
      return;
    }
    this.stopReadAloudSilently();
    new Notice(t("Read-aloud stopped."));
  }

  /** Copy a structured runtime snapshot for bug reports (clipboard). */
  private async copyRuntimeStatus(): Promise<void> {
    try {
      const payload = await this.collectRuntimeStatusJson();
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      new Notice(t("Voice runtime status copied to clipboard."));
    } catch {
      new Notice(t("Could not copy the status (clipboard unavailable)."));
    }
  }

  private async collectRuntimeStatusJson(): Promise<Record<string, unknown>> {
    const modelStatus = await this.getModelStatus().catch(() => null);
    const effectiveTts = this.getEffectiveTtsEngine();
    return {
      version: this.manifest.version,
      platform: Platform.isDesktop ? "desktop" : "mobile",
      hostClass: this.capabilities.hostClass,
      asrEngine: this.getEffectiveAsrEngine(),
      ttsEngine: effectiveTts,
      ttsEngineMounted: this.speechPlayer?.hasRegisteredEngine(effectiveTts) ?? null,
      bargeInMode: this.settings.bargeInMode,
      localWasm: {
        allowed: this.capabilities.allowLocalWasmModels,
        ready: modelStatus?.ready ?? null,
        vitsReady: modelStatus?.vitsReady ?? null,
      },
      secretStorageAvailable: this.secretStore.available,
      readAloudState: this.speechPlayer?.state ?? "unavailable",
    };
  }

  private async showRuntimeStatusNotice(): Promise<void> {
    const effectiveAsr = this.getEffectiveAsrEngine();
    const effectiveTts = this.getEffectiveTtsEngine();
    const usesSystemTts =
      effectiveTts === "system" ||
      !this.speechPlayer?.hasRegisteredEngine(effectiveTts) ||
      (effectiveTts === "kokoro-daemon" && this.daemonTtsFallbackTarget === "system");
    const bargeIn =
      this.lastBargeInDecision ??
      resolveBargeInPolicy({
        requestedMode: this.settings.bargeInMode,
        usesSystemTts,
        isMobile: this.capabilities.isMobile,
        isSafari: Platform.isSafari,
        nativeAecActive: false,
      });

    let wasmLabel = t("disabled (mobile OOM safeguard)");
    if (this.capabilities.allowLocalWasmModels) {
      const status = await this.getModelStatus().catch(() => null);
      const vitsLabel = status?.vitsReady ? t(", VITS ready") : "";
      wasmLabel = status?.ready
        ? t("ready (SHA256 verified{0}, budget {1} MB)", vitsLabel, this.capabilities.maxLocalModelMemoryMb)
        : t("not downloaded{0} (budget {1} MB)", vitsLabel, this.capabilities.maxLocalModelMemoryMb);
    }

    const secretLabel = this.secretStore.available
      ? t("ready ({0} stored)", this.secretStore.listSecrets().length)
      : t("unavailable (upgrade >= 1.11.4)");

    new Notice(
      t(
        "Host: {0} | ASR: {1} ({2}) | TTS: {3} | Local WASM: {4} | Secret storage: {5} | Barge-in: {6}",
        t(this.capabilities.hostClass),
        effectiveAsr,
        t(this.settings.dictationMode),
        effectiveTts,
        wasmLabel,
        secretLabel,
        t(bargeIn.policy),
      ),
      6500,
    );
  }
}
