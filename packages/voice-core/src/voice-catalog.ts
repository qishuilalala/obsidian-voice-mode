/**
 * Shared voice catalog and TTS endpoint preset definitions (data only, zero secrets).
 */

export type Gender = 'F' | 'M'

export interface BiName {
  zh: string
  en: string
}

// ── MiMo TTS ─────────────────────────────────────────────────────────────────

export const MIMO_DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
export const MIMO_DEFAULT_MODEL = 'mimo-v2.5-tts'
export const MIMO_DEFAULT_VOICE = 'mimo_default'

export const MIMO_VOICES: ReadonlyArray<string> = [
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean',
]

// ── Local VITS (vits-zh-ll, 5 speakers) ──────────────────────────────────────

export interface VitsSpeaker extends BiName {
  name: string
  sid: number
  gender: Gender
}

export const VITS_SPEAKERS: ReadonlyArray<VitsSpeaker> = [
  { name: 'suyingxue', sid: 0, zh: '素映雪', en: 'Su Yingxue', gender: 'F' },
  { name: 'gunian', sid: 1, zh: '顾念', en: 'Gu Nian', gender: 'M' },
  { name: 'fushiyu', sid: 2, zh: '傅斯遇', en: 'Fu Siyu', gender: 'F' },
  { name: 'bingjiao', sid: 3, zh: '冰娇', en: 'Bing Jiao', gender: 'M' },
  { name: 'bazong', sid: 4, zh: '霸总', en: 'Ba Zong', gender: 'M' },
]

export function findVitsSpeaker(voice: string): VitsSpeaker | undefined {
  const key = voice.trim().toLowerCase()
  return VITS_SPEAKERS.find((s) => s.name === key || String(s.sid) === key)
}

// ── Local Kokoro (sid 0-102, 103 speakers from csukuangfj/kokoro-int8-multi-lang-v1_1) ──

/** Authoritative 103 speaker IDs (`sid = 0..102`) embedded in Kokoro v1.1-zh ONNX metadata. */
export const KOKORO_SPEAKERS_103: ReadonlyArray<string> = [
  'af_maple', 'af_sol', 'bf_vale', 'zf_001', 'zf_002', 'zf_003', 'zf_004', 'zf_005', 'zf_006', 'zf_007',
  'zf_008', 'zf_017', 'zf_018', 'zf_019', 'zf_021', 'zf_022', 'zf_023', 'zf_024', 'zf_026', 'zf_027',
  'zf_028', 'zf_032', 'zf_036', 'zf_038', 'zf_039', 'zf_040', 'zf_042', 'zf_043', 'zf_044', 'zf_046',
  'zf_047', 'zf_048', 'zf_049', 'zf_051', 'zf_059', 'zf_060', 'zf_067', 'zf_070', 'zf_071', 'zf_072',
  'zf_073', 'zf_074', 'zf_075', 'zf_076', 'zf_077', 'zf_078', 'zf_079', 'zf_083', 'zf_084', 'zf_085',
  'zf_086', 'zf_087', 'zf_088', 'zf_090', 'zf_092', 'zf_093', 'zf_094', 'zf_099', 'zm_009', 'zm_010',
  'zm_011', 'zm_012', 'zm_013', 'zm_014', 'zm_015', 'zm_016', 'zm_020', 'zm_025', 'zm_029', 'zm_030',
  'zm_031', 'zm_033', 'zm_034', 'zm_035', 'zm_037', 'zm_041', 'zm_045', 'zm_050', 'zm_052', 'zm_053',
  'zm_054', 'zm_055', 'zm_056', 'zm_057', 'zm_058', 'zm_061', 'zm_062', 'zm_063', 'zm_064', 'zm_065',
  'zm_066', 'zm_068', 'zm_069', 'zm_080', 'zm_081', 'zm_082', 'zm_089', 'zm_091', 'zm_095', 'zm_096',
  'zm_097', 'zm_098', 'zm_100',
]

