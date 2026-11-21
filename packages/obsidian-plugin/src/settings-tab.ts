import {
  ALLOWED_MODEL_HOSTNAMES,
  LLM_PRESETS,
  LLM_PRESET_IDS,
  MODEL_HOST_FALLBACK,
  MODEL_HOST_PRIMARY,
  asLlmPresetId,
  asTtsEngineKind,
  validateEndpointUrl,
  validateLoopbackUrl,
  validateModelHost,
  type MarkdownTablePolicy,
  type TtsEngineKind,
} from "@voice-mode/core";
import { resolveBargeInPolicy } from "@voice-mode/browser";
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
import {
  DEFAULT_LOCAL_DAEMON_URL,
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
  type VoiceModeSettings,
} from "./settings.ts";

export interface VoiceModePluginHost {
  settings: VoiceModeSettings;
  readonly capabilities: RuntimeCapabilities;
  saveSettings(): Promise<void>;
}

const ASR_ENGINE_LABELS: Readonly<Record<ObsidianAsrEngine, string>> = {
  system: "System speech recognition",
  "sensevoice-wasm": "SenseVoice WASM (desktop local)",
  "zipformer-wasm": "Zipformer WASM (desktop local)",
  "openai-compat": "OpenAI-compatible endpoint (BYOK)",
  daemon: "Local voice daemon (desktop)",
};

