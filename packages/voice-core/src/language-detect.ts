/**
 * Text language detection (P2-1 multi-language groundwork).
 *
 * Heuristic, zero-dependency, browser-safe: distinguishes Japanese (kana) and
 * Korean (Hangul) from general CJK, classifies Latin text as English, and
 * returns "mixed" when significantly different script families are present.
 * Not a full language classifier — hosts use it for TTS voice/locale hints.
 */

export type DetectedLanguage = 'zh' | 'ja' | 'ko' | 'en' | 'mixed' | 'unknown'

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff]/
const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/
const LATIN = /[A-Za-z\u00c0-\u024f]/
const NON_LATIN_NON_CJK = /[\u0400-\u04ff\u0600-\u06ff\u0e00-\u0e7f]/ // Cyrillic/Arabic/Thai

/** Rough script weights for a single string (counts ideographs vs letters). */
function scriptCounts(text: string): { han: number; kana: number; hangul: number; latin: number } {
  let han = 0
  let kana = 0
  let hangul = 0
  let latin = 0
  for (const ch of text) {
    if (KANA.test(ch)) kana += 1
    else if (HANGUL.test(ch)) hangul += 1
    else if (HAN.test(ch)) han += 1
    else if (LATIN.test(ch)) latin += 1
  }
  return { han, kana, hangul, latin }
}

/** Dominant language of a text, or "mixed" when Latin and CJK are both substantial. */
export function detectTextLanguage(text: string): DetectedLanguage {
  const source = String(text ?? '')
  if (!source.trim()) return 'unknown'
  if (NON_LATIN_NON_CJK.test(source)) return 'unknown'

  const { han, kana, hangul, latin } = scriptCounts(source)
  const cjk = han + kana + hangul
  if (cjk === 0) return latin > 0 ? 'en' : 'unknown'

  // Japanese uses kana alongside kanji; Korean uses Hangul (often with Hanja).
  const script = kana > 0 || hangul > 0 ? (hangul > kana ? 'ko' : 'ja') : 'zh'
  // Mixed: both Latin words and CJK characters are present in non-trivial amounts.
  if (latin >= 6 && cjk >= 3 && latin / (cjk + latin) >= 0.25) {
    return 'mixed'
  }
  return script
}

/** Languages actually present (deduped, dominant first); useful for voice mapping. */
export function detectPresentLanguages(text: string): DetectedLanguage[] {
  const { han, kana, hangul, latin } = scriptCounts(String(text ?? ''))
  const present: DetectedLanguage[] = []
  if (kana > 0) present.push('ja')
  else if (han > 0) present.push('zh')
  if (hangul > 0) present.push('ko')
  if (latin > 0 && han + kana + hangul === 0) present.push('en')
  return present.length > 0 ? present : ['unknown']
}
