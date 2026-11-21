import {
  SentenceSegmenter,
  applyCorrectionGuards,
  completeChat,
  correctionSystem,
  redactSecrets,
  resolveLlmEndpoint,
  streamChat,
  type LlmRouterConfig,
  type MarkdownTablePolicy,
  type SecretStore,
} from "@voice-mode/core";
import { Modal, Notice, type App } from "obsidian";
import { getLlmSecretId, type VoiceModeSettings } from "./settings.ts";

export const MAX_NOTE_CONTEXT_CHARS = 24_000;

export interface NoteQaContext {
  scope: "selection" | "note" | "empty";
  text: string;
  truncated: boolean;
  noteTitle?: string;
}

export interface ResolvePluginLlmOptions {
  settings: VoiceModeSettings;
  secretStore: SecretStore;
  fetchImpl: typeof fetch;
  isMobile: boolean;
  timeoutMs?: number;
  streamIdleTimeoutMs?: number;
}

export interface PolishDictationOptions {
  settings: VoiceModeSettings;
  secretStore: SecretStore;
  fetchImpl: typeof fetch;
  isMobile: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PolishDictationResult {
  text: string;
  polished: boolean;
  fallbackReason?: string;
}

export interface VoiceQaStreamOptions {
  settings: VoiceModeSettings;
  secretStore: SecretStore;
  fetchImpl: typeof fetch;
  isMobile: boolean;
  signal?: AbortSignal;
  maxSentenceChars?: number;
  tablePolicy?: MarkdownTablePolicy;
  onDelta?: (delta: string, fullText: string) => void;
  onSentence?: (sentence: string) => void;
}

export interface VoiceQaModalCallbacks {
  readonly settings: VoiceModeSettings;
  readonly secretStore: SecretStore;
  readonly fetchImpl: typeof fetch;
  readonly isMobile: boolean;
  isDictating?: () => boolean;
  onDictateQuestion: (
    onTranscript: (text: string) => void,
    onSettled?: () => void,
  ) => Promise<void> | void;
  onCancelDictation?: () => void;
  onSpeakSentence: (sentence: string) => void;
  onStopReadAloud: () => void;
  onInsertAtCursor: (answer: string) => boolean;
  onModalClose?: () => void;
}

/**
 * Extract active editor selection (preferred) or full note body for grounded Voice Q&A,
 * capping context size to `MAX_NOTE_CONTEXT_CHARS`.
 */
export function extractNoteQaContext(
  editor: { getSelection(): string; getValue(): string } | null | undefined,
  noteTitle?: string,
): NoteQaContext {
  const cleanTitle =
    typeof noteTitle === "string" && noteTitle.trim().length > 0 ? noteTitle.trim() : undefined;
  const titleProp = cleanTitle !== undefined ? { noteTitle: cleanTitle } : {};

  if (!editor) {
    return {
      scope: "empty",
      text: "",
      truncated: false,
      ...titleProp,
    };
  }

  const selected = editor.getSelection().trim();
  if (selected.length > 0) {
    const truncated = selected.length > MAX_NOTE_CONTEXT_CHARS;
    return {
      scope: "selection",
      text: truncated ? selected.slice(0, MAX_NOTE_CONTEXT_CHARS) : selected,
      truncated,
      ...titleProp,
    };
  }

  const noteBody = editor.getValue().trim();
  if (noteBody.length > 0) {
    const truncated = noteBody.length > MAX_NOTE_CONTEXT_CHARS;
    return {
      scope: "note",
      text: truncated ? noteBody.slice(0, MAX_NOTE_CONTEXT_CHARS) : noteBody,
      truncated,
      ...titleProp,
    };
  }

  return {
    scope: "empty",
    text: "",
    truncated: false,
    ...titleProp,
  };
}

/**
 * Build a validated `LlmRouterConfig` from plugin settings and `SecretStore`, enforcing
 * mobile cloud-fallback privacy settings before any network request is attempted.
 */
export function resolvePluginLlmConfig(options: ResolvePluginLlmOptions): LlmRouterConfig {
  const { settings, secretStore, fetchImpl, isMobile } = options;
  const secretId = getLlmSecretId(settings, settings.llmPresetId);
  const rawSecret = secretId ? secretStore.getSecret(secretId) : null;
  if (rawSecret instanceof Promise) {
    throw new Error("Asynchronous secret store requires pre-resolved credentials.");
  }
  const apiKey =
    typeof rawSecret === "string" && rawSecret.trim().length > 0 ? rawSecret.trim() : undefined;

  const config: LlmRouterConfig = {
    presetId: settings.llmPresetId,
    baseUrl: settings.llmBaseUrl || undefined,
    model: settings.llmModel || undefined,
    apiKey,
    fetchImpl,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {}),
  };

