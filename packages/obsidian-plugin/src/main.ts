import { createAsrReplacer, redactSecrets } from "@voice-mode/core";
import { resolveBargeInPolicy } from "@voice-mode/browser";
import { MarkdownView, Notice, Platform, Plugin } from "obsidian";
import {
  extractReadableText,
  insertDictatedText,
  insertIntoFocusedInput,
  isMarkdownEditorFocused,
  resolveDeepActiveElement,
} from "./editor-bridge.ts";
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

type VoiceStatusKind = "idle" | "listening" | "speaking" | "error";

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
  speaking: "vm-is-speaking",
  error: "vm-is-error",
};

const STATUS_LABEL_MAP: Readonly<Record<VoiceStatusKind, string>> = {
  idle: "Voice idle",
  listening: "Listening",
  speaking: "Reading aloud",
  error: "Voice error",
};

export default class VoiceModePlugin extends Plugin implements VoiceModePluginHost {
  settings: VoiceModeSettings = createDefaultSettings();
  capabilities: RuntimeCapabilities = detectRuntimeCapabilities(
    Platform.isMobile,
    detectDesktopOsHint(),
  );

  private secretStore: ObsidianSecretStore = new ObsidianSecretStore(null);
  private speechPlayer: SpeechPlayer | null = null;
  private statusBarEl: HTMLElement | null = null;
  private statusLabelEl: HTMLElement | null = null;
  private subtitleOverlayEl: HTMLElement | null = null;
  private subtitleRoleEl: HTMLElement | null = null;
  private subtitleTextEl: HTMLElement | null = null;
  private subtitleHideTimer: number | null = null;
  private activeRecognition: BrowserSpeechRecognition | null = null;
  private listening = false;
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
          } else if (!this.listening && this.currentStatus !== "error") {
            this.setStatus("idle");
            this.hideSubtitleOverlay();
          }
        },
        onSentenceStart: (sentence) => {
          this.showSubtitleOverlay("Reading aloud", sentence);
        },
        onEngineFallback: (requested) => {
          new Notice(
            `Speech engine "${requested}" is not mounted in 0.1.0; falling back to system speech synthesis.`,
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
      this.toggleDictation();
    });

    this.addCommand({
      id: "toggle-dictation",
      name: "Toggle voice dictation",
      callback: () => {
        this.toggleDictation();
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
        this.showRuntimeStatusNotice();
      },
    });

    this.addSettingTab(new VoiceModeSettingTab(this.app, this));
  }

  onunload(): void {
    this.stopDictation();
    this.clearSubtitleHideTimer();

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
    this.settings = normalizeSettings(raw);
  }

  async saveSettings(): Promise<void> {
    const sanitized = stripSecretsFromSettings(this.settings);
    this.settings = normalizeSettings(sanitized);
    await this.saveData(sanitized);

    if (this.speechPlayer) {
      const effectiveTts = resolveEffectiveTtsEngine(this.settings.ttsEngine, this.capabilities);
      this.speechPlayer.updateConfig({
        engine: effectiveTts,
        voice: this.settings.ttsVoice,
        rate: this.settings.speechRate,
        language: this.settings.dictationLanguage,
      });
    }

    if (!this.settings.enableSubtitleOverlay) {
      this.hideSubtitleOverlay();
    }
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

    this.registerDomEvent(item, "click", () => {
      if (this.speechPlayer?.isSpeaking) {
        this.stopReadAloud();
      } else {
        this.toggleDictation();
      }
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

  private setStatus(next: VoiceStatusKind): void {
    this.currentStatus = next;
    if (!this.statusBarEl || !this.statusLabelEl) {
      return;
    }
    for (const cls of Object.values(STATUS_CLASS_MAP)) {
      this.statusBarEl.removeClass(cls);
    }
    this.statusBarEl.addClass(STATUS_CLASS_MAP[next]);
    this.statusLabelEl.setText(STATUS_LABEL_MAP[next]);
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

  private toggleDictation(): void {
    if (this.listening) {
      this.stopDictation();
      new Notice("Voice dictation stopped.");
      return;
    }

    const effectiveAsr = resolveEffectiveAsrEngine(this.settings.asrEngine, this.capabilities);
    if (effectiveAsr !== "system") {
      new Notice(
        `Offline WASM and provider dictation (${effectiveAsr}) is scheduled for milestone M1; 0.1.0 currently provides browser-native speech recognition fallback where supported.`,
      );
      return;
    }

    const win = activeWindow as SpeechRecognitionWindow;
    const RecognitionCtor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      new Notice(
        this.capabilities.isMobile
          ? "System speech recognition is unavailable in this mobile runtime."
          : "Browser-native speech recognition is unavailable in this desktop build. Offline local WASM dictation is scheduled for milestone M1.",
      );
      return;
    }

    // Pause active read-aloud before capturing microphone input to prevent echo loops.
    this.speechPlayer?.cancel();

    const recognition = new RecognitionCtor();
    recognition.lang = this.settings.dictationLanguage;
    recognition.continuous = true;
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

  private stopDictation(): void {
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

  private commitDictatedText(text: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeEl = resolveDeepActiveElement(activeDocument);

    // 1. If the active MarkdownView CodeMirror 6 editor owns focus, always route through CM6 API
    //    instead of hijacking its internal contenteditable DOM directly.
    if (view?.editor && isMarkdownEditorFocused(view.containerEl, activeEl)) {
      insertDictatedText(view.editor, text);
      return;
    }

    // 2. Otherwise insert into an external focused input (e.g. sidebar Copilot / AI chat box).
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

    if (this.listening) {
      this.stopDictation();
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

  private showRuntimeStatusNotice(): void {
    const effectiveAsr = resolveEffectiveAsrEngine(this.settings.asrEngine, this.capabilities);
    const effectiveTts = resolveEffectiveTtsEngine(this.settings.ttsEngine, this.capabilities);
    // Honest AEC status: nativeAecActive stays false until M2 probes live MediaStreamTrack AEC.
    const bargeIn = resolveBargeInPolicy({
      isMobile: this.capabilities.isMobile,
      isSafari: Platform.isSafari,
      nativeAecActive: false,
    });
    const wasmLabel = this.capabilities.allowLocalWasmModels
      ? `enabled (desktop, budget ${this.capabilities.maxLocalModelMemoryMb} MB)`
      : "disabled (mobile OOM safeguard)";
    const secretLabel = this.secretStore.available
      ? `ready (${this.secretStore.listSecrets().length} stored)`
      : "unavailable (upgrade >= 1.11.4)";

    new Notice(
      `Host: ${this.capabilities.hostClass} | ASR: ${effectiveAsr} | TTS: ${effectiveTts} | Local WASM: ${wasmLabel} | Secret storage: ${secretLabel} | Barge-in: ${bargeIn.policy}`,
      6000,
    );
  }
}
