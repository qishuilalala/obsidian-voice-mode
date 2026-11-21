import {
  MODEL_BUNDLES,
  buildMemfsSherpaGlue,
  createAsrReplacer,
  redactSecrets,
} from "@voice-mode/core";
import {
  OfflineDictationSession,
  SherpaWorkerClient,
  createSherpaWorkerScript,
  resolveBargeInPolicy,
  type DictationMode,
  type DictationSessionState,
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
import {
  detectRuntimeCapabilities,
  resolveEffectiveAsrEngine,
  resolveEffectiveTtsEngine,
  type RuntimeCapabilities,
} from "./runtime-guard.ts";
import {
  ObsidianSecretStore,
  createDefaultSettings,
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
  private speechPlayer: SpeechPlayer | null = null;
  private modelManager: DesktopModelManager | null = null;
  private modelManagerConfigKey = "";
  private workerClient: SherpaWorkerClient | null = null;
  private offlineSession: OfflineDictationSession | null = null;
  private downloadAbortController: AbortController | null = null;

  private statusBarEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private subtitleOverlayEl: HTMLElement | null = null;
  private subtitleRoleEl: HTMLElement | null = null;
  private subtitleTextEl: HTMLElement | null = null;
  private subtitleHideTimer: number | null = null;
  private activeRecognition: BrowserSpeechRecognition | null = null;
  private listening = false;
  private startingDictation = false;
  private dictationStartEpoch = 0;
  private pointerHoldActive = false;
  private recognitionErrored = false;
  private overflowNotified = false;
  private currentStatus: VoiceStatusKind = "idle";

  async onload(): Promise<void> {
    this.capabilities = detectRuntimeCapabilities(Platform.isMobile, detectDesktopOsHint());
    this.secretStore = new ObsidianSecretStore(
      hasSecretStorage(this.app) ? this.app.secretStorage : null,
    );
    await this.loadSettings();

    const effectiveTts = resolveEffectiveTtsEngine(this.settings.ttsEngine, this.capabilities);
    this.speechPlayer = new SpeechPlayer(
      {
        engine: effectiveTts,
        voice: this.settings.ttsVoice,
        rate: this.settings.speechRate,
        language: this.settings.dictationLanguage,
      },
      {
        onStateChange: (state) => {
          if (state === "playing") {
            this.setStatus("speaking");
          } else if (!this.isDictationBusy() && this.currentStatus !== "error") {
            this.setStatus("idle");
            this.hideSubtitleOverlay();
          }
        },
        onSentenceStart: (sentence) => {
          this.showSubtitleOverlay("Reading aloud", sentence);
        },
        onEngineFallback: (requested) => {
          new Notice(
            `Speech engine "${requested}" is scheduled for milestone M2; falling back to system speech synthesis.`,
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
          this.setStatus("error");
          this.hideSubtitleOverlay();
          new Notice(`Read-aloud failed: ${message}`);
        },
      },
      () => activeWindow,
    );

    this.mountStatusBar();
    this.mountSubtitleOverlay(activeDocument);

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
        this.readSelectionOrNoteAloud();
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
    this.startingDictation = false;
    this.pointerHoldActive = false;
    this.cancelModelDownload();
    this.stopBrowserRecognition();
    this.clearSubtitleHideTimer();

    if (this.offlineSession) {
      void this.offlineSession.abort();
      this.offlineSession = null;
    }

    if (this.workerClient) {
      void this.workerClient.dispose();
      this.workerClient = null;
    }

    this.modelManager = null;

    if (this.speechPlayer) {
      void this.speechPlayer.dispose();
      this.speechPlayer = null;
    }

    if (this.subtitleOverlayEl) {
      this.subtitleOverlayEl.remove();
      this.subtitleOverlayEl = null;
      this.subtitleRoleEl = null;
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

    if (this.speechPlayer) {
      const effectiveTts = resolveEffectiveTtsEngine(this.settings.ttsEngine, this.capabilities);
      this.speechPlayer.updateConfig({
        engine: effectiveTts,
        voice: this.settings.ttsVoice,
        rate: this.settings.speechRate,
        language: this.settings.dictationLanguage,
      });
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

    if (!this.settings.enableSubtitleOverlay) {
      this.hideSubtitleOverlay();
    }
  }

  getVaultBasePath(): string | null {
    return getVaultBasePath(this.app.vault.adapter as { getBasePath?: () => string });
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
    this.startingDictation = false;
    this.pointerHoldActive = false;
    if (this.offlineSession && this.offlineSession.state !== "idle") {
      await this.offlineSession.abort();
    }
    if (this.workerClient) {
      await this.workerClient.unload();
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

    if (this.workerClient) {
      void this.workerClient.dispose();
      this.workerClient = null;
      this.offlineSession = null;
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

  private ensureOfflineDictationSession(): OfflineDictationSession | null {
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

    if (!this.offlineSession) {
      this.offlineSession = new OfflineDictationSession({
        workerClient: this.workerClient,
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
        if (!this.speechPlayer?.isSpeaking && this.currentStatus !== "error") {
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
      if (ev.button !== 0 || this.speechPlayer?.isSpeaking) {
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
      if (this.speechPlayer?.isSpeaking) {
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
      this.subtitleRoleEl = null;
      this.subtitleTextEl = null;
    }
    const body = targetDoc.body;
    if (!body) {
      return;
    }
    const overlay = body.createDiv({ cls: "vm-subtitle-overlay vm-subtitle-hidden" });
    const card = overlay.createDiv({ cls: "vm-subtitle-card" });
    this.subtitleRoleEl = card.createDiv({ cls: "vm-subtitle-role" });
    this.subtitleTextEl = card.createDiv({ cls: "vm-subtitle-text" });
    this.subtitleOverlayEl = overlay;
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

  private showSubtitleOverlay(role: string, text: string, autoHideMs?: number): void {
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
    this.subtitleRoleEl?.setText(role);
    this.subtitleTextEl?.setText(text);
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
      if (!this.speechPlayer?.isSpeaking && this.currentStatus !== "error") {
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

    const effectiveAsr = resolveEffectiveAsrEngine(this.settings.asrEngine, this.capabilities);
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

    this.startBrowserSpeechRecognitionFallback();
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

      // Pause active read-aloud before capturing microphone input to prevent echo loops.
      this.speechPlayer?.cancel();

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

  private startBrowserSpeechRecognitionFallback(): void {
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

    this.speechPlayer?.cancel();

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
      if (!this.speechPlayer?.isSpeaking) {
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
    if (!this.speechPlayer?.isSpeaking && this.currentStatus !== "idle") {
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

  private readSelectionOrNoteAloud(): void {
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

    this.dictationStartEpoch += 1;
    this.startingDictation = false;
    this.pointerHoldActive = false;
    if (this.offlineSession && this.offlineSession.state !== "idle") {
      void this.offlineSession.abort();
    }
    if (this.listening || this.activeRecognition) {
      this.stopBrowserRecognition();
    }

    this.overflowNotified = false;
    this.speechPlayer?.cancel();
    const queued = this.speechPlayer?.speakSentences(sentences) ?? 0;
    if (queued > 0) {
      new Notice(`Reading ${queued} ${queued === 1 ? "sentence" : "sentences"} aloud.`);
    }
  }

  private stopReadAloud(): void {
    if (!this.speechPlayer?.isSpeaking) {
      new Notice("Read-aloud is not currently playing.");
      return;
    }
    this.speechPlayer.cancel();
    this.hideSubtitleOverlay();
    this.setStatus("idle");
    new Notice("Read-aloud stopped.");
  }

  private async showRuntimeStatusNotice(): Promise<void> {
    const effectiveAsr = resolveEffectiveAsrEngine(this.settings.asrEngine, this.capabilities);
    const effectiveTts = resolveEffectiveTtsEngine(this.settings.ttsEngine, this.capabilities);
    const bargeIn = resolveBargeInPolicy({
      isMobile: this.capabilities.isMobile,
      isSafari: Platform.isSafari,
      nativeAecActive: false,
    });

    let wasmLabel = "disabled (mobile OOM safeguard)";
    if (this.capabilities.allowLocalWasmModels) {
      const status = await this.getModelStatus().catch(() => null);
      wasmLabel = status?.ready
        ? `ready (SHA256 verified, budget ${this.capabilities.maxLocalModelMemoryMb} MB)`
        : `not downloaded (budget ${this.capabilities.maxLocalModelMemoryMb} MB)`;
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