export const KOKORO_F0: ReadonlyArray<number | null> = [
  224, 189, 154, 261, 226, 222, 220, 229, 198, 186, 212, 293, 233, 161, 247, 207, 218, 216, 220, 238,
  242, 229, 198, 286, 211, 190, 264, 261, 226, 147, 216, 240, 233, 188, 222, 247, 253, 270, 276, 276,
  279, 320, 247, 296, 276, 235, 139, 240, 282, 282, 238, 226, 273, 216, 286, 270, 198, 179, 117, 130,
  114, 128, 108, 106, 122, 136, 190, 112, 108, 128, 131, 111, 110, 132, 138, 189, 137, 148, 151, 127,
  135, 111, 138, 114, 125, 158, 128, 156, 132, 162, 131, 136, 142, 124, 129, 136, 126, 135, 161, 150,
  124, 104, 124,
]

export const KOKORO_NAMED: Readonly<Record<number, { name: string } & BiName>> = {
  48: { name: 'zf_xiaobei', zh: '小北', en: 'Xiaobei' },
  49: { name: 'zf_xiaoni', zh: '小妮', en: 'Xiaoni' },
  50: { name: 'zf_xiaoxiao', zh: '小小', en: 'Xiaoxiao' },
  51: { name: 'zf_xiaoyi', zh: '小艺', en: 'Xiaoyi' },
}

export type KokoroStyle = 'deep' | 'rich' | 'clear' | 'magnetic'

export const KOKORO_POPULAR_MALE: Readonly<Record<number, KokoroStyle>> = {
  62: 'deep',
  68: 'rich',
  75: 'clear',
  76: 'magnetic',
}

export const KOKORO_PINNED: ReadonlyArray<number> = [62, 68, 75, 76]

export const KOKORO_VOICES: ReadonlyArray<{ name: string; sid: number }> = [
  ...KOKORO_PINNED.map((sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })),
  ...KOKORO_F0.map((_, sid) => ({ name: KOKORO_NAMED[sid]?.name ?? String(sid), sid })).filter(
    (v) => !KOKORO_PINNED.includes(v.sid),
  ),
]

export function findKokoroVoice(voice: string): { name: string; sid: number } | undefined {
  const key = voice.trim().toLowerCase()
  const hit = KOKORO_VOICES.find((v) => v.name.toLowerCase() === key || String(v.sid) === key)
  if (hit) return hit
  const modelSid = KOKORO_SPEAKERS_103.findIndex((id) => id.toLowerCase() === key)
  return modelSid >= 0 ? { name: KOKORO_SPEAKERS_103[modelSid], sid: modelSid } : undefined
}

// ── OpenAI-compatible remote & self-hosted TTS presets ───────────────────────

export interface TtsOpenAiPreset {
  id: string
  label: string
  region: 'cn' | 'global' | 'local'
  baseUrl: string
  model: string
  voice: string
  voices: ReadonlyArray<string>
  requiresKey: boolean
}

const SILICONFLOW_SYSTEM_VOICES = [
  'alex',
  'benjamin',
  'charles',
  'david',
  'anna',
  'bella',
  'claire',
  'diana',
] as const

const OPENAI_API_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'marin',
  'cedar',
  'nova',
  'onyx',
  'sage',
  'shimmer',
] as const

