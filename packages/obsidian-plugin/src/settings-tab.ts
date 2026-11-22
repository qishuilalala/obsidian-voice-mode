import {
  ALLOWED_MODEL_HOSTNAMES,
  ALLOWED_WASM_HOSTNAMES,
  LLM_PRESETS,
  LLM_PRESET_IDS,
  MIMO_DEFAULT_BASE_URL,
  MIMO_DEFAULT_MODEL,
  MIMO_DEFAULT_VOICE,
  MIMO_VOICES,
  MODEL_BUNDLES,
  MODEL_HOST_FALLBACK,
  MODEL_HOST_PRIMARY,
  REPLACEMENTS_MAX_PAYLOAD_BYTES,
  SHERPA_WASM_RUNTIME_202,
  TTS_OPENAI_PRESETS,
  VITS_SPEAKERS,
  asLlmPresetId,
  asTtsEngineKind,
  redactSecrets,
  replacementsPayloadBytes,
  resolveTtsOpenAiPreset,
  ttsPresetRequiresKey,
  validateEndpointUrl,
  validateLoopbackUrl,
  validateModelHost,
  validateReplacements,
  type AsrReplacement,
  type MarkdownTablePolicy,
  type TtsEngineKind,
} from "@voice-mode/core";
import {
  resolveBargeInPolicy,
  type BargeInMode,
  type BargeInPolicyDecision,
  type DictationMode,
} from "@voice-mode/browser";
import {
  Notice,
  Platform,
  PluginSettingTab,
  SecretComponent,
  Setting,
  requireApiVersion,
  type App,
  type Plugin,
  type SettingDefinitionItem,
} from "obsidian";
import { resolveExternalModelCacheDir } from "./desktop-fs.ts";
import type { DictationStackStatus, ModelDownloadProgress } from "./model-manager.ts";
import {
  DEFAULT_LOCAL_DAEMON_URL,
  MOBILE_WASM_RESTRICTION_REASON,
  type DesktopOsHint,
  type ObsidianAsrEngine,
  type RuntimeCapabilities,
} from "./runtime-guard.ts";
import {
  getLlmSecretId,
  getTtsSecretId,
  hasSecretStorage,
  isValidSecretId,
  setLlmSecretId,
  setTtsSecretId,
  toSecretId,
  type SubtitleFontSize,
  type SubtitleWidth,
  type VoiceModeSettings,
} from "./settings.ts";

