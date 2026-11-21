import {
  LLM_PRESET_IDS,
  MODEL_HOST_PRIMARY,
  TTS_ENGINE_KINDS,
  asLlmPresetId,
  asTtsEngineKind,
  validateEndpointUrl,
  validateLoopbackUrl,
  validateModelHost,
  validateReplacements,
  type AsrReplacement,
  type LlmPresetId,
  type MarkdownTablePolicy,
  type SecretStore,
  type TtsEngineKind,
} from "@voice-mode/core";
import type { DictationMode } from "@voice-mode/browser";
import type { SecretStorage } from "obsidian";
import {
  DEFAULT_LOCAL_DAEMON_URL,
  type ObsidianAsrEngine,
} from "./runtime-guard.ts";

/**
 * Obsidian SecretStorage requires strictly lowercase alphanumeric IDs with optional hyphens.
 */
export const SECRET_ID_RE = /^[a-z0-9-]+$/;

const VALID_ASR_ENGINES: ReadonlySet<string> = new Set([
  "system",
  "sensevoice-wasm",
  "zipformer-wasm",
  "openai-compat",
  "daemon",
]);

const VALID_DICTATION_MODES: ReadonlySet<string> = new Set([
  "toggle",
  "single",
  "push-to-talk",
]);

const VALID_LLM_PRESETS: ReadonlySet<string> = new Set<string>(LLM_PRESET_IDS);
const VALID_TTS_ENGINES: ReadonlySet<string> = new Set<string>(TTS_ENGINE_KINDS);
const VALID_TABLE_POLICIES: ReadonlySet<string> = new Set(["skip", "placeholder"]);

const LEGACY_FLAT_SECRET_ID_KEYS: ReadonlySet<string> = new Set([
  "llmApiKeySecretId",
  "ttsApiKeySecretId",
]);

const FORBIDDEN_SECRET_KEYS_RE =
  /(?:api[-_]?key|secret|token|password|passwd|credential|authorization|bearer|private[-_]?key)/i;

const SECRET_ID_FIELD_RE = /SecretId$/;

const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /^\s*Bearer\s+\S{8,}/i,
  /^\s*Basic\s+[A-Za-z0-9+/=]{8,}/i,
  /https?:\/\/[^:@/\s]+:[^@/\s]+@/i,
  /\bsk-(?:proj|live|test|ant)?-?[A-Za-z0-9_-]{16,}\b/,
  /\bgsk_[A-Za-z0-9._-]{16,}\b/,
  /\brk_(?:live|test)_[A-Za-z0-9]{12,}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b[0-9a-f]{32}\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

export interface VoiceModeSettings {
  // Voice input
  asrEngine: ObsidianAsrEngine;
  dictationMode: DictationMode;
  dictationLanguage: string;
  endpointSilenceMs: number;
  asrEndpointUrl: string;
  asrApiKeySecretId: string;
  asrReplacements: AsrReplacement[];
  enableSubtitleOverlay: boolean;

  // Read aloud
  ttsEngine: TtsEngineKind;
  ttsVoice: string;
  speechRate: number;
  markdownTablePolicy: MarkdownTablePolicy;
  maxSentenceChars: number;
  ttsEndpointUrl: string;
  ttsApiKeySecretIds: Partial<Record<TtsEngineKind, string>>;

  // Optional BYOK AI model
  enableVoiceQa: boolean;
  llmPresetId: LlmPresetId;
  llmBaseUrl: string;
  llmModel: string;
  llmApiKeySecretIds: Partial<Record<LlmPresetId, string>>;

  // Models and privacy
  modelMirrorHost: string;
  customModelCacheDir: string;
  workerIdleUnloadMinutes: number;
  daemonUrl: string;
  allowCloudFallbackOnMobile: boolean;
}

export const DEFAULT_SETTINGS: Readonly<VoiceModeSettings> = {
  asrEngine: "system",
  dictationMode: "toggle",
  dictationLanguage: "zh-CN",
  endpointSilenceMs: 1500,
  asrEndpointUrl: "",
  asrApiKeySecretId: "",
  asrReplacements: [],
  enableSubtitleOverlay: true,

  ttsEngine: "system",
  ttsVoice: "",
  speechRate: 1.0,
  markdownTablePolicy: "skip",
  maxSentenceChars: 200,
  ttsEndpointUrl: "",
  ttsApiKeySecretIds: {},

  enableVoiceQa: false,
  llmPresetId: "deepseek",
  llmBaseUrl: "",
  llmModel: "",
  llmApiKeySecretIds: {},

  modelMirrorHost: MODEL_HOST_PRIMARY,
  customModelCacheDir: "",
  workerIdleUnloadMinutes: 5,
  daemonUrl: DEFAULT_LOCAL_DAEMON_URL,
  allowCloudFallbackOnMobile: false,
};

