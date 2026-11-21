import {
  isCloudAsrEngine,
  isCloudTtsEngine,
  resolveTranscriptionsEndpointUrl,
  type AsrEngineKind,
  type TtsEngineKind,
} from "@voice-mode/core";

export type HostPlatformClass = "desktop" | "mobile";
export type DesktopOsHint = "macos" | "linux" | "windows";
export type ObsidianAsrEngine = AsrEngineKind | "system";

export interface RuntimeCapabilities {
  readonly hostClass: HostPlatformClass;
  readonly isMobile: boolean;
  readonly allowLocalWasmModels: boolean;
  readonly allowLocalDaemon: boolean;
  readonly maxConcurrentLocalModels: number;
  readonly maxLocalModelMemoryMb: number;
  readonly defaultAsrEngine: ObsidianAsrEngine;
  readonly defaultTtsEngine: TtsEngineKind;
  readonly allowedAsrEngines: readonly ObsidianAsrEngine[];
  readonly allowedTtsEngines: readonly TtsEngineKind[];
  readonly recommendedLocalAsr: "sensevoice-wasm" | null;
  readonly recommendedLocalTts: "vits-wasm" | null;
  readonly defaultDaemonUrl: string | null;
  readonly externalModelCacheDir: string;
  readonly restrictionReason: string | null;
}

/**
 * External cache directories outside the user's vault so large speech models
 * never pollute Obsidian Sync or exceed per-vault storage limits.
 */
export const EXTERNAL_MODEL_CACHE_PATHS: Readonly<Record<DesktopOsHint, string>> = {
  macos: "~/.cache/voice-mode/models/",
  linux: "$XDG_CACHE_HOME/voice-mode/models/ (fallback: ~/.cache/voice-mode/models/)",
  windows: "%LOCALAPPDATA%\\voice-mode\\models\\",
};

export const DEFAULT_LOCAL_DAEMON_URL = "http://127.0.0.1:18790";

export const MOBILE_WASM_RESTRICTION_REASON =
  "Local 200 MB+ WASM speech models are disabled on mobile devices to stay below iOS Jetsam (~500 MB) and Android WebView memory ceilings. Use system speech or an optional BYOK endpoint instead.";

/**
 * Describe the recommended external (out-of-vault) model cache location for a desktop OS.
 */
export function describeExternalModelCacheDir(osHint?: DesktopOsHint): string {
  if (osHint && osHint in EXTERNAL_MODEL_CACHE_PATHS) {
    return EXTERNAL_MODEL_CACHE_PATHS[osHint];
  }
  return EXTERNAL_MODEL_CACHE_PATHS.macos;
}

/**
 * Compute runtime speech capabilities for the current Obsidian host.
 * Mobile hosts hard-disable heavy local WASM models and local daemon links,
 * falling back cleanly to system speech or optional BYOK cloud endpoints.
 */
export function detectRuntimeCapabilities(
  isMobile: boolean,
  osHint?: DesktopOsHint,
): RuntimeCapabilities {
  if (isMobile) {
    return {
      hostClass: "mobile",
      isMobile: true,
      allowLocalWasmModels: false,
      allowLocalDaemon: false,
      maxConcurrentLocalModels: 0,
      maxLocalModelMemoryMb: 0,
      defaultAsrEngine: "system",
      defaultTtsEngine: "system",
      allowedAsrEngines: ["system", "openai-compat"],
      allowedTtsEngines: ["system", "openai-compat", "mimo"],
      recommendedLocalAsr: null,
      recommendedLocalTts: null,
      defaultDaemonUrl: null,
      externalModelCacheDir: "Disabled on mobile (no local WASM models downloaded)",
      restrictionReason: MOBILE_WASM_RESTRICTION_REASON,
    };
  }

  return {
    hostClass: "desktop",
    isMobile: false,
    allowLocalWasmModels: true,
    allowLocalDaemon: true,
    maxConcurrentLocalModels: 1,
    maxLocalModelMemoryMb: 700,
    defaultAsrEngine: "system",
    defaultTtsEngine: "system",
    allowedAsrEngines: ["system", "sensevoice-wasm", "zipformer-wasm", "openai-compat", "daemon"],
    allowedTtsEngines: ["system", "vits-wasm", "kokoro-daemon", "openai-compat", "mimo"],
    recommendedLocalAsr: "sensevoice-wasm",
    recommendedLocalTts: "vits-wasm",
    defaultDaemonUrl: DEFAULT_LOCAL_DAEMON_URL,
    externalModelCacheDir: describeExternalModelCacheDir(osHint),
    restrictionReason: null,
  };
}

/**
 * Return true when an explicit transcription endpoint URL targets a local loopback HTTP server
 * (`127.0.0.1`, `localhost`, `[::1]`) so mobile privacy guards permit local loopback ASR.
 */
export function isLoopbackAsrEndpoint(asrEndpointUrl?: string): boolean {
  if (!asrEndpointUrl || !asrEndpointUrl.trim()) {
    return false;
  }
  try {
    return resolveTranscriptionsEndpointUrl(asrEndpointUrl).isLoopbackHttp;
  } catch {
    return false;
  }
}

/**
 * Guard any persisted ASR engine selection against the current runtime's capabilities.
 * Prevents a desktop-synced local WASM / daemon selection from crashing mobile hosts.
 */
export function resolveEffectiveAsrEngine(
  requested: ObsidianAsrEngine,
  capabilities: RuntimeCapabilities,
  allowCloudFallbackOnMobile = true,
  asrEndpointUrl?: string,
): ObsidianAsrEngine {
  if (!capabilities.allowedAsrEngines.includes(requested)) {
    return capabilities.defaultAsrEngine;
  }
  if (
    capabilities.isMobile &&
    !allowCloudFallbackOnMobile &&
    requested !== "system" &&
    isCloudAsrEngine(requested) &&
    !(requested === "openai-compat" && isLoopbackAsrEndpoint(asrEndpointUrl))
  ) {
    return capabilities.defaultAsrEngine;
  }
  return requested;
}

/**
 * Guard any persisted TTS engine selection against the current runtime's capabilities
 * and mobile cloud-fallback privacy preference.
 */
export function resolveEffectiveTtsEngine(
  requested: TtsEngineKind,
  capabilities: RuntimeCapabilities,
  allowCloudFallbackOnMobile = true,
): TtsEngineKind {
  if (!capabilities.allowedTtsEngines.includes(requested)) {
    return capabilities.defaultTtsEngine;
  }
  if (capabilities.isMobile && !allowCloudFallbackOnMobile && isCloudTtsEngine(requested)) {
    return capabilities.defaultTtsEngine;
  }
  return requested;
}
