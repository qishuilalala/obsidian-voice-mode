import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPRESSION_FACETS,
  EXPRESSION_CAPS,
  TTS_ENGINE_KINDS,
  getExpressionCaps,
  supportsFacet,
  unsupportedFacets,
  analyzeExpression,
  selectableFacets,
  coveredEngineKinds,
} from '../src/index.ts'

describe('expression caps: contract coverage and honesty', () => {
  it('covers every TTS engine kind exactly once', () => {
    assert.deepEqual([...coveredEngineKinds()].sort(), [...TTS_ENGINE_KINDS].sort())
    for (const engine of TTS_ENGINE_KINDS) {
      assert.equal(EXPRESSION_CAPS[engine].engine, engine)
      assert.ok(Array.isArray(EXPRESSION_CAPS[engine].supported))
    }
  })

  it('only lists known facets in the capability table', () => {
    const known = new Set(EXPRESSION_FACETS)
    for (const engine of TTS_ENGINE_KINDS) {
      for (const facet of EXPRESSION_CAPS[engine].supported) {
        assert.ok(known.has(facet), `unknown facet ${facet} on ${engine}`)
      }
    }
  })

  it('never claims emotion or whisper support for the system engine', () => {
    assert.equal(supportsFacet('system', 'emotion'), false)
    assert.equal(supportsFacet('system', 'whisper'), false)
    assert.equal(supportsFacet('system', 'rate'), true)
    assert.equal(getExpressionCaps('system').emotion, 'none')
  })

  it('gives kokoro-daemon native pause/whisper support with a bounded break', () => {
    const caps = getExpressionCaps('kokoro-daemon')
    assert.equal(caps.voiceCount, 103)
    assert.ok(caps.supported.includes('pause'))
    assert.ok(caps.supported.includes('whisper'))
    assert.equal(caps.maxPauseMs, 5000)
  })

  it('marks instruction-based engines as emotion: instructions', () => {
    assert.equal(getExpressionCaps('openai-compat').emotion, 'instructions')
    assert.equal(getExpressionCaps('mimo').emotion, 'instructions')
    assert.ok(getExpressionCaps('mimo').supported.includes('emotion'))
  })
})

describe('expression caps: degradation analysis', () => {
  it('reports requested facets the engine cannot render', () => {
    const missing = unsupportedFacets('vits-wasm', ['voices', 'whisper', 'emotion'])
    assert.deepEqual(missing, ['whisper', 'emotion'])
  })

  it('degrades emotion to plain text on non-emotion engines and marks others not-applied', () => {
    const { supported, degraded } = analyzeExpression('system', ['rate', 'emotion', 'whisper', 'pause'])
    assert.deepEqual(supported, ['rate', 'pause'])
    assert.deepEqual(
      degraded.map((d) => [d.facet, d.behavior]),
      [
        ['emotion', 'plain-text'],
        ['whisper', 'not-applied'],
      ],
    )
  })

  it('leaves fully supported requests with no degradation', () => {
    const { supported, degraded } = analyzeExpression('kokoro-daemon', ['voices', 'rate', 'pause', 'whisper'])
    assert.equal(degraded.length, 0)
    assert.deepEqual(supported, ['voices', 'rate', 'pause', 'whisper'])
  })

  it('falls back to system caps for unknown engine values', () => {
    assert.equal(getExpressionCaps('not-an-engine').engine, 'system')
    assert.deepEqual(selectableFacets('not-an-engine'), ['voices', 'rate', 'pause'])
  })
})