export interface VoiceModePluginHost {
  settings: VoiceModeSettings;
  readonly capabilities: RuntimeCapabilities;
  saveSettings(): Promise<void>;
  getVaultBasePath?(): string | null;
  getModelStatus?(): Promise<DictationStackStatus | null>;
  isDownloadingModels?(): boolean;
  startModelDownload?(
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<DictationStackStatus>;
  startVitsModelDownload?(
    onProgress?: (progress: ModelDownloadProgress) => void,
  ): Promise<DictationStackStatus>;
  cancelModelDownload?(): void;
  clearCachedModels?(): Promise<void>;
  openModelCacheFolder?(): Promise<void>;
  getBargeInDecision?(): BargeInPolicyDecision | null;
}

const ASR_ENGINE_LABELS: Readonly<Record<ObsidianAsrEngine, string>> = {
  system: "System speech recognition",
  "sensevoice-wasm": "SenseVoice WASM (desktop offline)",
  "zipformer-wasm": "Zipformer WASM (desktop local)",
  "openai-compat": "OpenAI-compatible endpoint (BYOK)",
  daemon: "Local voice daemon (desktop)",
};

const DICTATION_MODE_LABELS: Readonly<Record<DictationMode, string>> = {
  toggle: "Toggle start and stop",
  single: "Single utterance",
  "push-to-talk": "Push to talk",
};

const TTS_ENGINE_LABELS: Readonly<Record<TtsEngineKind, string>> = {
  system: "System speech synthesis",
  "vits-wasm": "VITS WASM (desktop local)",
  "kokoro-daemon": "Kokoro daemon (desktop local)",
  "openai-compat": "OpenAI-compatible endpoint (BYOK)",
  mimo: "MiMo cloud TTS (BYOK)",
};

const SUBTITLE_FONT_SIZE_LABELS: Readonly<Record<SubtitleFontSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

const SUBTITLE_WIDTH_LABELS: Readonly<Record<SubtitleWidth, string>> = {
  narrow: "Narrow (420 px)",
  medium: "Medium (640 px)",
  wide: "Wide (860 px)",
};

const BARGE_IN_MODE_LABELS: Readonly<Record<BargeInMode, string>> = {
  detect: "Detect native AEC automatically",
  auto: "Force hands-free barge-in (desktop non-system TTS)",
  manual: "Manual stop only",
};

const SECRET_STORAGE_UPGRADE_NOTICE =
  "Native secret storage requires Obsidian 1.11.4 or later. Upgrade Obsidian to store API keys securely.";

export function detectDesktopOsHint(): DesktopOsHint {
  if (Platform.isWin) {
    return "windows";
  }
  if (Platform.isLinux) {
    return "linux";
  }
  return "macos";
}

function buildOptionsMap<K extends string>(
  keys: readonly K[],
  labels: Readonly<Record<K, string>>,
): Record<string, string> {
  const options: Record<string, string> = {};
  for (const key of keys) {
    options[key] = labels[key];
  }
  return options;
}

function buildTtsPresetOptions(): Record<string, string> {
  const options: Record<string, string> = {};
  for (const [presetId, preset] of Object.entries(TTS_OPENAI_PRESETS)) {
    options[presetId] = preset.label;
  }
  options.custom = "Custom OpenAI-compatible endpoint";
  return options;
}

function buildVitsSpeakerOptions(): Record<string, string> {
  const options: Record<string, string> = {
    "": "Default (suyingxue — 0)",
  };
  for (const speaker of VITS_SPEAKERS) {
    options[speaker.name] = `${speaker.en} (${speaker.name} — ${speaker.sid})`;
  }
  return options;
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function parseAliasList(raw: string): string[] {
  return raw
    .split(/[,，]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export class VoiceModeSettingTab extends PluginSettingTab {
  private readonly host: VoiceModePluginHost;

  constructor(app: App, plugin: VoiceModePluginHost & Plugin) {
    super(app, plugin);
    this.host = plugin;
  }

  private resolveEffectiveAsr(): ObsidianAsrEngine {
    const { settings, capabilities } = this.host;
    return capabilities.allowedAsrEngines.includes(settings.asrEngine)
      ? settings.asrEngine
      : capabilities.defaultAsrEngine;
  }

  private resolveEffectiveTts(): TtsEngineKind {
    const { settings, capabilities } = this.host;
    return capabilities.allowedTtsEngines.includes(settings.ttsEngine)
      ? settings.ttsEngine
      : capabilities.defaultTtsEngine;
  }

  private describeTtsVoiceMeta(
    engine: TtsEngineKind,
    presetId: string,
  ): { desc: string; placeholder: string } {
    if (engine === "vits-wasm") {
      return {
        desc: `Optional speaker name or numeric ID (${VITS_SPEAKERS.map((s) => `${s.name}/${s.sid}`).join(", ")}).`,
        placeholder: "suyingxue",
      };
    }
    if (engine === "kokoro-daemon") {
      return {
        desc: "Optional Kokoro speaker ID or numeric index (for example: zf_001, zf_xiaobei, zm_010, af_maple, or 0..102).",
        placeholder: "zf_001",
      };
    }
    if (engine === "openai-compat") {
      const preset = resolveTtsOpenAiPreset(presetId);
      return {
        desc: preset
          ? `Optional voice override for ${preset.label} (default: ${preset.voice}).`
          : "Optional voice identifier required by your endpoint.",
        placeholder: preset?.voice || "alloy",
      };
    }
    if (engine === "mimo") {
      return {
        desc: `Optional MiMo voice identifier (available: ${MIMO_VOICES.join(", ")}).`,
        placeholder: MIMO_DEFAULT_VOICE,
      };
    }
    return {
      desc: "Optional voice name or provider speaker ID. Leave empty to use the system default.",
      placeholder: "Default system voice",
    };
  }

  private describeTtsSecretDesc(engine: TtsEngineKind, presetId: string): string {
    if (engine === "openai-compat") {
      const preset = resolveTtsOpenAiPreset(presetId);
      const suggested = preset ? toSecretId("tts", preset.id) : toSecretId("tts", "custom");
      const label = preset ? preset.label : "Custom OpenAI-compatible endpoint";
      const loopbackHint =
        preset && !ttsPresetRequiresKey(preset.id)
          ? " Optional for local loopback servers without authentication."
          : "";
      return `Select a secret from Obsidian secret storage for ${label} (suggested ID: ${suggested}).${loopbackHint}`;
    }
    if (engine === "mimo") {
      return `Select a secret from Obsidian secret storage for MiMo cloud TTS (suggested ID: ${toSecretId("tts", "mimo")}).`;
    }
    return `Select a secret from Obsidian secret storage for ${TTS_ENGINE_LABELS[engine]} (suggested ID: ${toSecretId("tts", engine)}).`;
  }

  /**
   * Declarative setting definitions for Obsidian 1.13+ (enables native Settings Search).
   * Older hosts (1.11.4–1.12.x) render identically through `display()`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const { settings, capabilities } = this.host;
    const asrOptions = buildOptionsMap(capabilities.allowedAsrEngines, ASR_ENGINE_LABELS);
    const ttsOptions = buildOptionsMap(capabilities.allowedTtsEngines, TTS_ENGINE_LABELS);
    const dictationModeOptions = buildOptionsMap(
      ["toggle", "single", "push-to-talk"] as const,
      DICTATION_MODE_LABELS,
    );
    const subtitleSizeOptions = buildOptionsMap(
      ["small", "medium", "large"] as const,
      SUBTITLE_FONT_SIZE_LABELS,
    );
    const subtitleWidthOptions = buildOptionsMap(
      ["narrow", "medium", "wide"] as const,
      SUBTITLE_WIDTH_LABELS,
    );
    const bargeInModeOptions = buildOptionsMap(
      ["detect", "auto", "manual"] as const,
      BARGE_IN_MODE_LABELS,
    );
    const ttsPresetOptions = buildTtsPresetOptions();
    const vitsSpeakerOptions = buildVitsSpeakerOptions();
    const effectiveTts = this.resolveEffectiveTts();
    const activeTtsPreset = resolveTtsOpenAiPreset(settings.ttsPresetId);
    const voiceMeta = this.describeTtsVoiceMeta(effectiveTts, settings.ttsPresetId);

    const presetOptions: Record<string, string> = {};
    for (const presetId of LLM_PRESET_IDS) {
      presetOptions[presetId] = LLM_PRESETS[presetId].label;
    }
    const activePreset = LLM_PRESETS[settings.llmPresetId];

    return [
      {
        type: "group",
        heading: "Voice input",
        items: [
          {
            name: "Recognition engine",
            desc: "Choose how dictation is transcribed. Mobile devices disable local WASM models to stay within memory limits.",
            control: {
              type: "dropdown",
              key: "asrEngine",
              options: asrOptions,
            },
          },
          {
            name: "Dictation trigger mode",
            desc: "Choose continuous toggle, single-utterance auto-stop, or push-to-talk.",
            control: {
              type: "dropdown",
              key: "dictationMode",
              options: dictationModeOptions,
            },
          },
          {
            name: "Dictation language",
            desc: "Locale code used for dictation and transcription requests (use zh-CN or auto for mixed Chinese and English).",
            control: {
              type: "text",
              key: "dictationLanguage",
              placeholder: "zh-CN",
            },
          },
          {
            name: "Silence endpoint duration",
            desc: "Trailing silence in milliseconds before an utterance is finalized (400 to 5000 ms).",
            control: {
              type: "slider",
              key: "endpointSilenceMs",
              min: 400,
              max: 5000,
              step: 100,
            },
          },
          {
            name: "Show live subtitle overlay",
            desc: "Display a compact transcript card at the bottom of the workspace during voice activity.",
            control: {
              type: "toggle",
              key: "enableSubtitleOverlay",
            },
          },
          {
            name: "Personal vocabulary replacements",
            desc: "Map spoken aliases or homophones to exact domain terms or wikilinks during dictation.",
            render: (setting) => {
              setting.settingEl.empty();
              setting.settingEl.addClass("vm-setting-block");
              this.renderReplacementsEditor(setting.settingEl);
            },
          },
          {
            name: "Transcription API key",
            desc: `Select a secret stored in Obsidian secret storage (suggested ID: ${toSecretId("asr", "openai-compat")}).`,
            render: (setting) => {
              const liveSettings = this.host.settings;
              this.attachSecretControl(setting, liveSettings.asrApiKeySecretId, async (candidate) => {
                this.host.settings.asrApiKeySecretId = candidate;
                await this.host.saveSettings();
              });
            },
          },
          {
            name: "Transcription endpoint URL",
            desc: "Optional HTTPS or loopback HTTP endpoint for OpenAI-compatible speech recognition.",
            control: {
              type: "text",
              key: "asrEndpointUrl",
              placeholder: "https://api.openai.com/v1",
              validate: (value) => this.validateOptionalEndpointMessage(value),
            },
          },
          {
            name: "Transcription model override",
            desc: "Leave empty to use the default transcription model for your OpenAI-compatible endpoint.",
            visible: () => this.resolveEffectiveAsr() === "openai-compat",
            control: {
              type: "text",
              key: "asrModel",
              placeholder: "whisper-1",
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Read aloud",
        items: [
          {
            name: "Speech engine",
            desc: "System speech works immediately with zero downloads. Optional local or cloud engines can be mounted.",
            control: {
              type: "dropdown",
              key: "ttsEngine",
              options: ttsOptions,
            },
          },
          {
            name: "TTS preset",
            desc: "Choose a cloud or local loopback OpenAI-compatible speech preset, or select custom endpoint.",
            visible: () => this.resolveEffectiveTts() === "openai-compat",
            control: {
              type: "dropdown",
              key: "ttsPresetId",
              options: ttsPresetOptions,
            },
          },
          {
            name: "VITS speaker",
            desc: "Select one of the built-in VITS speakers or leave on default.",
            visible: () => this.resolveEffectiveTts() === "vits-wasm",
            control: {
              type: "dropdown",
              key: "vitsSpeaker",
              options: vitsSpeakerOptions,
            },
          },
          {
            name: "Preferred voice name",
            desc: voiceMeta.desc,
            control: {
              type: "text",
              key: "ttsVoice",
              placeholder: voiceMeta.placeholder,
            },
          },
          {
            name: "TTS model override",
            desc: "Leave empty to use the default speech model for the active provider or preset.",
            visible: () => {
              const e = this.resolveEffectiveTts();
              return e === "openai-compat" || e === "mimo";
            },
            control: {
              type: "text",
              key: "ttsModel",
              placeholder:
                effectiveTts === "mimo"
                  ? MIMO_DEFAULT_MODEL
                  : activeTtsPreset?.model || "tts-1",
            },
          },
          {
            name: "TTS endpoint URL",
            desc: "Optional HTTPS or loopback HTTP speech endpoint URL. Plaintext HTTP is blocked for remote hosts.",
            visible: () => {
              const e = this.resolveEffectiveTts();
              return e === "openai-compat" || e === "mimo";
            },
            control: {
              type: "text",
              key: "ttsEndpointUrl",
              placeholder:
                effectiveTts === "mimo"
                  ? MIMO_DEFAULT_BASE_URL
                  : activeTtsPreset?.baseUrl || "https://api.openai.com/v1",
              validate: (value) => this.validateOptionalEndpointMessage(value),
            },
          },
          {
            name: "Speech API key",
            desc: this.describeTtsSecretDesc(effectiveTts, settings.ttsPresetId),
            visible: () => {
              const e = this.resolveEffectiveTts();
              return e === "openai-compat" || e === "mimo";
            },
            render: (setting) => {
              const liveSettings = this.host.settings;
              const currentEngine = this.resolveEffectiveTts();
              const presetScope =
                currentEngine === "openai-compat" ? liveSettings.ttsPresetId : undefined;
              this.attachSecretControl(
                setting,
                getTtsSecretId(liveSettings, currentEngine, presetScope),
                async (candidate) => {
                  setTtsSecretId(this.host.settings, currentEngine, candidate, presetScope);
                  await this.host.saveSettings();
                },
              );
            },
          },
          {
            name: "Speech rate",
            desc: "Adjust read-aloud playback speed between 0.5x and 2.0x.",
            control: {
              type: "slider",
              key: "speechRate",
              min: 0.5,
              max: 2.0,
              step: 0.1,
            },
          },
          {
            name: "Markdown table handling",
            desc: "Choose whether Markdown pipe tables are skipped or replaced with a short spoken hint.",
            control: {
              type: "dropdown",
              key: "markdownTablePolicy",
              options: {
                skip: "Skip tables",
                placeholder: "Speak brief placeholder",
              },
            },
          },
          {
            name: "Subtitle text size",
            desc: "Choose the font size for the live transcript and read-aloud subtitle card.",
            control: {
              type: "dropdown",
              key: "subtitleFontSize",
              options: subtitleSizeOptions,
            },
          },
          {
            name: "Subtitle card width",
            desc: "Choose the maximum width of the floating subtitle card.",
            control: {
              type: "dropdown",
              key: "subtitleWidth",
              options: subtitleWidthOptions,
            },
          },
          {
            name: "Stop read-aloud when switching notes",
            desc: "Immediately cancel active read-aloud when opening or switching to another note.",
            control: {
              type: "toggle",
              key: "stopReadAloudOnNoteSwitch",
            },
          },
          {
            name: "Barge-in mode",
            desc: "Control hands-free voice interruption during non-system read-aloud. System speech always uses manual stop to avoid speaker echo loops.",
            control: {
              type: "dropdown",
              key: "bargeInMode",
              options: bargeInModeOptions,
            },
          },
        ],
      },
      {
        type: "group",
        heading: "AI model",
        items: [
          {
            name: "Enable optional BYOK voice assistant",
            desc: "Leave disabled for strictly offline dictation and read-aloud. Ask AI about selection or note uses your own model provider with automatic CORS fallback. Volcengine endpoints accept model names or an ep-xxx endpoint ID.",
            control: {
              type: "toggle",
              key: "enableVoiceQa",
            },
          },
          {
            name: "Post-dictation LLM polish",
            desc: "Apply minimal typo, homophone, and punctuation cleanup after dictation with 4-layer anti-hallucination guards. Falls back to original text on any error.",
            control: {
              type: "toggle",
              key: "enableLlmPolish",
            },
          },
          {
            name: "Provider preset",
            desc: "Choose a BYOK cloud provider or local loopback server. Direct CORS works with DeepSeek, Qwen, Kimi, SiliconFlow, OpenRouter, and Anthropic; automatic CORS fallback handles Volcengine, OpenAI, and Ollama loopback.",
            control: {
              type: "dropdown",
              key: "llmPresetId",
              options: presetOptions,
            },
          },
          {
            name: "Provider API key",
            desc: `Select a secret stored in Obsidian secret storage for ${activePreset.label} (suggested ID: ${toSecretId("llm", settings.llmPresetId)}).`,
            render: (setting) => {
              const liveSettings = this.host.settings;
              const currentPreset = liveSettings.llmPresetId;
              this.attachSecretControl(
                setting,
                getLlmSecretId(liveSettings, currentPreset),
                async (candidate) => {
                  setLlmSecretId(this.host.settings, currentPreset, candidate);
                  await this.host.saveSettings();
                },
              );
            },
          },
          {
            name: "Model identifier override",
            desc: "Leave empty to use the default model defined by the selected preset.",
            control: {
              type: "text",
              key: "llmModel",
              placeholder: activePreset.defaultModel || "model-name",
            },
          },
          {
            name: "Endpoint URL override",
            desc: "Optional HTTPS or loopback HTTP base URL. Plaintext HTTP is blocked for remote hosts.",
            control: {
              type: "text",
              key: "llmBaseUrl",
              placeholder: activePreset.defaultBaseUrl || "https://example.com/v1",
              validate: (value) => this.validateOptionalEndpointMessage(value),
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Models and privacy",
        items: [
          {
            name: "Runtime summary",
            searchable: false,
            render: (setting) => {
              setting.settingEl.empty();
              setting.settingEl.addClass("vm-setting-block");
              this.renderRuntimeBanner(setting.settingEl);
            },
          },
          {
            name: "Offline speech models",
            desc: "Download or verify SHA256-pinned offline dictation models stored outside the vault.",
            render: (setting) => {
              setting.settingEl.empty();
              setting.settingEl.addClass("vm-setting-block");
              this.renderOfflineModelCard(setting.settingEl);
            },
          },
          {
            name: "Model download host",
            desc: `Allowlisted HTTPS host (${ALLOWED_MODEL_HOSTNAMES.join(", ")}) for optional desktop model downloads stored outside the vault.`,
            visible: () => capabilities.allowLocalWasmModels,
            control: {
              type: "dropdown",
              key: "modelMirrorHost",
              options: {
                [MODEL_HOST_PRIMARY]: "Primary host (huggingface.co)",
                [MODEL_HOST_FALLBACK]: "Fallback mirror (hf-mirror.com)",
              },
            },
          },
          {
            name: "Custom external model cache path",
            desc: "Optional absolute path outside the vault for desktop offline models (useful for sandboxed Linux packages).",
            visible: () => capabilities.allowLocalWasmModels,
            control: {
              type: "text",
              key: "customModelCacheDir",
              placeholder: capabilities.externalModelCacheDir,
              validate: (value) => this.validateCustomCacheDirMessage(value),
            },
          },
          {
            name: "Idle model unload timeout",
            desc: "Minutes of inactivity before unloading the local WASM worker to free memory (0 keeps it loaded).",
            visible: () => capabilities.allowLocalWasmModels,
            control: {
              type: "slider",
              key: "workerIdleUnloadMinutes",
              min: 0,
              max: 30,
              step: 1,
            },
          },
          {
            name: "Local daemon URL",
            desc: "Loopback address for an optional local voice daemon on desktop.",
            visible: () => capabilities.allowLocalDaemon,
            control: {
              type: "text",
              key: "daemonUrl",
              placeholder: DEFAULT_LOCAL_DAEMON_URL,
              validate: (value) => this.validateLoopbackDaemonMessage(value),
            },
          },
          {
            name: "Daemon auth token",
            desc: `Select an optional bearer token stored in Obsidian secret storage for the local voice daemon (suggested ID: ${toSecretId("daemon", "local")}).`,
            visible: () =>
              capabilities.allowLocalDaemon &&
              (this.resolveEffectiveAsr() === "daemon" ||
                this.resolveEffectiveTts() === "kokoro-daemon"),
            render: (setting) => {
              const liveSettings = this.host.settings;
              this.attachSecretControl(setting, liveSettings.daemonTokenSecretId, async (candidate) => {
                this.host.settings.daemonTokenSecretId = candidate;
                await this.host.saveSettings();
              });
            },
          },
          {
            name: "Allow cloud fallback on mobile",
            desc: "Allow optional BYOK cloud speech endpoints when running on iOS or Android.",
            control: {
              type: "toggle",
              key: "allowCloudFallbackOnMobile",
            },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const { settings, capabilities } = this.host;
    switch (key) {
      case "asrEngine":
        return capabilities.allowedAsrEngines.includes(settings.asrEngine)
          ? settings.asrEngine
          : capabilities.defaultAsrEngine;
      case "dictationMode":
        return settings.dictationMode;
      case "dictationLanguage":
        return settings.dictationLanguage;
      case "endpointSilenceMs":
        return settings.endpointSilenceMs;
      case "enableSubtitleOverlay":
        return settings.enableSubtitleOverlay;
      case "asrEndpointUrl":
        return settings.asrEndpointUrl;
      case "asrModel":
        return settings.asrModel;
      case "ttsEngine":
        return capabilities.allowedTtsEngines.includes(settings.ttsEngine)
          ? settings.ttsEngine
          : capabilities.defaultTtsEngine;
      case "ttsPresetId":
        return settings.ttsPresetId;
      case "vitsSpeaker":
        return VITS_SPEAKERS.some((s) => s.name === settings.ttsVoice) ? settings.ttsVoice : "";
      case "ttsVoice":
        return settings.ttsVoice;
      case "ttsModel":
        return settings.ttsModel;
      case "ttsEndpointUrl":
        return settings.ttsEndpointUrl;
      case "speechRate":
        return settings.speechRate;
      case "markdownTablePolicy":
        return settings.markdownTablePolicy;
      case "subtitleFontSize":
        return settings.subtitleFontSize;
      case "subtitleWidth":
        return settings.subtitleWidth;
      case "stopReadAloudOnNoteSwitch":
        return settings.stopReadAloudOnNoteSwitch;
      case "bargeInMode":
        return settings.bargeInMode;
      case "enableVoiceQa":
        return settings.enableVoiceQa;
      case "enableLlmPolish":
        return settings.enableLlmPolish;
      case "llmPresetId":
        return settings.llmPresetId;
      case "llmModel":
        return settings.llmModel;
      case "llmBaseUrl":
        return settings.llmBaseUrl;
      case "modelMirrorHost":
        return settings.modelMirrorHost;
      case "customModelCacheDir":
        return settings.customModelCacheDir;
      case "workerIdleUnloadMinutes":
        return settings.workerIdleUnloadMinutes;
      case "daemonUrl":
        return settings.daemonUrl;
      case "allowCloudFallbackOnMobile":
        return settings.allowCloudFallbackOnMobile;
      default:
        return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const { settings } = this.host;
    let shouldRefresh = false;

    switch (key) {
      case "asrEngine":
        if (typeof value === "string") {
          settings.asrEngine = value as ObsidianAsrEngine;
          shouldRefresh = true;
        }
        break;
      case "dictationMode":
        if (value === "toggle" || value === "single" || value === "push-to-talk") {
          settings.dictationMode = value;
        }
        break;
      case "dictationLanguage":
        if (typeof value === "string") {
          settings.dictationLanguage = value.trim() || "zh-CN";
        }
        break;
      case "endpointSilenceMs":
        if (typeof value === "number" && Number.isFinite(value)) {
          settings.endpointSilenceMs = Math.round(value);
        }
        break;
      case "enableSubtitleOverlay":
        if (typeof value === "boolean") {
          settings.enableSubtitleOverlay = value;
        }
        break;
      case "asrEndpointUrl":
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed && this.validateOptionalEndpointMessage(trimmed)) {
            return;
          }
          settings.asrEndpointUrl = trimmed;
        }
        break;
      case "asrModel":
        if (typeof value === "string") {
          settings.asrModel = value.trim();
        }
        break;
      case "ttsEngine":
        if (typeof value === "string") {
          settings.ttsEngine = asTtsEngineKind(value);
          shouldRefresh = true;
        }
        break;
      case "ttsPresetId":
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed === "custom" || Object.hasOwn(TTS_OPENAI_PRESETS, trimmed)) {
            settings.ttsPresetId = trimmed;
            shouldRefresh = true;
          }
        }
        break;
      case "vitsSpeaker":
        if (typeof value === "string") {
          settings.ttsVoice = value.trim();
          shouldRefresh = true;
        }
        break;
      case "ttsVoice":
        if (typeof value === "string") {
          settings.ttsVoice = value.trim();
        }
        break;
      case "ttsModel":
        if (typeof value === "string") {
          settings.ttsModel = value.trim();
        }
        break;
      case "ttsEndpointUrl":
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed && this.validateOptionalEndpointMessage(trimmed)) {
            return;
          }
          settings.ttsEndpointUrl = trimmed;
        }
        break;
      case "speechRate":
        if (typeof value === "number" && Number.isFinite(value)) {
          settings.speechRate = value;
        }
        break;
      case "markdownTablePolicy":
        if (value === "skip" || value === "placeholder") {
          settings.markdownTablePolicy = value;
        }
        break;
      case "subtitleFontSize":
        if (value === "small" || value === "medium" || value === "large") {
          settings.subtitleFontSize = value;
        }
        break;
      case "subtitleWidth":
        if (value === "narrow" || value === "medium" || value === "wide") {
          settings.subtitleWidth = value;
        }
        break;
      case "stopReadAloudOnNoteSwitch":
        if (typeof value === "boolean") {
          settings.stopReadAloudOnNoteSwitch = value;
        }
        break;
      case "bargeInMode":
        if (value === "detect" || value === "auto" || value === "manual") {
          settings.bargeInMode = value;
          shouldRefresh = true;
        }
        break;
      case "enableVoiceQa":
        if (typeof value === "boolean") {
          settings.enableVoiceQa = value;
        }
        break;
      case "enableLlmPolish":
        if (typeof value === "boolean") {
          settings.enableLlmPolish = value;
        }
        break;
      case "llmPresetId":
        if (typeof value === "string") {
          settings.llmPresetId = asLlmPresetId(value);
          shouldRefresh = true;
        }
        break;
      case "llmModel":
        if (typeof value === "string") {
          settings.llmModel = value.trim();
        }
        break;
      case "llmBaseUrl":
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed && this.validateOptionalEndpointMessage(trimmed)) {
            return;
          }
          settings.llmBaseUrl = trimmed;
        }
        break;
      case "modelMirrorHost":
        if (typeof value === "string") {
          const validated = validateModelHost(value);
          if (!validated) {
            return;
          }
          settings.modelMirrorHost = validated;
        }
        break;
      case "customModelCacheDir":
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed && this.validateCustomCacheDirMessage(trimmed)) {
            return;
          }
          settings.customModelCacheDir = trimmed;
          shouldRefresh = true;
        }
        break;
      case "workerIdleUnloadMinutes":
        if (typeof value === "number" && Number.isFinite(value)) {
          settings.workerIdleUnloadMinutes = Math.round(value);
        }
        break;
      case "daemonUrl":
        if (typeof value === "string") {
          const trimmed = value.trim();
          if (trimmed && this.validateLoopbackDaemonMessage(trimmed)) {
            return;
          }
          settings.daemonUrl = trimmed;
        }
        break;
      case "allowCloudFallbackOnMobile":
        if (typeof value === "boolean") {
          settings.allowCloudFallbackOnMobile = value;
        }
        break;
      default:
        return;
    }

    await this.host.saveSettings();
    if (shouldRefresh) {
      this.refreshTab();
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderVoiceInputSection(containerEl);
    this.renderReadAloudSection(containerEl);
    this.renderAiModelSection(containerEl);
    this.renderModelsAndPrivacySection(containerEl);
  }

  private refreshTab(): void {
    if (requireApiVersion("1.13.0")) {
      this.update();
      return;
    }
    this.display();
  }

  private validateOptionalEndpointMessage(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      validateEndpointUrl(trimmed);
      return undefined;
    } catch {
      return "Use an HTTPS URL or a loopback HTTP address.";
    }
  }

  private validateLoopbackDaemonMessage(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      validateLoopbackUrl(trimmed);
      return undefined;
    } catch {
      return "Daemon URL must point to a local loopback host (127.0.0.1, localhost, or ::1).";
    }
  }

  private validateCustomCacheDirMessage(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed || !this.host.capabilities.allowLocalWasmModels) {
      return undefined;
    }
    try {
      resolveExternalModelCacheDir({
        customDir: trimmed,
        vaultBasePath: this.host.getVaultBasePath?.() ?? null,
      });
      return undefined;
    } catch (err) {
      return err instanceof Error
        ? err.message
        : "Custom model cache directory must be an absolute path outside the vault.";
    }
  }

  private attachSecretControl(
    setting: Setting,
    currentSecretId: string,
    onUpdate: (secretId: string) => Promise<void>,
  ): void {
    if (!hasSecretStorage(this.app) || typeof SecretComponent !== "function") {
      setting.setDesc(SECRET_STORAGE_UPGRADE_NOTICE);
      setting.setDisabled(true);
      return;
    }

    setting.addComponent((el) =>
      new SecretComponent(this.app, el)
        .setValue(currentSecretId)
        .onChange(async (value) => {
          const candidate = (value ?? "").trim();
          await onUpdate(isValidSecretId(candidate) ? candidate : "");
        }),
    );
  }

  private renderVoiceInputSection(containerEl: HTMLElement): void {
    const { capabilities } = this.host;
    const currentAsrEngine = this.resolveEffectiveAsr();

    new Setting(containerEl).setName("Voice input").setHeading();

    new Setting(containerEl)
      .setName("Recognition engine")
      .setDesc(
        "Choose how dictation is transcribed. Mobile devices disable local WASM models to stay within memory limits.",
      )
      .addDropdown((dropdown) => {
        for (const engine of capabilities.allowedAsrEngines) {
          dropdown.addOption(engine, ASR_ENGINE_LABELS[engine]);
        }
        dropdown.setValue(currentAsrEngine).onChange(async (value) => {
          this.host.settings.asrEngine = value as ObsidianAsrEngine;
          await this.host.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Dictation trigger mode")
      .setDesc("Choose continuous toggle, single-utterance auto-stop, or push-to-talk.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("toggle", DICTATION_MODE_LABELS.toggle)
          .addOption("single", DICTATION_MODE_LABELS.single)
          .addOption("push-to-talk", DICTATION_MODE_LABELS["push-to-talk"])
          .setValue(this.host.settings.dictationMode)
          .onChange(async (value) => {
            if (value === "toggle" || value === "single" || value === "push-to-talk") {
              this.host.settings.dictationMode = value;
              await this.host.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName("Dictation language")
      .setDesc(
        "Locale code used for dictation and transcription requests (use zh-CN or auto for mixed Chinese and English).",
      )
      .addText((text) => {
        text
          .setPlaceholder("zh-CN")
          .setValue(this.host.settings.dictationLanguage)
          .onChange(async (value) => {
            this.host.settings.dictationLanguage = value.trim() || "zh-CN";
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Silence endpoint duration")
      .setDesc("Trailing silence in milliseconds before an utterance is finalized (400 to 5000 ms).")
      .addSlider((slider) => {
        slider
          .setLimits(400, 5000, 100)
          .setValue(this.host.settings.endpointSilenceMs)
          .onChange(async (value) => {
            this.host.settings.endpointSilenceMs = Math.round(value);
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show live subtitle overlay")
      .setDesc("Display a compact transcript card at the bottom of the workspace during voice activity.")
      .addToggle((toggle) => {
        toggle.setValue(this.host.settings.enableSubtitleOverlay).onChange(async (value) => {
          this.host.settings.enableSubtitleOverlay = value;
          await this.host.saveSettings();
        });
      });

    this.renderReplacementsEditor(containerEl);

    const asrSecretSetting = new Setting(containerEl)
      .setName("Transcription API key")
      .setDesc(
        `Select a secret stored in Obsidian secret storage (suggested ID: ${toSecretId("asr", "openai-compat")}).`,
      );
    this.attachSecretControl(asrSecretSetting, this.host.settings.asrApiKeySecretId, async (candidate) => {
      this.host.settings.asrApiKeySecretId = candidate;
      await this.host.saveSettings();
    });

    new Setting(containerEl)
      .setName("Transcription endpoint URL")
      .setDesc("Optional HTTPS or loopback HTTP endpoint for OpenAI-compatible speech recognition.")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.host.settings.asrEndpointUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            const errMsg = this.validateOptionalEndpointMessage(trimmed);
            if (errMsg) {
              new Notice(errMsg);
              return;
            }
            this.host.settings.asrEndpointUrl = trimmed;
            await this.host.saveSettings();
          });
      });

    if (currentAsrEngine === "openai-compat") {
      new Setting(containerEl)
        .setName("Transcription model override")
        .setDesc(
          "Leave empty to use the default transcription model for your OpenAI-compatible endpoint.",
        )
        .addText((text) => {
          text
            .setPlaceholder("whisper-1")
            .setValue(this.host.settings.asrModel)
            .onChange(async (value) => {
              this.host.settings.asrModel = value.trim();
              await this.host.saveSettings();
            });
        });
    }
  }

  private renderReplacementsEditor(parentEl: HTMLElement): void {
    const panel = parentEl.createDiv({ cls: "vm-replacements-panel" });

    const header = panel.createDiv({ cls: "vm-replacements-header" });
    header.createSpan({
      cls: "vm-replacements-title",
      text: "Personal vocabulary replacements",
    });
    const budgetSpan = header.createSpan({ cls: "vm-replacements-budget" });

    const currentRules = (): AsrReplacement[] => this.host.settings.asrReplacements;

    const updateBudgetLabel = (): void => {
      const rules = currentRules();
      const used = replacementsPayloadBytes(rules);
      budgetSpan.setText(
        `${rules.length} rules (${used} / ${REPLACEMENTS_MAX_PAYLOAD_BYTES} UTF-8 bytes)`,
      );
    };
    updateBudgetLabel();

    panel.createDiv({
      cls: "vm-model-meta",
      text: "Map spoken aliases or homophones to domain terms, proper nouns, or [[wikilinks]] in a single pass.",
    });

    const listEl = panel.createDiv({ cls: "vm-replacements-list" });

    const commitCandidateRules = async (
      candidate: AsrReplacement[],
      reRender: boolean,
    ): Promise<boolean> => {
      const check = validateReplacements(candidate);
      if (!check.ok) {
        new Notice(`Invalid replacement dictionary: ${check.error}.`);
        return false;
      }
      this.host.settings.asrReplacements = check.rules;
      await this.host.saveSettings();
      if (reRender) {
        renderRows();
      }
      updateBudgetLabel();
      return true;
    };

    const renderRows = (): void => {
      listEl.empty();
      const rules = currentRules();
      if (rules.length === 0) {
        listEl.createDiv({
          cls: "vm-replacements-empty",
          text: "No custom vocabulary rules configured yet.",
        });
        return;
      }

      rules.forEach((rule, index) => {
        const row = listEl.createDiv({ cls: "vm-replacement-row" });
        const fromInput = row.createEl("input", {
          type: "text",
          value: rule.from.join(", "),
          placeholder: "Spoken aliases (comma-separated)",
        });
        row.createSpan({ cls: "vm-replacement-arrow", text: "->" });
        const toInput = row.createEl("input", {
          type: "text",
          value: rule.to,
          placeholder: "Replacement term",
        });
        const removeBtn = row.createEl("button", { text: "Remove" });

        const applyEdit = async (): Promise<void> => {
          const nextAliases = parseAliasList(fromInput.value);
          const nextTo = toInput.value.trim();
          if (
            nextAliases.join("\u0000") === rule.from.join("\u0000") &&
            nextTo === rule.to
          ) {
            return;
          }
          if (nextAliases.length === 0 || !nextTo) {
            fromInput.value = rule.from.join(", ");
            toInput.value = rule.to;
            new Notice("Both spoken aliases and target term are required.");
            return;
          }
          const copy: AsrReplacement[] = currentRules().map((item, idx) =>
            idx === index ? { from: nextAliases, to: nextTo } : item,
          );
          const ok = await commitCandidateRules(copy, false);
          if (!ok) {
            fromInput.value = rule.from.join(", ");
            toInput.value = rule.to;
          } else {
            rule.from = nextAliases;
            rule.to = nextTo;
          }
        };

        fromInput.addEventListener("change", () => {
          void applyEdit();
        });
        toInput.addEventListener("change", () => {
          void applyEdit();
        });
        removeBtn.addEventListener("click", () => {
          const filtered = currentRules().filter((_, idx) => idx !== index);
          void commitCandidateRules(filtered, true);
        });
      });
    };

    renderRows();

    const addRow = panel.createDiv({ cls: "vm-replacement-row vm-replacement-add-row" });
    const newFromInput = addRow.createEl("input", {
      type: "text",
      placeholder: "Aliases (e.g. 光四点, 光4点)",
    });
    addRow.createSpan({ cls: "vm-replacement-arrow", text: "->" });
    const newToInput = addRow.createEl("input", {
      type: "text",
      placeholder: "Target term (e.g. Obsidian)",
    });
    const addBtn = addRow.createEl("button", { cls: "mod-cta", text: "Add rule" });

    const submitNewRule = async (): Promise<void> => {
      const fromAliases = parseAliasList(newFromInput.value);
      const toVal = newToInput.value.trim();
      if (fromAliases.length === 0 || !toVal) {
        new Notice("Enter at least one spoken alias and a target replacement term.");
        return;
      }
      const nextRules: AsrReplacement[] = [
        ...currentRules(),
        { from: fromAliases, to: toVal },
      ];
      const ok = await commitCandidateRules(nextRules, true);
      if (ok) {
        newFromInput.value = "";
        newToInput.value = "";
      }
    };

    addBtn.addEventListener("click", () => {
      void submitNewRule();
    });
    newToInput.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void submitNewRule();
      }
    });
  }

  private renderReadAloudSection(containerEl: HTMLElement): void {
    const { capabilities } = this.host;
    const currentTtsEngine = this.resolveEffectiveTts();
    const activeTtsPreset = resolveTtsOpenAiPreset(this.host.settings.ttsPresetId);
    const voiceMeta = this.describeTtsVoiceMeta(currentTtsEngine, this.host.settings.ttsPresetId);

    new Setting(containerEl).setName("Read aloud").setHeading();

    new Setting(containerEl)
      .setName("Speech engine")
      .setDesc("System speech works immediately with zero downloads. Optional local or cloud engines can be mounted.")
      .addDropdown((dropdown) => {
        for (const engine of capabilities.allowedTtsEngines) {
          dropdown.addOption(engine, TTS_ENGINE_LABELS[engine]);
        }
        dropdown.setValue(currentTtsEngine).onChange(async (value) => {
          this.host.settings.ttsEngine = asTtsEngineKind(value);
          await this.host.saveSettings();
          this.display();
        });
      });

    if (currentTtsEngine === "openai-compat") {
      new Setting(containerEl)
        .setName("TTS preset")
        .setDesc(
          "Choose a cloud or local loopback OpenAI-compatible speech preset, or select custom endpoint.",
        )
        .addDropdown((dropdown) => {
          for (const [id, label] of Object.entries(buildTtsPresetOptions())) {
            dropdown.addOption(id, label);
          }
          dropdown.setValue(this.host.settings.ttsPresetId).onChange(async (value) => {
            this.host.settings.ttsPresetId = value;
            await this.host.saveSettings();
            this.display();
          });
        });
    }

    if (currentTtsEngine === "vits-wasm") {
      new Setting(containerEl)
        .setName("VITS speaker")
        .setDesc("Select one of the built-in VITS speakers or leave on default.")
        .addDropdown((dropdown) => {
          for (const [id, label] of Object.entries(buildVitsSpeakerOptions())) {
            dropdown.addOption(id, label);
          }
          const selectedSpeaker = VITS_SPEAKERS.some((s) => s.name === this.host.settings.ttsVoice)
            ? this.host.settings.ttsVoice
            : "";
          dropdown.setValue(selectedSpeaker).onChange(async (value) => {
            this.host.settings.ttsVoice = value;
            await this.host.saveSettings();
            this.display();
          });
        });
    }

    new Setting(containerEl)
      .setName("Preferred voice name")
      .setDesc(voiceMeta.desc)
      .addText((text) => {
        text
          .setPlaceholder(voiceMeta.placeholder)
          .setValue(this.host.settings.ttsVoice)
          .onChange(async (value) => {
            this.host.settings.ttsVoice = value.trim();
            await this.host.saveSettings();
          });
      });

    if (currentTtsEngine === "openai-compat" || currentTtsEngine === "mimo") {
      new Setting(containerEl)
        .setName("TTS model override")
        .setDesc("Leave empty to use the default speech model for the active provider or preset.")
        .addText((text) => {
          text
            .setPlaceholder(
              currentTtsEngine === "mimo"
                ? MIMO_DEFAULT_MODEL
                : activeTtsPreset?.model || "tts-1",
            )
            .setValue(this.host.settings.ttsModel)
            .onChange(async (value) => {
              this.host.settings.ttsModel = value.trim();
              await this.host.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("TTS endpoint URL")
        .setDesc(
          "Optional HTTPS or loopback HTTP speech endpoint URL. Plaintext HTTP is blocked for remote hosts.",
        )
        .addText((text) => {
          text
            .setPlaceholder(
              currentTtsEngine === "mimo"
                ? MIMO_DEFAULT_BASE_URL
                : activeTtsPreset?.baseUrl || "https://api.openai.com/v1",
            )
            .setValue(this.host.settings.ttsEndpointUrl)
            .onChange(async (value) => {
              const trimmed = value.trim();
              const errMsg = this.validateOptionalEndpointMessage(trimmed);
              if (errMsg) {
                new Notice(errMsg);
                return;
              }
              this.host.settings.ttsEndpointUrl = trimmed;
              await this.host.saveSettings();
            });
        });

      const presetScope =
        currentTtsEngine === "openai-compat" ? this.host.settings.ttsPresetId : undefined;
      const ttsSecretSetting = new Setting(containerEl)
        .setName("Speech API key")
        .setDesc(this.describeTtsSecretDesc(currentTtsEngine, this.host.settings.ttsPresetId));
      this.attachSecretControl(
        ttsSecretSetting,
        getTtsSecretId(this.host.settings, currentTtsEngine, presetScope),
        async (candidate) => {
          const scope =
            currentTtsEngine === "openai-compat" ? this.host.settings.ttsPresetId : undefined;
          setTtsSecretId(this.host.settings, currentTtsEngine, candidate, scope);
          await this.host.saveSettings();
        },
      );
    }

    new Setting(containerEl)
      .setName("Speech rate")
      .setDesc("Adjust read-aloud playback speed between 0.5x and 2.0x.")
      .addSlider((slider) => {
        slider
          .setLimits(0.5, 2.0, 0.1)
          .setValue(this.host.settings.speechRate)
          .onChange(async (value) => {
            this.host.settings.speechRate = value;
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Markdown table handling")
      .setDesc("Choose whether Markdown pipe tables are skipped or replaced with a short spoken hint.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("skip", "Skip tables")
          .addOption("placeholder", "Speak brief placeholder")
          .setValue(this.host.settings.markdownTablePolicy)
          .onChange(async (value) => {
            this.host.settings.markdownTablePolicy = value as MarkdownTablePolicy;
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Subtitle text size")
      .setDesc("Choose the font size for the live transcript and read-aloud subtitle card.")
      .addDropdown((dropdown) => {
        for (const key of ["small", "medium", "large"] as const) {
          dropdown.addOption(key, SUBTITLE_FONT_SIZE_LABELS[key]);
        }
        dropdown.setValue(this.host.settings.subtitleFontSize).onChange(async (value) => {
          if (value === "small" || value === "medium" || value === "large") {
            this.host.settings.subtitleFontSize = value;
            await this.host.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName("Subtitle card width")
      .setDesc("Choose the maximum width of the floating subtitle card.")
      .addDropdown((dropdown) => {
        for (const key of ["narrow", "medium", "wide"] as const) {
          dropdown.addOption(key, SUBTITLE_WIDTH_LABELS[key]);
        }
        dropdown.setValue(this.host.settings.subtitleWidth).onChange(async (value) => {
          if (value === "narrow" || value === "medium" || value === "wide") {
            this.host.settings.subtitleWidth = value;
            await this.host.saveSettings();
          }
        });
      });

    new Setting(containerEl)
      .setName("Stop read-aloud when switching notes")
      .setDesc("Immediately cancel active read-aloud when opening or switching to another note.")
      .addToggle((toggle) => {
        toggle.setValue(this.host.settings.stopReadAloudOnNoteSwitch).onChange(async (value) => {
          this.host.settings.stopReadAloudOnNoteSwitch = value;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Barge-in mode")
      .setDesc(
        "Control hands-free voice interruption during non-system read-aloud. System speech always uses manual stop to avoid speaker echo loops.",
      )
      .addDropdown((dropdown) => {
        for (const key of ["detect", "auto", "manual"] as const) {
          dropdown.addOption(key, BARGE_IN_MODE_LABELS[key]);
        }
        dropdown.setValue(this.host.settings.bargeInMode).onChange(async (value) => {
          if (value === "detect" || value === "auto" || value === "manual") {
            this.host.settings.bargeInMode = value;
            await this.host.saveSettings();
            this.display();
          }
        });
      });
  }

  private renderAiModelSection(containerEl: HTMLElement): void {
    const currentPresetId = this.host.settings.llmPresetId;
    const activePreset = LLM_PRESETS[currentPresetId];

    new Setting(containerEl).setName("AI model").setHeading();

    new Setting(containerEl)
      .setName("Enable optional BYOK voice assistant")
      .setDesc(
        "Leave disabled for strictly offline dictation and read-aloud. Ask AI about selection or note uses your own model provider with automatic CORS fallback. Volcengine endpoints accept model names or an ep-xxx endpoint ID.",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.host.settings.enableVoiceQa).onChange(async (value) => {
          this.host.settings.enableVoiceQa = value;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Post-dictation LLM polish")
      .setDesc(
        "Apply minimal typo, homophone, and punctuation cleanup after dictation with 4-layer anti-hallucination guards. Falls back to original text on any error.",
      )
      .addToggle((toggle) => {
        toggle.setValue(this.host.settings.enableLlmPolish).onChange(async (value) => {
          this.host.settings.enableLlmPolish = value;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Provider preset")
      .setDesc(
        "Choose a BYOK cloud provider or local loopback server. Direct CORS works with DeepSeek, Qwen, Kimi, SiliconFlow, OpenRouter, and Anthropic; automatic CORS fallback handles Volcengine, OpenAI, and Ollama loopback.",
      )
      .addDropdown((dropdown) => {
        for (const presetId of LLM_PRESET_IDS) {
          dropdown.addOption(presetId, LLM_PRESETS[presetId].label);
        }
        dropdown.setValue(this.host.settings.llmPresetId).onChange(async (value) => {
          this.host.settings.llmPresetId = asLlmPresetId(value);
          await this.host.saveSettings();
          this.display();
        });
      });

    const llmSecretSetting = new Setting(containerEl)
      .setName("Provider API key")
      .setDesc(
        `Select a secret stored in Obsidian secret storage for ${activePreset.label} (suggested ID: ${toSecretId("llm", currentPresetId)}).`,
      );
    this.attachSecretControl(
      llmSecretSetting,
      getLlmSecretId(this.host.settings, currentPresetId),
      async (candidate) => {
        setLlmSecretId(this.host.settings, this.host.settings.llmPresetId, candidate);
        await this.host.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName("Model identifier override")
      .setDesc("Leave empty to use the default model defined by the selected preset.")
      .addText((text) => {
        text
          .setPlaceholder(activePreset.defaultModel || "model-name")
          .setValue(this.host.settings.llmModel)
          .onChange(async (value) => {
            this.host.settings.llmModel = value.trim();
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Endpoint URL override")
      .setDesc("Optional HTTPS or loopback HTTP base URL. Plaintext HTTP is blocked for remote hosts.")
      .addText((text) => {
        text
          .setPlaceholder(activePreset.defaultBaseUrl || "https://example.com/v1")
          .setValue(this.host.settings.llmBaseUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            const errMsg = this.validateOptionalEndpointMessage(trimmed);
            if (errMsg) {
              new Notice(errMsg);
              return;
            }
            this.host.settings.llmBaseUrl = trimmed;
            await this.host.saveSettings();
          });
      });
  }

  private renderModelsAndPrivacySection(containerEl: HTMLElement): void {
    const { capabilities } = this.host;

    new Setting(containerEl).setName("Models and privacy").setHeading();

    this.renderRuntimeBanner(containerEl);
    this.renderOfflineModelCard(containerEl);

    if (capabilities.allowLocalWasmModels) {
      new Setting(containerEl)
        .setName("Model download host")
        .setDesc(
          `Allowlisted HTTPS host (${ALLOWED_MODEL_HOSTNAMES.join(", ")}) for optional desktop model downloads stored outside the vault.`,
        )
        .addDropdown((dropdown) => {
          dropdown
            .addOption(MODEL_HOST_PRIMARY, "Primary host (huggingface.co)")
            .addOption(MODEL_HOST_FALLBACK, "Fallback mirror (hf-mirror.com)")
            .setValue(this.host.settings.modelMirrorHost)
            .onChange(async (value) => {
              const validated = validateModelHost(value);
              if (!validated) {
                new Notice("Selected model host is not on the allowlist.");
                return;
              }
              this.host.settings.modelMirrorHost = validated;
              await this.host.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName("Custom external model cache path")
        .setDesc(
          "Optional absolute path outside the vault for desktop offline models (useful for sandboxed Linux packages).",
        )
        .addText((text) => {
          text
            .setPlaceholder(capabilities.externalModelCacheDir)
            .setValue(this.host.settings.customModelCacheDir)
            .onChange(async (value) => {
              const trimmed = value.trim();
              const errMsg = this.validateCustomCacheDirMessage(trimmed);
              if (errMsg) {
                new Notice(errMsg);
                return;
              }
              this.host.settings.customModelCacheDir = trimmed;
              await this.host.saveSettings();
              this.refreshTab();
            });
        });

      new Setting(containerEl)
        .setName("Idle model unload timeout")
        .setDesc(
          "Minutes of inactivity before unloading the local WASM worker to free memory (0 keeps it loaded).",
        )
        .addSlider((slider) => {
          slider
            .setLimits(0, 30, 1)
            .setValue(this.host.settings.workerIdleUnloadMinutes)
            .onChange(async (value) => {
              this.host.settings.workerIdleUnloadMinutes = Math.round(value);
              await this.host.saveSettings();
            });
        });
    }

    if (capabilities.allowLocalDaemon) {
      new Setting(containerEl)
        .setName("Local daemon URL")
        .setDesc("Loopback address for an optional local voice daemon on desktop.")
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_LOCAL_DAEMON_URL)
            .setValue(this.host.settings.daemonUrl)
            .onChange(async (value) => {
              const trimmed = value.trim();
              const errMsg = this.validateLoopbackDaemonMessage(trimmed);
              if (errMsg) {
                new Notice(errMsg);
                return;
              }
              this.host.settings.daemonUrl = trimmed;
              await this.host.saveSettings();
            });
        });

      if (this.resolveEffectiveAsr() === "daemon" || this.resolveEffectiveTts() === "kokoro-daemon") {
        const daemonSecretSetting = new Setting(containerEl)
          .setName("Daemon auth token")
          .setDesc(
            `Select an optional bearer token stored in Obsidian secret storage for the local voice daemon (suggested ID: ${toSecretId("daemon", "local")}).`,
          );
        this.attachSecretControl(
          daemonSecretSetting,
          this.host.settings.daemonTokenSecretId,
          async (candidate) => {
            this.host.settings.daemonTokenSecretId = candidate;
            await this.host.saveSettings();
          },
        );
      }
    }

    new Setting(containerEl)
      .setName("Allow cloud fallback on mobile")
      .setDesc("Allow optional BYOK cloud speech endpoints when running on iOS or Android.")
      .addToggle((toggle) => {
        toggle.setValue(this.host.settings.allowCloudFallbackOnMobile).onChange(async (value) => {
          this.host.settings.allowCloudFallbackOnMobile = value;
          await this.host.saveSettings();
        });
      });
  }

  private renderOfflineModelCard(parentEl: HTMLElement): void {
    const { capabilities } = this.host;
    const card = parentEl.createDiv({ cls: "vm-model-card" });

    const header = card.createDiv({ cls: "vm-model-card-header" });
    header.createSpan({
      cls: "vm-model-card-title",
      text: "Offline dictation models (Silero VAD + SenseVoice int8 + WASM)",
    });
    const statusBadge = header.createSpan({
      cls: "vm-model-badge-missing",
      text: capabilities.allowLocalWasmModels ? "Checking..." : "Disabled on mobile",
    });

    if (!capabilities.allowLocalWasmModels) {
      card.createDiv({
        cls: "vm-model-meta",
        text: MOBILE_WASM_RESTRICTION_REASON,
      });
      return;
    }

    const vadBundle = MODEL_BUNDLES["silero-vad"];
    const senseBundle = MODEL_BUNDLES["sensevoice-int8"];
    const vitsBundle = MODEL_BUNDLES["vits-zh-ll"];
    const expectedTotalBytes =
      vadBundle.totalBytes +
      senseBundle.totalBytes +
      SHERPA_WASM_RUNTIME_202.files.reduce((acc, f) => acc + (f.bytes ?? 0), 0);

    card.createDiv({
      cls: "vm-model-meta",
      text: `Explicit download (~${formatMegabytes(expectedTotalBytes)} unpacked, SHA256-verified, zero vault pollution). Upstream licenses: Silero VAD (${vadBundle.license}), SenseVoice (${senseBundle.license}, ${ALLOWED_MODEL_HOSTNAMES.join(" / ")}), sherpa-onnx ${SHERPA_WASM_RUNTIME_202.version} WASM (${SHERPA_WASM_RUNTIME_202.license}, ${ALLOWED_WASM_HOSTNAMES.join(" / ")}).`,
    });

    card.createDiv({ cls: "vm-model-divider" });

    const vitsHeader = card.createDiv({ cls: "vm-model-card-header" });
    vitsHeader.createSpan({
      cls: "vm-model-card-title",
      text: "Optional offline speech synthesis (VITS)",
    });
    const vitsStatusBadge = vitsHeader.createSpan({
      cls: "vm-model-badge-missing",
      text: "Optional, not installed",
    });

    card.createDiv({
      cls: "vm-model-meta",
      text: `Optional local Mandarin read-aloud model (~${formatMegabytes(vitsBundle.totalBytes)} unpacked, 5 speakers, license: ${vitsBundle.license}).`,
    });

    const detailLine = card.createDiv({
      cls: "vm-model-meta vm-cache-path",
      text: `Cache path: ${capabilities.externalModelCacheDir}`,
    });

    const progressWrap = card.createDiv({ cls: "vm-model-progress-wrap vm-subtitle-hidden" });
    const progressTrack = progressWrap.createDiv({ cls: "vm-model-progress-track" });
    const progressBar = progressTrack.createDiv({ cls: "vm-model-progress-bar" });
    const progressLabel = progressWrap.createDiv({ cls: "vm-model-progress-label" });

    const actions = card.createDiv({ cls: "vm-model-actions" });
    const downloadBtn = actions.createEl("button", {
      cls: "mod-cta",
      text: "Download or verify models",
    });
    const downloadVitsBtn = actions.createEl("button", {
      text: "Download optional VITS model",
    });
    const cancelBtn = actions.createEl("button", {
      cls: "vm-subtitle-hidden",
      text: "Cancel download",
    });
    const openDirBtn = actions.createEl("button", {
      text: "Open cache folder",
    });
    const clearBtn = actions.createEl("button", {
      text: "Clear cached models",
    });

    const applyStatusToUi = (status: DictationStackStatus | null): void => {
      if (!status) {
        statusBadge.className = "vm-model-badge-missing";
        statusBadge.setText("Unavailable");
        vitsStatusBadge.className = "vm-model-badge-missing";
        vitsStatusBadge.setText("Optional, not installed");
        return;
      }
      const combinedVerifiedBytes = status.totalVerifiedBytes + status.vitsVerifiedBytes;
      detailLine.setText(
        `Cache path: ${status.cacheDir} | Verified: ${formatMegabytes(combinedVerifiedBytes)}`,
      );
      if (status.ready) {
        statusBadge.className = "vm-model-badge-ready";
        statusBadge.setText("Ready (SHA256 verified)");
      } else {
        statusBadge.className = "vm-model-badge-missing";
        statusBadge.setText(`Not installed (${status.missingOrCorruptFiles.length} pending)`);
      }
      if (status.vitsReady) {
        vitsStatusBadge.className = "vm-model-badge-ready";
        vitsStatusBadge.setText("Ready");
      } else {
        vitsStatusBadge.className = "vm-model-badge-missing";
        vitsStatusBadge.setText("Optional, not installed");
      }
    };

    const setBusyUi = (busy: boolean): void => {
      downloadBtn.disabled = busy;
      downloadVitsBtn.disabled = busy;
      clearBtn.disabled = busy;
      if (busy) {
        cancelBtn.removeClass("vm-subtitle-hidden");
        progressWrap.removeClass("vm-subtitle-hidden");
      } else {
        cancelBtn.addClass("vm-subtitle-hidden");
      }
    };

    if (this.host.isDownloadingModels?.()) {
      setBusyUi(true);
      progressLabel.setText("Download in progress...");
    }

    void this.host
      .getModelStatus?.()
      .then((status) => applyStatusToUi(status))
      .catch((err: unknown) => {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        detailLine.setText(`Cache status error: ${msg}`);
      });

    downloadBtn.addEventListener("click", () => {
      if (!this.host.startModelDownload) {
        return;
      }
      setBusyUi(true);
      progressBar.setCssProps({ "--vm-progress-width": "0%" });
      progressLabel.setText("Starting verified model download...");

      void this.host
        .startModelDownload((progress) => {
          const pct = Math.max(0, Math.min(100, progress.percent ?? 0));
          progressBar.setCssProps({ "--vm-progress-width": `${pct}%` });
          progressLabel.setText(
            `${progress.phase}: ${progress.file} (${pct}% via ${progress.host})`,
          );
        })
        .then((status) => {
          applyStatusToUi(status);
          progressBar.setCssProps({ "--vm-progress-width": "100%" });
          progressLabel.setText("All offline dictation models verified and ready.");
          if (this.containerEl.isConnected) {
            this.refreshTab();
          }
        })
        .catch((err: unknown) => {
          const msg = redactSecrets(err instanceof Error ? err.message : String(err));
          progressLabel.setText(`Download stopped: ${msg}`);
        })
        .finally(() => {
          setBusyUi(false);
        });
    });

    downloadVitsBtn.addEventListener("click", () => {
      if (!this.host.startVitsModelDownload) {
        return;
      }
      setBusyUi(true);
      progressBar.setCssProps({ "--vm-progress-width": "0%" });
      progressLabel.setText("Starting optional VITS model download...");

      void this.host
        .startVitsModelDownload((progress) => {
          const pct = Math.max(0, Math.min(100, progress.percent ?? 0));
          progressBar.setCssProps({ "--vm-progress-width": `${pct}%` });
          progressLabel.setText(
            `${progress.phase}: ${progress.file} (${pct}% via ${progress.host})`,
          );
        })
        .then((status) => {
          applyStatusToUi(status);
          progressBar.setCssProps({ "--vm-progress-width": "100%" });
          progressLabel.setText("All optional VITS speech model files verified and ready.");
          if (this.containerEl.isConnected) {
            this.refreshTab();
          }
        })
        .catch((err: unknown) => {
          const msg = redactSecrets(err instanceof Error ? err.message : String(err));
          progressLabel.setText(`Download stopped: ${msg}`);
        })
        .finally(() => {
          setBusyUi(false);
        });
    });

    cancelBtn.addEventListener("click", () => {
      this.host.cancelModelDownload?.();
      progressLabel.setText("Cancelling download (partial .part file preserved for resume)...");
    });

    openDirBtn.addEventListener("click", () => {
      if (!this.host.openModelCacheFolder) {
        return;
      }
      void this.host.openModelCacheFolder().catch((err: unknown) => {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        new Notice(`Could not open model cache folder: ${msg}`);
      });
    });

    clearBtn.addEventListener("click", () => {
      if (!this.host.clearCachedModels) {
        return;
      }
      setBusyUi(true);
      void this.host
        .clearCachedModels()
        .then(() => this.host.getModelStatus?.() ?? null)
        .then((status) => {
          applyStatusToUi(status);
          progressWrap.addClass("vm-subtitle-hidden");
        })
        .catch((err: unknown) => {
          const msg = redactSecrets(err instanceof Error ? err.message : String(err));
          new Notice(`Could not clear cached models: ${msg}`);
        })
        .finally(() => {
          setBusyUi(false);
        });
    });
  }

  private renderRuntimeBanner(parentEl: HTMLElement): void {
    const { capabilities, settings } = this.host;
    const effectiveTts = this.resolveEffectiveTts();
    const usesSystemTts = effectiveTts === "system" || effectiveTts === "kokoro-daemon";
    const bargeIn =
      this.host.getBargeInDecision?.() ??
      resolveBargeInPolicy({
        requestedMode: settings.bargeInMode,
        usesSystemTts,
        isMobile: capabilities.isMobile,
        isSafari: Platform.isSafari,
        nativeAecActive: false,
      });

    const banner = parentEl.createDiv({ cls: "vm-runtime-banner" });
    this.appendRuntimeRow(
      banner,
      "Host environment",
      capabilities.isMobile ? "Mobile (memory-safe mode)" : "Desktop",
    );
    this.appendRuntimeRow(
      banner,
      "Local WASM models",
      capabilities.allowLocalWasmModels
        ? `Available on demand (max ${capabilities.maxConcurrentLocalModels} active model, budget ${capabilities.maxLocalModelMemoryMb} MB)`
        : "Disabled on mobile (OOM safeguard)",
    );
    this.appendRuntimeRow(
      banner,
      "Secret storage",
      hasSecretStorage(this.app) ? "Available (Obsidian keychain)" : "Unavailable (upgrade to 1.11.4+)",
    );
    this.appendRuntimeRow(
      banner,
      "Barge-in policy",
      bargeIn.allowHandsFreeBargeIn ? "Automatic (native AEC)" : `Manual (${bargeIn.reason})`,
    );
    this.appendRuntimeRow(
      banner,
      "External model cache",
      this.host.settings.customModelCacheDir || capabilities.externalModelCacheDir,
      "vm-cache-path",
    );
  }

  private appendRuntimeRow(
    parent: HTMLElement,
    label: string,
    value: string,
    valueClass = "vm-runtime-value",
  ): void {
    const row = parent.createDiv({ cls: "vm-runtime-row" });
    row.createSpan({ cls: "vm-runtime-label", text: label });
    row.createSpan({ cls: valueClass, text: value });
  }
}