export function createDefaultSettings(): VoiceModeSettings {
  return {
    ...DEFAULT_SETTINGS,
    asrReplacements: [],
    ttsApiKeySecretIds: {},
    llmApiKeySecretIds: {},
  };
}

/**
 * Returns true if the given ID satisfies Obsidian's `SecretStorage.setSecret` constraint.
 */
export function isValidSecretId(id: string): boolean {
  return typeof id === "string" && id.length > 0 && SECRET_ID_RE.test(id);
}

function slugifySegment(raw: string): string {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/**
 * Construct a deterministic Obsidian SecretStorage ID strictly matching `/^[a-z0-9-]+$/`.
 */
export function toSecretId(namespace: string, presetId: string): string {
  const ns = slugifySegment(namespace);
  const preset = slugifySegment(presetId);
  if (!ns || !preset) {
    throw new Error("Both namespace and presetId must contain at least one alphanumeric character.");
  }
  const prefixed = ns.startsWith("voice-mode-") || ns === "voice-mode" ? ns : `voice-mode-${ns}`;
  const candidate = `${prefixed}-${preset}`.replace(/-{2,}/g, "-");
  if (!SECRET_ID_RE.test(candidate)) {
    throw new Error(`Generated secret ID "${candidate}" is invalid.`);
  }
  return candidate;
}

function looksLikeRawSecret(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanSecretId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return isValidSecretId(trimmed) && !looksLikeRawSecret(trimmed) ? trimmed : "";
}

function sanitizeSecretIdMap<K extends string>(
  raw: unknown,
  allowedKeys: ReadonlySet<string>,
): Partial<Record<K, string>> {
  if (!isPlainRecord(raw)) {
    return {};
  }
  const out: Partial<Record<K, string>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedKeys.has(key)) {
      continue;
    }
    const id = cleanSecretId(value);
    if (id) {
      out[key as K] = id;
    }
  }
  return out;
}

function sanitizeArrayValue(items: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (!looksLikeRawSecret(item)) {
        out.push(item);
      }
      continue;
    }
    if (Array.isArray(item)) {
      out.push(sanitizeArrayValue(item));
      continue;
    }
    if (isPlainRecord(item)) {
      out.push(stripSecretsFromSettings(item));
      continue;
    }
    out.push(item);
  }
  return out;
}

/**
 * Read the SecretStorage ID bound to a specific LLM provider preset.
 */
export function getLlmSecretId(settings: VoiceModeSettings, presetId: LlmPresetId): string {
  return cleanSecretId(settings.llmApiKeySecretIds[presetId]);
}

/**
 * Bind (or clear) the SecretStorage ID for a specific LLM provider preset without affecting other presets.
 */
export function setLlmSecretId(
  settings: VoiceModeSettings,
  presetId: LlmPresetId,
  secretId: string,
): void {
  const cleaned = cleanSecretId(secretId);
  if (cleaned) {
    settings.llmApiKeySecretIds[presetId] = cleaned;
  } else {
    delete settings.llmApiKeySecretIds[presetId];
  }
}

/**
 * Read the SecretStorage ID bound to a specific TTS engine.
 */
export function getTtsSecretId(settings: VoiceModeSettings, engine: TtsEngineKind): string {
  return cleanSecretId(settings.ttsApiKeySecretIds[engine]);
}

/**
 * Bind (or clear) the SecretStorage ID for a specific TTS engine without affecting other engines.
 */
export function setTtsSecretId(
  settings: VoiceModeSettings,
  engine: TtsEngineKind,
  secretId: string,
): void {
  const cleaned = cleanSecretId(secretId);
  if (cleaned) {
    settings.ttsApiKeySecretIds[engine] = cleaned;
  } else {
    delete settings.ttsApiKeySecretIds[engine];
  }
}

/**
 * Defense-in-depth sanitizer ensuring zero plaintext API keys, URL-embedded credentials,
 * or raw tokens are ever persisted into `data.json`. Per-preset/engine secret ID maps
 * (`llmApiKeySecretIds`, `ttsApiKeySecretIds`) and `asrApiKeySecretId` preserve only
 * validated `/^[a-z0-9-]+$/` references while discarding legacy flat fields and unknown keys.
 */