  const endpoint = resolveLlmEndpoint(config);
  const isLoopback = endpoint.url.startsWith("http://");

  if (isMobile && !settings.allowCloudFallbackOnMobile && !isLoopback) {
    throw new Error("Cloud AI requests are disabled on mobile by privacy settings.");
  }

  return config;
}

async function resolvePluginLlmConfigAsync(
  options: ResolvePluginLlmOptions,
): Promise<LlmRouterConfig> {
  const { settings, secretStore, fetchImpl, isMobile } = options;
  const secretId = getLlmSecretId(settings, settings.llmPresetId);
  const rawSecret = secretId ? await secretStore.getSecret(secretId) : null;
  const apiKey =
    typeof rawSecret === "string" && rawSecret.trim().length > 0 ? rawSecret.trim() : undefined;

  const config: LlmRouterConfig = {
    presetId: settings.llmPresetId,
    baseUrl: settings.llmBaseUrl || undefined,
    model: settings.llmModel || undefined,
    apiKey,
    fetchImpl,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: options.streamIdleTimeoutMs }
      : {}),
  };

  const endpoint = resolveLlmEndpoint(config);
  const isLoopback = endpoint.url.startsWith("http://");

  if (isMobile && !settings.allowCloudFallbackOnMobile && !isLoopback) {
    throw new Error("Cloud AI requests are disabled on mobile by privacy settings.");
  }

  return config;
}

/**
 * Post-dictation LLM polish with 4-layer anti-hallucination guards and zero-data-loss fallback.
 * Never rejects: on any configuration, privacy, timeout, or HTTP error, returns `rawText` intact.
 */
export async function polishDictatedTranscript(
  rawText: string,
  options: PolishDictationOptions,
): Promise<PolishDictationResult> {
  if (!options.settings.enableLlmPolish || !rawText.trim()) {
    return { text: rawText, polished: false };
  }

  try {
    const llmConfig = await resolvePluginLlmConfigAsync({
      settings: options.settings,
      secretStore: options.secretStore,
      fetchImpl: options.fetchImpl,
      isMobile: options.isMobile,
      timeoutMs: options.timeoutMs ?? 8_000,
    });

    const lang = options.settings.dictationLanguage.trim().toLowerCase().startsWith("en")
      ? "en"
      : "zh";

    const candidate = await completeChat(llmConfig, {
      system: correctionSystem(lang),
      messages: [{ role: "user", content: rawText }],
      temperature: 0.1,
      maxTokens: Math.min(1024, Math.max(128, rawText.length * 4)),
      signal: options.signal,
    });

    const guarded = applyCorrectionGuards(rawText, candidate);
    return {
      text: guarded,
      polished: guarded !== rawText,
    };
  } catch (err) {
    const rawReason = err instanceof Error ? err.message : String(err);
    return {
      text: rawText,
      polished: false,
      fallbackReason: redactSecrets(rawReason),
    };
  }
}

function buildVoiceQaSystemPrompt(): string {
  return [
    "You are a concise, grounded assistant inside Obsidian.",
    "Answer directly based on the provided selection or note context when relevant, and state clearly when the note does not contain the answer.",
    "Match the language of the user's question and keep explanations concise and natural when read aloud.",
  ].join(" ");
}

