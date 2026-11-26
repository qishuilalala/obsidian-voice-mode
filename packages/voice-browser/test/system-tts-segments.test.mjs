import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemTtsSegments, SystemTtsEngine, SYSTEM_TTS_MIME } from '../src/index.ts'

describe('system TTS segments: slow/fast rate mapping (E2/E4)', () => {
  it('maps <slow> and <fast> scopes to per-segment rateScale', () => {
    const segments = buildSystemTtsSegments(
      '<slow>slow part</slow> normal <fast>quick part</fast>',
      [
        { text: 'slow part', whisper: false, slow: true },
        { text: 'normal', whisper: false },
        { text: 'quick part', whisper: false, fast: true },
      ],
    )
    assert.equal(segments.length, 3)
    assert.equal(segments[0].rateScale, 0.85)
    assert.equal(segments[1].rateScale, 1)
    assert.equal(segments[2].rateScale, 1.15)
  })

  it('keeps whisper and break metadata intact', () => {
    const segments = buildSystemTtsSegments('<break 300ms><whisper>hush</whisper>', [
      { text: 'hush', whisper: true, preBreakMs: 300 },
    ])
    assert.equal(segments[0].whisper, true)
    assert.equal(segments[0].preBreakMs, 300)
    assert.equal(segments[0].rateScale, 1)
  })

  it('serializes rateScale into the system TTS payload', async () => {
    const engine = new SystemTtsEngine()
    const result = await engine.synthesize('<slow>hello</slow>', {
      rate: 1,
      segments: [{ text: 'hello', whisper: false, preBreakMs: 0, breakAfterMs: 0, rateScale: 0.85 }],
    })
    assert.equal(result.mime, SYSTEM_TTS_MIME)
    const payload = JSON.parse(new TextDecoder().decode(result.audio))
    assert.equal(payload.segments[0].rateScale, 0.85)
  })
})
