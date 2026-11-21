import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEmotionTags,
  stripEmotionTags,
  redactSecrets,
  redactBodySnippet,
} from '../src/index.ts'

describe('emotion tag DSL', () => {
  it('parses balanced whisper, inline tags without word gluing, and capped breaks', () => {
    const segs = parseEmotionTags(
      'hello<laugh>world <break 300ms> <whisper>低声说</whisper> <break 9000ms> 结束',
    )
    assert.equal(segs.length, 3)
    assert.deepEqual(segs[0], { text: 'hello world', whisper: false, preBreakMs: 300 })
    assert.deepEqual(segs[1], { text: '低声说', whisper: true, preBreakMs: 5000 })
    assert.deepEqual(segs[2], { text: '结束', whisper: false })
  })

  it('attaches leading <break> to out[0] in multi-segment text and avoids gluing words on <break 0ms>', () => {
    const leading = parseEmotionTags('<break 500ms>第一段<whisper>第二段</whisper>')
    assert.equal(leading.length, 2)
    assert.deepEqual(leading[0], { text: '第一段', whisper: false, preBreakMs: 500 })
    assert.deepEqual(leading[1], { text: '第二段', whisper: true })

    const zeroBreak = parseEmotionTags('hello<break 0ms>world')
    assert.deepEqual(zeroBreak, [{ text: 'hello world', whisper: false }])
  })

  it('enforces total 10s break budget and conservatively downgrades unbalanced whisper', () => {
    const budget = parseEmotionTags('A<break 5000ms>B<break 5000ms>C<break 3000ms>D')
    assert.equal(budget.length, 4)
    assert.equal(budget[0].preBreakMs, 5000)
    assert.equal(budget[1].preBreakMs, 5000)
    assert.equal(budget[2].preBreakMs, undefined)

    const unbalanced = parseEmotionTags('正常 <whisper>没有关闭')
    assert.equal(unbalanced.every((s) => s.whisper === false), true)

    assert.equal(stripEmotionTags('a<sigh>b<emphasis>c').replace(/\s+/g, ' ').trim(), 'a b c')
  })
})

describe('secret redaction', () => {
  it('masks provider keys, headers, embedded URL creds, JSON fields, and 32-hex keys while preserving SHA256 and model slugs', () => {
    const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    const sample = [
      'Authorization: Bearer tok_1234567890abcdef',
      'x-api-key: mysecretvalue1234',
      'https://alice:topsecret@api.example.com/v1?api_key=abc123456',
      '{"apiKey":"sk-ant-api03-secretvalue123456"}',
      'key1=sk-proj-abc1234567890 key2=gsk_1234567890abcdef key3=AIzaSyA123456789012',
      'key4=rk_live_1234567890abcdef key5=ghp_1234567890abcdefghij',
      'md5=0123456789abcdef0123456789abcdef',
      `model=openai/gpt-4o-mini-tts-2025-12-15 sha256=${sha256}`,
    ].join(' | ')

    const redacted = redactSecrets(sample)
    assert.ok(!redacted.includes('tok_1234567890abcdef'))
    assert.ok(!redacted.includes('mysecretvalue1234'))
    assert.ok(!redacted.includes('alice:topsecret'))
    assert.ok(!redacted.includes('abc123456'))
    assert.ok(!redacted.includes('sk-ant-api03-secretvalue123456'))
    assert.ok(!redacted.includes('sk-proj-abc1234567890'))
    assert.ok(!redacted.includes('gsk_1234567890abcdef'))
    assert.ok(!redacted.includes('AIzaSyA123456789012'))
    assert.ok(!redacted.includes('rk_live_1234567890abcdef'))
    assert.ok(!redacted.includes('ghp_1234567890abcdefghij'))
    assert.ok(!redacted.includes('0123456789abcdef0123456789abcdef'))
    assert.ok(redacted.includes('openai/gpt-4o-mini-tts-2025-12-15'))
    assert.ok(redacted.includes(sha256))
  })

  it('redacts BEFORE truncating, including long unclosed JSON secret values crossing 328+ char boundaries', () => {
    const prefix = 'x'.repeat(190)
    const boundarySecret = 'sk-live-SUPERSECRETKEY9876543210'
    const snippet = redactBodySnippet(`${prefix} ${boundarySecret} tail`, 200)
    assert.ok(!snippet.includes('SUPERSECRET'))
    assert.ok(!snippet.includes('sk-live-'))

    // Long JSON secret crossing 328-char & 2048-char boundary without a closing quote inside pre-window
    const longValue = 'secretpayload'.repeat(300)
    const jsonPayload = `${'a'.repeat(150)}{"apiKey":"${longValue}"}`
    const redactedJson = redactBodySnippet(jsonPayload, 200)
    assert.ok(!redactedJson.includes('secretpayload'))
    assert.ok(redactedJson.includes('"apiKey":"<redacted>'))
  })
})