function buildVoiceQaUserMessage(
  question: string,
  context: {
    scope: "selection" | "note" | "empty";
    text: string;
    truncated?: boolean;
    noteTitle?: string;
  },
): string {
  const trimmedContext = context.text.trim();
  if (context.scope === "empty" || !trimmedContext) {
    return question;
  }

  const label = context.scope === "selection" ? "Selected text" : "Active note";
  const titlePart = context.noteTitle ? ` (${context.noteTitle})` : "";
  const truncPart = context.truncated ? " [truncated]" : "";
  return `${label}${titlePart}${truncPart}:\n---\n${trimmedContext}\n---\n\nQuestion: ${question}`;
}

/**
 * Stream a grounded Q&A completion while incrementally segmenting spoken sentences for TTS playback.
 */
export async function runVoiceQaStream(
  question: string,
  context: {
    scope: "selection" | "note" | "empty";
    text: string;
    truncated?: boolean;
    noteTitle?: string;
  },
  options: VoiceQaStreamOptions,
): Promise<string> {
  const trimmedQuestion = question.trim();
  if (!trimmedQuestion) {
    throw new Error("Enter or dictate a question first.");
  }

  const llmConfig = await resolvePluginLlmConfigAsync({
    settings: options.settings,
    secretStore: options.secretStore,
    fetchImpl: options.fetchImpl,
    isMobile: options.isMobile,
  });

  const segmenter = new SentenceSegmenter({
    maxSentenceChars: options.maxSentenceChars ?? options.settings.maxSentenceChars,
    tablePolicy: options.tablePolicy ?? options.settings.markdownTablePolicy,
  });

  let fullText = "";
  for await (const delta of streamChat(llmConfig, {
    system: buildVoiceQaSystemPrompt(),
    messages: [{ role: "user", content: buildVoiceQaUserMessage(trimmedQuestion, context) }],
    signal: options.signal,
  })) {
    if (!delta) {
      continue;
    }
    fullText += delta;
    options.onDelta?.(delta, fullText);
    if (options.onSentence) {
      for (const sentence of segmenter.feed(delta)) {
        if (sentence.trim().length > 0) {
          options.onSentence(sentence);
        }
      }
    }
  }

  if (!options.signal?.aborted && options.onSentence) {
    for (const tail of segmenter.flush()) {
      if (tail.trim().length > 0) {
        options.onSentence(tail);
      }
    }
  }

  return fullText;
}

export function formatQaContextSummary(context: NoteQaContext): string {
  const formattedLen = context.text.length.toLocaleString("en-US");
  const suffix = context.truncated ? ", truncated" : "";
  if (context.scope === "selection") {
    return `Context: selection (${formattedLen} chars${suffix})`;
  }
  if (context.scope === "note") {
    return `Context: active note (${formattedLen} chars${suffix})`;
  }
  return "Context: none (no active note)";
}

export class VoiceQaModal extends Modal {
  private readonly context: NoteQaContext;
  private readonly callbacks: VoiceQaModalCallbacks;

  private promptEl: HTMLTextAreaElement | null = null;
  private dictateBtnEl: HTMLButtonElement | null = null;
  private readAloudCheckboxEl: HTMLInputElement | null = null;
  private submitBtnEl: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private answerEl: HTMLElement | null = null;
  private footerEl: HTMLElement | null = null;

  private streamAbortController: AbortController | null = null;
  private modalReadAloudActive = false;
  private dictatingIntoModal = false;
  private answerText = "";

  constructor(app: App, context: NoteQaContext, callbacks: VoiceQaModalCallbacks) {
    super(app);
    this.context = context;
    this.callbacks = callbacks;
  }

