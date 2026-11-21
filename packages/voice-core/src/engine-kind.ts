/**
 * Single source of truth for ASR engines, TTS engines, and BYOK LLM preset identifiers.
 */

export const ASR_ENGINE_KINDS = [
  'sensevoice-wasm',
  'zipformer-wasm',
  'openai-compat',
  'daemon',
] as const

export type AsrEngineKind = (typeof ASR_ENGINE_KINDS)[number]

export const LOCAL_ASR_ENGINE_KINDS = ['sensevoice-wasm', 'zipformer-wasm', 'daemon'] as const
export const CLOUD_ASR_ENGINE_KINDS = ['openai-compat'] as const

export function asAsrEngineKind(value: unknown): AsrEngineKind {
  return (ASR_ENGINE_KINDS as readonly unknown[]).includes(value)
    ? (value as AsrEngineKind)
    : 'sensevoice-wasm'
}

export function isLocalAsrEngine(value: unknown): boolean {
  return (LOCAL_ASR_ENGINE_KINDS as readonly unknown[]).includes(value)
}

export function isCloudAsrEngine(value: unknown): boolean {
  return (CLOUD_ASR_ENGINE_KINDS as readonly unknown[]).includes(value)
}

export const TTS_ENGINE_KINDS = [
  'system',
  'vits-wasm',
  'kokoro-daemon',
  'openai-compat',
  'mimo',
] as const

export type TtsEngineKind = (typeof TTS_ENGINE_KINDS)[number]

export const LOCAL_TTS_ENGINE_KINDS = ['system', 'vits-wasm', 'kokoro-daemon'] as const
export const CLOUD_TTS_ENGINE_KINDS = ['openai-compat', 'mimo'] as const

export function asTtsEngineKind(value: unknown): TtsEngineKind {
  return (TTS_ENGINE_KINDS as readonly unknown[]).includes(value)
    ? (value as TtsEngineKind)
    : 'system'
}

export function isLocalTtsEngine(value: unknown): boolean {
  return (LOCAL_TTS_ENGINE_KINDS as readonly unknown[]).includes(value)
}

export function isCloudTtsEngine(value: unknown): boolean {
  return (CLOUD_TTS_ENGINE_KINDS as readonly unknown[]).includes(value)
}

export function isThirdPartyTtsEngine(value: unknown): boolean {
  return value === 'openai-compat' || value === 'mimo'
}

/** Whether voice previews should use a bilingual sample phrase. */
export function usesBilingualSample(value: unknown): boolean {
  return value === 'kokoro-daemon' || value === 'openai-compat' || value === 'mimo'
}

export const LLM_PRESET_IDS = [
  'deepseek',
  'dashscope-qwen',
  'volcengine-doubao',
  'moonshot-kimi',
  'siliconflow',
  'openrouter',
  'openai',
  'anthropic',
  'ollama',
  'lmstudio',
  'custom',
] as const

export type LlmPresetId = (typeof LLM_PRESET_IDS)[number]

export function asLlmPresetId(value: unknown): LlmPresetId {
  return (LLM_PRESET_IDS as readonly unknown[]).includes(value)
    ? (value as LlmPresetId)
    : 'deepseek'
}