const TTS_ENGINE_LABELS: Readonly<Record<TtsEngineKind, string>> = {
  system: "System speech synthesis",
  "vits-wasm": "VITS WASM (desktop local)",
  "kokoro-daemon": "Kokoro daemon (desktop local)",
  "openai-compat": "OpenAI-compatible endpoint (BYOK)",
  mimo: "MiMo cloud TTS (BYOK)",
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

export class VoiceModeSettingTab extends PluginSettingTab {
  private readonly host: VoiceModePluginHost;

  constructor(app: App, plugin: VoiceModePluginHost & Plugin) {
    super(app, plugin);
    this.host = plugin;
  }

  /**
   * Declarative setting definitions for Obsidian 1.13+ (enables native Settings Search).
   * Older hosts (1.11.4–1.12.x) render identically through `display()`.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const { settings, capabilities } = this.host;
    const asrOptions = buildOptionsMap(capabilities.allowedAsrEngines, ASR_ENGINE_LABELS);
    const ttsOptions = buildOptionsMap(capabilities.allowedTtsEngines, TTS_ENGINE_LABELS);
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
            name: "Dictation language",
            desc: "Locale code used for system dictation and transcription requests.",
            control: {
              type: "text",
              key: "dictationLanguage",
              placeholder: "zh-CN",
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
            name: "Transcription API key",
            desc: `Select a secret stored in Obsidian secret storage (suggested ID: ${toSecretId("asr", "openai-compat")}).`,
            render: (setting) => {
              this.attachSecretControl(setting, settings.asrApiKeySecretId, async (candidate) => {
                settings.asrApiKeySecretId = candidate;
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
            name: "Preferred voice name",
            desc: "Optional voice name or provider speaker ID. Leave empty to use the system default.",
            control: {
              type: "text",
              key: "ttsVoice",
              placeholder: "Default system voice",
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
            name: "Speech API key",
            desc: (() => {
              const effectiveTtsEngine = capabilities.allowedTtsEngines.includes(settings.ttsEngine)
                ? settings.ttsEngine
                : capabilities.defaultTtsEngine;
              return `Select a secret from Obsidian secret storage for ${TTS_ENGINE_LABELS[effectiveTtsEngine]} (suggested ID: ${toSecretId("tts", effectiveTtsEngine)}).`;
            })(),
            render: (setting) => {
              const currentEngine = capabilities.allowedTtsEngines.includes(settings.ttsEngine)
                ? settings.ttsEngine
                : capabilities.defaultTtsEngine;
              this.attachSecretControl(
                setting,
                getTtsSecretId(settings, currentEngine),
                async (candidate) => {
                  setTtsSecretId(settings, currentEngine, candidate);
                  await this.host.saveSettings();
                },
              );
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
            desc: "Leave disabled for strictly offline dictation and read-aloud. Enable only with your own model provider.",
            control: {
              type: "toggle",
              key: "enableVoiceQa",
            },
          },
          {
            name: "Provider preset",
            desc: "Choose a BYOK cloud provider or a local loopback server such as Ollama.",
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
              const currentPreset = settings.llmPresetId;
              this.attachSecretControl(
                setting,
                getLlmSecretId(settings, currentPreset),
                async (candidate) => {
                  setLlmSecretId(settings, currentPreset, candidate);
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
              setting.infoEl.empty();
              this.renderRuntimeBanner(setting.infoEl);
            },
          },
          {
            name: "Model download host",
            desc: `Allowlisted HTTPS host (${ALLOWED_MODEL_HOSTNAMES.join(", ")}) for optional desktop model downloads stored outside the vault.`,
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
      case "dictationLanguage":
        return settings.dictationLanguage;
      case "enableSubtitleOverlay":
        return settings.enableSubtitleOverlay;
      case "asrEndpointUrl":
        return settings.asrEndpointUrl;
      case "ttsEngine":
        return capabilities.allowedTtsEngines.includes(settings.ttsEngine)
          ? settings.ttsEngine
          : capabilities.defaultTtsEngine;
      case "ttsVoice":
        return settings.ttsVoice;
      case "speechRate":
        return settings.speechRate;
      case "markdownTablePolicy":
        return settings.markdownTablePolicy;
      case "enableVoiceQa":
        return settings.enableVoiceQa;
      case "llmPresetId":
        return settings.llmPresetId;
      case "llmModel":
        return settings.llmModel;
      case "llmBaseUrl":
        return settings.llmBaseUrl;
      case "modelMirrorHost":
        return settings.modelMirrorHost;
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
        }
        break;
      case "dictationLanguage":
        if (typeof value === "string") {
          settings.dictationLanguage = value.trim() || "zh-CN";
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
      case "ttsEngine":
        if (typeof value === "string") {
          settings.ttsEngine = asTtsEngineKind(value);
          shouldRefresh = true;
        }
        break;
      case "ttsVoice":
        if (typeof value === "string") {
          settings.ttsVoice = value.trim();
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
      case "enableVoiceQa":
        if (typeof value === "boolean") {
          settings.enableVoiceQa = value;
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
    const { settings, capabilities } = this.host;

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
        const current = capabilities.allowedAsrEngines.includes(settings.asrEngine)
          ? settings.asrEngine
          : capabilities.defaultAsrEngine;
        dropdown.setValue(current).onChange(async (value) => {
          settings.asrEngine = value as ObsidianAsrEngine;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Dictation language")
      .setDesc("Locale code used for system dictation and transcription requests.")
      .addText((text) => {
        text
          .setPlaceholder("zh-CN")
          .setValue(settings.dictationLanguage)
          .onChange(async (value) => {
            settings.dictationLanguage = value.trim() || "zh-CN";
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Show live subtitle overlay")
      .setDesc("Display a compact transcript card at the bottom of the workspace during voice activity.")
      .addToggle((toggle) => {
        toggle.setValue(settings.enableSubtitleOverlay).onChange(async (value) => {
          settings.enableSubtitleOverlay = value;
          await this.host.saveSettings();
        });
      });

    const asrSecretSetting = new Setting(containerEl)
      .setName("Transcription API key")
      .setDesc(
        `Select a secret stored in Obsidian secret storage (suggested ID: ${toSecretId("asr", "openai-compat")}).`,
      );
    this.attachSecretControl(asrSecretSetting, settings.asrApiKeySecretId, async (candidate) => {
      settings.asrApiKeySecretId = candidate;
      await this.host.saveSettings();
    });

    new Setting(containerEl)
      .setName("Transcription endpoint URL")
      .setDesc("Optional HTTPS or loopback HTTP endpoint for OpenAI-compatible speech recognition.")
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(settings.asrEndpointUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            const errMsg = this.validateOptionalEndpointMessage(trimmed);
            if (errMsg) {
              new Notice(errMsg);
              return;
            }
            settings.asrEndpointUrl = trimmed;
            await this.host.saveSettings();
          });
      });
  }

  private renderReadAloudSection(containerEl: HTMLElement): void {
    const { settings, capabilities } = this.host;

    new Setting(containerEl).setName("Read aloud").setHeading();

    new Setting(containerEl)
      .setName("Speech engine")
      .setDesc("System speech works immediately with zero downloads. Optional local or cloud engines can be mounted.")
      .addDropdown((dropdown) => {
        for (const engine of capabilities.allowedTtsEngines) {
          dropdown.addOption(engine, TTS_ENGINE_LABELS[engine]);
        }
        const current = capabilities.allowedTtsEngines.includes(settings.ttsEngine)
          ? settings.ttsEngine
          : capabilities.defaultTtsEngine;
        dropdown.setValue(current).onChange(async (value) => {
          settings.ttsEngine = asTtsEngineKind(value);
          await this.host.saveSettings();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Preferred voice name")
      .setDesc("Optional voice name or provider speaker ID. Leave empty to use the system default.")
      .addText((text) => {
        text
          .setPlaceholder("Default system voice")
          .setValue(settings.ttsVoice)
          .onChange(async (value) => {
            settings.ttsVoice = value.trim();
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Speech rate")
      .setDesc("Adjust read-aloud playback speed between 0.5x and 2.0x.")
      .addSlider((slider) => {
        slider
          .setLimits(0.5, 2.0, 0.1)
          .setValue(settings.speechRate)
          .onChange(async (value) => {
            settings.speechRate = value;
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
          .setValue(settings.markdownTablePolicy)
          .onChange(async (value) => {
            settings.markdownTablePolicy = value as MarkdownTablePolicy;
            await this.host.saveSettings();
          });
      });

    const currentTtsEngine = capabilities.allowedTtsEngines.includes(settings.ttsEngine)
      ? settings.ttsEngine
      : capabilities.defaultTtsEngine;
    const ttsSecretSetting = new Setting(containerEl)
      .setName("Speech API key")
      .setDesc(
        `Select a secret from Obsidian secret storage for ${TTS_ENGINE_LABELS[currentTtsEngine]} (suggested ID: ${toSecretId("tts", currentTtsEngine)}).`,
      );
    this.attachSecretControl(
      ttsSecretSetting,
      getTtsSecretId(settings, currentTtsEngine),
      async (candidate) => {
        setTtsSecretId(settings, currentTtsEngine, candidate);
        await this.host.saveSettings();
      },
    );
  }

  private renderAiModelSection(containerEl: HTMLElement): void {
    const { settings } = this.host;
    const activePreset = LLM_PRESETS[settings.llmPresetId];

    new Setting(containerEl).setName("AI model").setHeading();

    new Setting(containerEl)
      .setName("Enable optional BYOK voice assistant")
      .setDesc("Leave disabled for strictly offline dictation and read-aloud. Enable only with your own model provider.")
      .addToggle((toggle) => {
        toggle.setValue(settings.enableVoiceQa).onChange(async (value) => {
          settings.enableVoiceQa = value;
          await this.host.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Provider preset")
      .setDesc("Choose a BYOK cloud provider or a local loopback server such as Ollama.")
      .addDropdown((dropdown) => {
        for (const presetId of LLM_PRESET_IDS) {
          dropdown.addOption(presetId, LLM_PRESETS[presetId].label);
        }
        dropdown.setValue(settings.llmPresetId).onChange(async (value) => {
          settings.llmPresetId = asLlmPresetId(value);
          await this.host.saveSettings();
          this.display();
        });
      });

    const currentPresetId = settings.llmPresetId;
    const llmSecretSetting = new Setting(containerEl)
      .setName("Provider API key")
      .setDesc(
        `Select a secret stored in Obsidian secret storage for ${activePreset.label} (suggested ID: ${toSecretId("llm", currentPresetId)}).`,
      );
    this.attachSecretControl(
      llmSecretSetting,
      getLlmSecretId(settings, currentPresetId),
      async (candidate) => {
        setLlmSecretId(settings, currentPresetId, candidate);
        await this.host.saveSettings();
      },
    );

    new Setting(containerEl)
      .setName("Model identifier override")
      .setDesc("Leave empty to use the default model defined by the selected preset.")
      .addText((text) => {
        text
          .setPlaceholder(activePreset.defaultModel || "model-name")
          .setValue(settings.llmModel)
          .onChange(async (value) => {
            settings.llmModel = value.trim();
            await this.host.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Endpoint URL override")
      .setDesc("Optional HTTPS or loopback HTTP base URL. Plaintext HTTP is blocked for remote hosts.")
      .addText((text) => {
        text
          .setPlaceholder(activePreset.defaultBaseUrl || "https://example.com/v1")
          .setValue(settings.llmBaseUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            const errMsg = this.validateOptionalEndpointMessage(trimmed);
            if (errMsg) {
              new Notice(errMsg);
              return;
            }
            settings.llmBaseUrl = trimmed;
            await this.host.saveSettings();
          });
      });
  }

  private renderModelsAndPrivacySection(containerEl: HTMLElement): void {
    const { settings, capabilities } = this.host;

    new Setting(containerEl).setName("Models and privacy").setHeading();

    this.renderRuntimeBanner(containerEl);

    new Setting(containerEl)
      .setName("Model download host")
      .setDesc(
        `Allowlisted HTTPS host (${ALLOWED_MODEL_HOSTNAMES.join(", ")}) for optional desktop model downloads stored outside the vault.`,
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption(MODEL_HOST_PRIMARY, "Primary host (huggingface.co)")
          .addOption(MODEL_HOST_FALLBACK, "Fallback mirror (hf-mirror.com)")
          .setValue(settings.modelMirrorHost)
          .onChange(async (value) => {
            const validated = validateModelHost(value);
            if (!validated) {
              new Notice("Selected model host is not on the allowlist.");
              return;
            }
            settings.modelMirrorHost = validated;
            await this.host.saveSettings();
          });
      });

    if (capabilities.allowLocalDaemon) {
      new Setting(containerEl)
        .setName("Local daemon URL")
        .setDesc("Loopback address for an optional local voice daemon on desktop.")
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_LOCAL_DAEMON_URL)
            .setValue(settings.daemonUrl)
            .onChange(async (value) => {
              const trimmed = value.trim();
              const errMsg = this.validateLoopbackDaemonMessage(trimmed);
              if (errMsg) {
                new Notice(errMsg);
                return;
              }
              settings.daemonUrl = trimmed;
              await this.host.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName("Allow cloud fallback on mobile")
      .setDesc("Allow optional BYOK cloud speech endpoints when running on iOS or Android.")
      .addToggle((toggle) => {
        toggle.setValue(settings.allowCloudFallbackOnMobile).onChange(async (value) => {
          settings.allowCloudFallbackOnMobile = value;
          await this.host.saveSettings();
        });
      });
  }

  private renderRuntimeBanner(parentEl: HTMLElement): void {
    const { capabilities } = this.host;
    // Honest AEC probe status: until M2 wires live `probeTrackAec`, do not claim native AEC is active.
    const bargeIn = resolveBargeInPolicy({
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
      capabilities.externalModelCacheDir,
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
