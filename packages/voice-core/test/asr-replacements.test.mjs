import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  REPLACEMENTS_MAX_PAYLOAD_BYTES,
  replacementsPayloadBytes,
  validateReplacements,
  createAsrReplacer,
  filterReplacementsByLanguage,
} from '../src/index.ts'

describe('asr-replacements', () => {
  it('keeps optional language scopes and filters rules by language family', () => {
    const check = validateReplacements([
      { from: ['API'], to: 'A P I', language: 'en' },
      { from: ['光四点'], to: '光4点' },
      { from: ['てすと'], to: 'テスト', language: 'ja' },
    ])
    assert.equal(check.ok, true)
    assert.equal(check.rules.length, 3)
    assert.equal(check.rules[0].language, 'en')
    assert.equal(check.rules[1].language, undefined)

    const en = filterReplacementsByLanguage(check.rules, 'en-US')
    assert.equal(en.length, 2, 'global + en rules apply to English sentences')
    const zh = filterReplacementsByLanguage(check.rules, 'zh-CN')
    assert.equal(zh.length, 1, 'only the global rule applies to Chinese sentences')
    assert.equal(filterReplacementsByLanguage(check.rules, undefined).length, 1)

    const bad = validateReplacements([{ from: ['x'], to: 'y', language: 'fr' }])
    assert.equal(bad.ok, false)
    assert.match(bad.error, /language must be one of zh\/en\/ja\/ko/)
  })

  it('validates rule schema and enforces UTF-8 byte payload cap on multibyte CJK rules', () => {
    assert.equal(REPLACEMENTS_MAX_PAYLOAD_BYTES, 12000)
    assert.equal(validateReplacements('not-an-array').ok, false)
    assert.equal(validateReplacements([{ from: [], to: 'Obsidian' }]).ok, false)
    assert.equal(validateReplacements([{ from: ['ok'], to: '   ' }]).ok, false)

    const valid = validateReplacements([{ from: ['黑曜石', 'obsidion'], to: 'Obsidian' }])
    assert.equal(valid.ok, true)
    if (valid.ok) {
      assert.equal(valid.rules.length, 1)
      assert.equal(valid.bytes, replacementsPayloadBytes(valid.rules))
    }

    const cjkWord = '测试中文词汇替换规则条目'
    const huge = Array.from({ length: 180 }, (_, i) => ({
      from: [`${cjkWord}${i}`],
      to: `目标词${i}`,
    }))
    const charLen = JSON.stringify(huge).length
    const byteLen = replacementsPayloadBytes(huge)
    assert.ok(charLen < REPLACEMENTS_MAX_PAYLOAD_BYTES)
    assert.ok(byteLen > REPLACEMENTS_MAX_PAYLOAD_BYTES)

    const over = validateReplacements(huge)
    assert.equal(over.ok, false)
    if (!over.ok) {
      assert.equal(over.bytes, byteLen)
    }
  })

  it('handles case-insensitivity, CJK/Latin whitespace, ASCII word bounds without lookbehind, overlapping rules, single-pass, and onHit', () => {
    const hits = []
    const replace = createAsrReplacer(
      [
        { from: ['sina'], to: 'Sina' },
        { from: ['ski 男', 'sakeena'], to: 'Sakina' },
        { from: ['open ai', 'open'], to: 'OpenAI' },
        { from: ['OpenAI'], to: 'SHOULD_NOT_CHAIN' },
        { from: ['a男'], to: 'A男' },
        { from: ['男'], to: 'MAN' },
      ],
      (idx) => hits.push(idx),
    )

    // Whole-word ASCII boundaries (both left and right)
    assert.equal(replace('Frank Sinatra visits asina and sina today'), 'Frank Sinatra visits asina and Sina today')

    // Overlapping rules when longer ASCII-left-bounded rule fails left boundary: shorter CJK rule still matches!
    assert.equal(replace('xa男'), 'xaMAN')
    assert.equal(replace(' a男'), ' A男')

    // CJK/Latin whitespace insensitivity
    assert.equal(replace('我认识 ski男 和 SKI  男 以及 Sakeena'), '我认识 Sakina 和 Sakina 以及 Sakina')

    // Longest-match first + single-pass (no cascading into rule 3)
    assert.equal(replace('use open ai now'), 'use OpenAI now')

    // Hit counter verification + opt-out via countHit=false
    const before = hits.length
    assert.equal(replace('sina', false), 'Sina')
    assert.equal(hits.length, before)
    assert.equal(replace('sina', true), 'Sina')
    assert.equal(hits.length, before + 1)
    assert.equal(hits.at(-1), 0)
  })
})
