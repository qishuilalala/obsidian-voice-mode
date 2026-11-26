import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripEmotionTags,
  parseEmotionTags,
  compileEmotionPlan,
  buildEmotionPromptInstruction,
  EMOTION_NAMES,
} from '../src/index.ts'

describe('emotion tags v2: scoped prosody and emotion', () => {
  it('parses <slow>/<fast> scopes per segment', () => {
    const segments = parseEmotionTags('<slow>slow words</slow> normal <fast>quick</fast>')
    assert.equal(segments.length, 3)
    assert.equal(segments[0].slow, true)
    assert.equal(segments[1].slow, undefined)
    assert.equal(segments[2].fast, true)
  })

  it('parses <emotion:name> and rejects unknown names', () => {
    const ok = parseEmotionTags('<emotion:gentle>soft</emotion>')
    assert.equal(ok[0].emotion, 'gentle')
    const bad = parseEmotionTags('<emotion:unknown>plain</emotion>')
    assert.equal(bad[0].emotion, undefined)
  })

  it('clamps <volume> and <pitch> values', () => {
    const loud = parseEmotionTags('<volume 9>loud</volume>')
    assert.equal(loud[0].volume, 2)
    const high = parseEmotionTags('<pitch -20>low</pitch>')
    assert.equal(high[0].pitch, -12)
  })

  it('parses <spell> scopes', () => {
    const segments = parseEmotionTags('<spell>A B C</spell> done')
    assert.equal(segments[0].spell, true)
    assert.equal(segments[1].spell, undefined)
  })

  it('downgrades unbalanced scopes instead of leaking flags', () => {
    const segments = parseEmotionTags('<slow>unclosed text')
    assert.equal(segments[0].slow, undefined)
    const emotion = parseEmotionTags('<emotion:gentle>unclosed')
    assert.equal(emotion[0].emotion, undefined)
  })

  it('strips every new tag from spoken text', () => {
    const raw = '<slow>a</slow><fast>b</fast><spell>c</spell><volume 0.5>d</volume><pitch 2>e</pitch><emotion:gentle>f</emotion>'
    const stripped = stripEmotionTags(raw)
    assert.equal(stripped.replace(/\s+/g, ' ').trim(), 'a b c d e f')
    for (const tag of ['<slow>', '<fast>', '<spell>', '<volume', '<pitch', '<emotion']) {
      assert.ok(!stripped.includes(tag), `leaked tag ${tag}`)
    }
  })

  it('turns scopes into instructions-mode hints', () => {
    const plan = compileEmotionPlan(
      '<slow>slow</slow> <emotion:gentle>soft</emotion> <giggles>',
      'instructions',
    )
    assert.match(plan.instructions, /slow the delivery/i)
    assert.match(plan.instructions, /convey the marked emotion \(gentle\)/i)
    assert.ok(plan.plainText.includes('slow'))
  })

  it('keeps the LLM prompt instruction and emotion names in sync', () => {
    const prompt = buildEmotionPromptInstruction()
    assert.match(prompt, /<emotion:gentle>/)
    assert.ok(EMOTION_NAMES.includes('gentle'))
  })
})