export function stripSecretsFromSettings(raw: unknown): Record<string, unknown> {
  if (!isPlainRecord(raw)) {
    return {};
  }

  const clean: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (LEGACY_FLAT_SECRET_ID_KEYS.has(key)) {
      continue;
    }

    if (key === "llmApiKeySecretIds") {
      clean[key] = sanitizeSecretIdMap<LlmPresetId>(value, VALID_LLM_PRESETS);
      continue;
    }

    if (key === "ttsApiKeySecretIds") {
      clean[key] = sanitizeSecretIdMap<TtsEngineKind>(value, VALID_TTS_ENGINES);
      continue;
    }

    if (SECRET_ID_FIELD_RE.test(key)) {
      clean[key] = cleanSecretId(value);
      continue;
    }

    if (FORBIDDEN_SECRET_KEYS_RE.test(key)) {
      continue;
    }

    if (typeof value === "string") {
      if (looksLikeRawSecret(value)) {
        continue;
      }
      clean[key] = value;
      continue;
    }

    if (Array.isArray(value)) {
      clean[key] = sanitizeArrayValue(value);
      continue;
    }

    if (isPlainRecord(value)) {
      clean[key] = stripSecretsFromSettings(value);
      continue;
    }

    clean[key] = value;
  }

  return clean;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, value));
}

function sanitizeOptionalEndpointUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    validateEndpointUrl(trimmed);
    return trimmed;
  } catch {
    return "";
  }
}

function sanitizeDaemonUrl(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_LOCAL_DAEMON_URL;
  }
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    validateLoopbackUrl(trimmed);
    return trimmed;
  } catch {
    return "";
  }
}

/**
 * Parse and validate persisted `data.json` contents into a safe `VoiceModeSettings` object.
 */
export function normalizeSettings(raw: unknown): VoiceModeSettings {
  const sanitized = stripSecretsFromSettings(raw);

  const asrEngine: ObsidianAsrEngine =
    typeof sanitized.asrEngine === "string" && VALID_ASR_ENGINES.has(sanitized.asrEngine)
      ? (sanitized.asrEngine as ObsidianAsrEngine)
      : DEFAULT_SETTINGS.asrEngine;

  const dictationMode: DictationMode =
    typeof sanitized.dictationMode === "string" && VALID_DICTATION_MODES.has(sanitized.dictationMode)
      ? (sanitized.dictationMode as DictationMode)
      : DEFAULT_SETTINGS.dictationMode;

  const ttsEngine = asTtsEngineKind(sanitized.ttsEngine);
  const llmPresetId = asLlmPresetId(sanitized.llmPresetId);

  const markdownTablePolicy: MarkdownTablePolicy =
    typeof sanitized.markdownTablePolicy === "string" &&
    VALID_TABLE_POLICIES.has(sanitized.markdownTablePolicy)
      ? (sanitized.markdownTablePolicy as MarkdownTablePolicy)
      : DEFAULT_SETTINGS.markdownTablePolicy;

  const validatedReplacements = validateReplacements(sanitized.asrReplacements);
  const asrReplacements = validatedReplacements.ok ? validatedReplacements.rules : [];

  const validatedMirror =
    typeof sanitized.modelMirrorHost === "string"
      ? validateModelHost(sanitized.modelMirrorHost)
      : null;

  return {
    asrEngine,
    dictationMode,
    dictationLanguage:
      typeof sanitized.dictationLanguage === "string" && sanitized.dictationLanguage.trim().length > 0
        ? sanitized.dictationLanguage.trim()
        : DEFAULT_SETTINGS.dictationLanguage,
    endpointSilenceMs: Math.round(
      clampNumber(sanitized.endpointSilenceMs, 400, 5000, DEFAULT_SETTINGS.endpointSilenceMs),
    ),
    asrEndpointUrl: sanitizeOptionalEndpointUrl(sanitized.asrEndpointUrl),
    asrApiKeySecretId: cleanSecretId(sanitized.asrApiKeySecretId),
    asrReplacements,
    enableSubtitleOverlay:
      typeof sanitized.enableSubtitleOverlay === "boolean"
        ? sanitized.enableSubtitleOverlay
        : DEFAULT_SETTINGS.enableSubtitleOverlay,

    ttsEngine,
    ttsVoice: typeof sanitized.ttsVoice === "string" ? sanitized.ttsVoice.trim() : "",
    speechRate: clampNumber(sanitized.speechRate, 0.5, 2.0, DEFAULT_SETTINGS.speechRate),
    markdownTablePolicy,
    maxSentenceChars: Math.round(
      clampNumber(sanitized.maxSentenceChars, 60, 500, DEFAULT_SETTINGS.maxSentenceChars),
    ),
    ttsEndpointUrl: sanitizeOptionalEndpointUrl(sanitized.ttsEndpointUrl),
    ttsApiKeySecretIds: sanitizeSecretIdMap<TtsEngineKind>(
      sanitized.ttsApiKeySecretIds,
      VALID_TTS_ENGINES,
    ),

    enableVoiceQa:
      typeof sanitized.enableVoiceQa === "boolean"
        ? sanitized.enableVoiceQa
        : DEFAULT_SETTINGS.enableVoiceQa,
    llmPresetId,
    llmBaseUrl: sanitizeOptionalEndpointUrl(sanitized.llmBaseUrl),
    llmModel: typeof sanitized.llmModel === "string" ? sanitized.llmModel.trim() : "",
    llmApiKeySecretIds: sanitizeSecretIdMap<LlmPresetId>(
      sanitized.llmApiKeySecretIds,
      VALID_LLM_PRESETS,
    ),

    modelMirrorHost: validatedMirror ?? DEFAULT_SETTINGS.modelMirrorHost,
    customModelCacheDir:
      typeof sanitized.customModelCacheDir === "string"
        ? sanitized.customModelCacheDir.trim()
        : DEFAULT_SETTINGS.customModelCacheDir,
    workerIdleUnloadMinutes: Math.round(
      clampNumber(
        sanitized.workerIdleUnloadMinutes,
        0,
        60,
        DEFAULT_SETTINGS.workerIdleUnloadMinutes,
      ),
    ),
    daemonUrl: sanitizeDaemonUrl(sanitized.daemonUrl),
    allowCloudFallbackOnMobile:
      typeof sanitized.allowCloudFallbackOnMobile === "boolean"
        ? sanitized.allowCloudFallbackOnMobile
        : DEFAULT_SETTINGS.allowCloudFallbackOnMobile,
  };
}