  onOpen(): void {
    this.setTitle("Ask AI about selection or note");

    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("vm-qa-modal");

    contentEl.createDiv({
      cls: "vm-qa-context",
      text: formatQaContextSummary(this.context),
    });

    const prompt = contentEl.createEl("textarea", {
      cls: "vm-qa-prompt",
      attr: {
        rows: "3",
        placeholder: "Type or dictate a question about your selection or note...",
      },
    });
    this.promptEl = prompt;

    const actions = contentEl.createDiv({ cls: "vm-qa-actions" });
    const leftActions = actions.createDiv({ cls: "vm-qa-actions-left" });
    const rightActions = actions.createDiv({ cls: "vm-qa-actions-right" });

    const dictateBtn = leftActions.createEl("button", {
      text: "Dictate question",
    });
    dictateBtn.type = "button";
    this.dictateBtnEl = dictateBtn;

    const readToggleLabel = leftActions.createEl("label", {
      cls: "vm-qa-read-toggle",
    });
    const readCheckbox = readToggleLabel.createEl("input", {
      type: "checkbox",
    });
    readCheckbox.checked = true;
    readToggleLabel.createSpan({ text: "Read answer aloud" });
    this.readAloudCheckboxEl = readCheckbox;

    const submitBtn = rightActions.createEl("button", {
      cls: "mod-cta",
      text: "Ask",
    });
    submitBtn.type = "button";
    this.submitBtnEl = submitBtn;

    this.statusEl = contentEl.createDiv({ cls: "vm-qa-status vm-qa-hidden" });
    this.answerEl = contentEl.createDiv({ cls: "vm-qa-answer vm-qa-hidden" });

    const footer = contentEl.createDiv({ cls: "vm-qa-footer vm-qa-hidden" });
    const insertBtn = footer.createEl("button", {
      text: "Insert at cursor",
    });
    insertBtn.type = "button";
    const copyBtn = footer.createEl("button", {
      text: "Copy answer",
    });
    copyBtn.type = "button";
    this.footerEl = footer;

    dictateBtn.addEventListener("click", () => {
      void this.handleDictateQuestionClick();
    });

    readCheckbox.addEventListener("change", () => {
      if (!readCheckbox.checked && this.modalReadAloudActive) {
        this.modalReadAloudActive = false;
        this.callbacks.onStopReadAloud();
      }
    });

    submitBtn.addEventListener("click", () => {
      if (this.streamAbortController) {
        this.stopActiveStream();
        return;
      }
      void this.submitQuestion();
    });

    prompt.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        if (!this.streamAbortController) {
          void this.submitQuestion();
        }
      }
    });

    insertBtn.addEventListener("click", () => {
      if (!this.answerText.trim()) {
        return;
      }
      const inserted = this.callbacks.onInsertAtCursor(this.answerText);
      if (inserted) {
        new Notice("Inserted answer at cursor.");
      } else {
        new Notice("Open a Markdown note to insert the answer.");
      }
    });

    copyBtn.addEventListener("click", () => {
      void this.copyAnswerToClipboard();
    });

    prompt.focus();
  }

  onClose(): void {
    if (this.streamAbortController) {
      this.streamAbortController.abort();
      this.streamAbortController = null;
    }
    if (this.dictatingIntoModal) {
      this.dictatingIntoModal = false;
      this.callbacks.onCancelDictation?.();
    }
    if (this.modalReadAloudActive) {
      this.modalReadAloudActive = false;
      this.callbacks.onStopReadAloud();
    }
    this.promptEl = null;
    this.dictateBtnEl = null;
    this.callbacks.onModalClose?.();
    this.contentEl.empty();
  }

  private resetDictationButtonState(): void {
    this.dictatingIntoModal = false;
    this.dictateBtnEl?.setText("Dictate question");
  }

  private async handleDictateQuestionClick(): Promise<void> {
    if (this.dictatingIntoModal && this.callbacks.isDictating?.()) {
      this.dictateBtnEl?.setText("Dictate question");
      try {
        await this.callbacks.onDictateQuestion(
          (text) => {
            this.resetDictationButtonState();
            this.appendDictatedPrompt(text);
          },
          () => {
            this.resetDictationButtonState();
          },
        );
      } finally {
        if (!this.callbacks.isDictating?.()) {
          this.resetDictationButtonState();
        }
      }
      return;
    }

    this.dictatingIntoModal = true;
    this.dictateBtnEl?.setText("Stop dictation");
    try {
      await this.callbacks.onDictateQuestion(
        (text) => {
          this.resetDictationButtonState();
          this.appendDictatedPrompt(text);
        },
        () => {
          this.resetDictationButtonState();
        },
      );
      if (this.callbacks.isDictating && !this.callbacks.isDictating()) {
        this.resetDictationButtonState();
      }
    } catch {
      this.resetDictationButtonState();
    }
  }

  private appendDictatedPrompt(text: string): void {
    const clean = text.trim();
    if (!clean || !this.promptEl) {
      return;
    }
    const existing = this.promptEl.value;
    const separator = existing.length > 0 && !/\s$/.test(existing) ? " " : "";
    this.promptEl.value = `${existing}${separator}${clean}`;
    this.promptEl.focus();
  }

  private stopActiveStream(): void {
    if (this.streamAbortController) {
      this.streamAbortController.abort();
      this.streamAbortController = null;
    }
    if (this.modalReadAloudActive) {
      this.modalReadAloudActive = false;
      this.callbacks.onStopReadAloud();
    }
    this.setStreamingUi(false);
    this.showStatus("Stopped.", false);
  }

  private setStreamingUi(streaming: boolean): void {
    if (!this.submitBtnEl) {
      return;
    }
    if (streaming) {
      this.submitBtnEl.removeClass("mod-cta");
      this.submitBtnEl.setText("Stop");
    } else {
      this.submitBtnEl.addClass("mod-cta");
      this.submitBtnEl.setText("Ask");
    }
  }

  private showStatus(text: string, isError: boolean): void {
    if (!this.statusEl) {
      return;
    }
    if (!text) {
      this.statusEl.setText("");
      this.statusEl.addClass("vm-qa-hidden");
      this.statusEl.removeClass("vm-qa-status-error");
      return;
    }
    this.statusEl.setText(text);
    this.statusEl.removeClass("vm-qa-hidden");
    if (isError) {
      this.statusEl.addClass("vm-qa-status-error");
    } else {
      this.statusEl.removeClass("vm-qa-status-error");
    }
  }

  private async submitQuestion(): Promise<void> {
    const question = this.promptEl?.value.trim() ?? "";
    if (!question) {
      new Notice("Enter or dictate a question first.");
      this.promptEl?.focus();
      return;
    }

    if (this.modalReadAloudActive) {
      this.modalReadAloudActive = false;
      this.callbacks.onStopReadAloud();
    }

    const controller = new AbortController();
    this.streamAbortController = controller;
    this.answerText = "";
    this.answerEl?.setText("");
    this.answerEl?.addClass("vm-qa-hidden");
    this.footerEl?.addClass("vm-qa-hidden");
    this.setStreamingUi(true);
    this.showStatus("Thinking...", false);

    try {
      const fullAnswer = await runVoiceQaStream(question, this.context, {
        settings: this.callbacks.settings,
        secretStore: this.callbacks.secretStore,
        fetchImpl: this.callbacks.fetchImpl,
        isMobile: this.callbacks.isMobile,
        signal: controller.signal,
        onDelta: (_delta, fullText) => {
          this.answerText = fullText;
          this.showStatus("", false);
          this.answerEl?.removeClass("vm-qa-hidden");
          this.answerEl?.setText(fullText);
        },
        onSentence: (sentence) => {
          if (controller.signal.aborted || !this.readAloudCheckboxEl?.checked) {
            return;
          }
          this.modalReadAloudActive = true;
          this.callbacks.onSpeakSentence(sentence);
        },
      });

      if (controller.signal.aborted) {
        return;
      }

      this.answerText = fullAnswer;
      this.showStatus("", false);
      if (fullAnswer.trim().length > 0) {
        this.answerEl?.removeClass("vm-qa-hidden");
        this.answerEl?.setText(fullAnswer);
        this.footerEl?.removeClass("vm-qa-hidden");
      } else {
        this.showStatus("Model returned an empty response.", false);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      const message = redactSecrets(err instanceof Error ? err.message : String(err));
      this.showStatus(`AI request failed: ${message}`, true);
      new Notice(`AI request failed: ${message}`);
    } finally {
      if (this.streamAbortController === controller) {
        this.streamAbortController = null;
        this.setStreamingUi(false);
        if (this.answerText.trim().length > 0) {
          this.footerEl?.removeClass("vm-qa-hidden");
        }
      }
    }
  }

  private async copyAnswerToClipboard(): Promise<void> {
    if (!this.answerText.trim()) {
      return;
    }
    try {
      await activeWindow.navigator.clipboard.writeText(this.answerText);
      new Notice("Copied answer to clipboard.");
    } catch {
      new Notice("Could not copy answer to clipboard.");
    }
  }
}