export const TTS_OPENAI_PRESETS: Readonly<Record<string, TtsOpenAiPreset>> = {
  'siliconflow-cosyvoice2': {
    id: 'siliconflow-cosyvoice2',
    label: 'SiliconFlow · CosyVoice2',
    region: 'cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    voices: SILICONFLOW_SYSTEM_VOICES.map((v) => `FunAudioLLM/CosyVoice2-0.5B:${v}`),
    requiresKey: true,
  },
  'siliconflow-fish': {
    id: 'siliconflow-fish',
    label: 'SiliconFlow · Fish Speech 1.5',
    region: 'cn',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'fishaudio/fish-speech-1.5',
    voice: 'fishaudio/fish-speech-1.5:anna',
    voices: SILICONFLOW_SYSTEM_VOICES.map((v) => `fishaudio/fish-speech-1.5:${v}`),
    requiresKey: true,
  },
  'openrouter-openai': {
    id: 'openrouter-openai',
    label: 'OpenRouter · GPT-4o Mini TTS',
    region: 'global',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini-tts-2025-12-15',
    voice: 'alloy',
    voices: [...OPENAI_API_VOICES],
    requiresKey: true,
  },
  'openai-official': {
    id: 'openai-official',
    label: 'OpenAI · GPT-4o Mini TTS',
    region: 'global',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'marin',
    voices: [...OPENAI_API_VOICES],
    requiresKey: true,
  },
  'groq-playai': {
    id: 'groq-playai',
    label: 'Groq · PlayAI TTS',
    region: 'global',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'playai-tts',
    voice: 'Fritz-PlayAI',
    voices: ['Fritz-PlayAI'],
    requiresKey: true,
  },
  'selfhosted-kokoro': {
    id: 'selfhosted-kokoro',
    label: 'Self-hosted · Kokoro-FastAPI',
    region: 'local',
    baseUrl: 'http://127.0.0.1:8880/v1',
    model: 'kokoro',
    voice: 'zf_xiaobei',
    voices: ['zf_xiaobei', 'zf_xiaoni', 'zf_xiaoxiao', 'zf_xiaoyi'],
    requiresKey: false,
  },
  'selfhosted-vllm': {
    id: 'selfhosted-vllm',
    label: 'Self-hosted · vLLM-Omni',
    region: 'local',
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'tts-1',
    voice: 'default',
    voices: ['default'],
    requiresKey: false,
  },
}

export function resolveTtsOpenAiPreset(presetId: string): TtsOpenAiPreset | null {
  return Object.hasOwn(TTS_OPENAI_PRESETS, presetId) ? TTS_OPENAI_PRESETS[presetId] : null
}

export function ttsPresetRequiresKey(presetId: string | null | undefined): boolean {
  if (!presetId) return false
  const preset = resolveTtsOpenAiPreset(presetId)
  return preset ? preset.requiresKey : false
}

// ── Reference Edge / System Neural Voices (catalog metadata only) ────────────

export type EdgeAccent = 'mandarin' | 'northeast' | 'shaanxi' | 'cantonese' | 'taiwan' | 'english'

export interface EdgeCommonVoice extends BiName {
  v: string
  gender: Gender
  accent: EdgeAccent
}

export const EDGE_COMMON_VOICES: ReadonlyArray<EdgeCommonVoice> = [
  { v: 'zh-CN-XiaoxiaoNeural', zh: '晓晓', en: 'Xiaoxiao', gender: 'F', accent: 'mandarin' },
  { v: 'zh-CN-XiaoyiNeural', zh: '晓伊', en: 'Xiaoyi', gender: 'F', accent: 'mandarin' },
  { v: 'zh-CN-YunxiNeural', zh: '云希', en: 'Yunxi', gender: 'M', accent: 'mandarin' },
  { v: 'zh-CN-YunjianNeural', zh: '云健', en: 'Yunjian', gender: 'M', accent: 'mandarin' },
  { v: 'zh-CN-YunyangNeural', zh: '云扬', en: 'Yunyang', gender: 'M', accent: 'mandarin' },
  { v: 'zh-CN-YunxiaNeural', zh: '云夏', en: 'Yunxia', gender: 'M', accent: 'mandarin' },
  { v: 'zh-CN-liaoning-XiaobeiNeural', zh: '小北', en: 'Xiaobei', gender: 'F', accent: 'northeast' },
  { v: 'zh-CN-shaanxi-XiaoniNeural', zh: '小妮', en: 'Xiaoni', gender: 'F', accent: 'shaanxi' },
  { v: 'zh-HK-HiuMaanNeural', zh: '晓曼', en: 'HiuMaan', gender: 'F', accent: 'cantonese' },
  { v: 'zh-HK-WanLungNeural', zh: '云龙', en: 'WanLung', gender: 'M', accent: 'cantonese' },
  { v: 'zh-TW-HsiaoYuNeural', zh: '小雨', en: 'HsiaoYu', gender: 'F', accent: 'taiwan' },
  { v: 'zh-TW-YunJheNeural', zh: '云哲', en: 'YunJhe', gender: 'M', accent: 'taiwan' },
  { v: 'en-US-AriaNeural', zh: 'Aria', en: 'Aria', gender: 'F', accent: 'english' },
  { v: 'en-US-GuyNeural', zh: 'Guy', en: 'Guy', gender: 'M', accent: 'english' },
]