export type SecretStorageLike = Pick<SecretStorage, "getSecret" | "setSecret" | "listSecrets">;

/**
 * Runtime guard for Obsidian builds older than 1.11.4 where `app.secretStorage` may be absent.
 */
export function hasSecretStorage(
  app: { secretStorage?: Partial<SecretStorageLike> | null } | null | undefined,
): app is { secretStorage: SecretStorageLike } {
  const storage = app?.secretStorage;
  return Boolean(
    storage &&
      typeof storage.getSecret === "function" &&
      typeof storage.setSecret === "function" &&
      typeof storage.listSecrets === "function",
  );
}

/**
 * Adapter bridging `@voice-mode/core`'s `SecretStore` contract onto Obsidian's native `app.secretStorage`.
 * Safely tolerates missing `secretStorage` on older hosts and normalizes empty strings to `null`.
 */
export class ObsidianSecretStore implements SecretStore {
  private readonly storage: SecretStorageLike | null;

  constructor(storage: SecretStorageLike | null | undefined) {
    this.storage = storage ?? null;
  }

  get available(): boolean {
    return this.storage !== null;
  }

  getSecret(id: string): string | null {
    if (!this.storage || !isValidSecretId(id)) {
      return null;
    }
    const raw = this.storage.getSecret(id);
    if (typeof raw !== "string" || raw.length === 0) {
      return null;
    }
    return raw;
  }

  setSecret(id: string, value: string): void {
    if (!this.storage) {
      throw new Error(
        "Obsidian secret storage is unavailable. Upgrade to Obsidian 1.11.4 or later to store API keys securely.",
      );
    }
    if (!isValidSecretId(id)) {
      throw new Error(
        `Invalid Obsidian secret ID "${id}". IDs must contain only lowercase alphanumeric characters and hyphens.`,
      );
    }
    this.storage.setSecret(id, value);
  }

  deleteSecret(id: string): void {
    if (!this.storage || !isValidSecretId(id)) {
      return;
    }
    this.storage.setSecret(id, "");
  }

  listSecrets(): string[] {
    if (!this.storage) {
      return [];
    }
    return this.storage.listSecrets();
  }
}
