import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  MAX_AUDIO_BYTES,
  MAX_MIMO_JSON_BYTES,
  TTS_OPENAI_PRESETS,
  TtsProviderError,
  sniffAudioMime,
  decodeBase64Strict,
  resolveSpeechEndpointUrl,
  resolveOpenAiTtsConfig,
  OpenAiCompatTtsEngine,
  MimoTtsEngine,
  SentenceSegmenter,
} from '../src/index.ts'

const ENC = new TextEncoder()

/** Pure ES2022 Uint8Array -> standard base64 helper for test fixtures. */
function encodeBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  let i = 0
  for (; i + 2 < bytes.byteLength; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out +=
      alphabet[(n >> 18) & 63] +
      alphabet[(n >> 12) & 63] +
      alphabet[(n >> 6) & 63] +
      alphabet[n & 63]
  }
  const rem = bytes.byteLength - i
  if (rem === 1) {
    const n = bytes[i] << 16
    out += `${alphabet[(n >> 18) & 63]}${alphabet[(n >> 12) & 63]}==`
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += `${alphabet[(n >> 18) & 63]}${alphabet[(n >> 12) & 63]}${alphabet[(n >> 6) & 63]}=`
  }
  return out
}

function makeFakeWavBytes() {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x24, 0x00, 0x00, 0x00, // size
    0x57, 0x41, 0x56, 0x45, // WAVE
    0x66, 0x6d, 0x74, 0x20, // fmt
  ])
}

function makeFakeMp3Bytes() {
  return Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
}

describe('tts-engines: zero DOM/Node-global architecture guard', () => {
  it('uses zero Buffer, atob, btoa, window, or document globals in tts-engines.ts', () => {
    const srcPath = fileURLToPath(new URL('../src/tts-engines.ts', import.meta.url))
    const src = readFileSync(srcPath, 'utf8')
    for (const forbidden of ['Buffer', 'atob', 'btoa', 'window', 'document']) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\b`).test(src),
        false,
        `tts-engines.ts must not reference ${forbidden}`,
      )
    }
  })
})

describe('tts-engines: sniffAudioMime', () => {
  it('detects WAV, MP3 (ID3 & MPEG sync), OGG, FLAC, WebM, and MP4 via magic bytes', () => {
    assert.equal(sniffAudioMime(makeFakeWavBytes()), 'audio/wav')
    assert.equal(sniffAudioMime(makeFakeMp3Bytes()), 'audio/mpeg')
    // MPEG-1 Layer III frame sync (0xff 0xfb)
    assert.equal(sniffAudioMime(Uint8Array.from([0xff, 0xfb, 0x90, 0x64])), 'audio/mpeg')
    // Reserved MPEG version (0x08) or reserved layer (0x00) must not match MP3 sync
    assert.equal(sniffAudioMime(Uint8Array.from([0xff, 0xe8, 0x00, 0x00])), null)
    assert.equal(sniffAudioMime(Uint8Array.from([0xff, 0xf8, 0x00, 0x00])), null)
    // RIFF....WEBP is not WAV
    assert.equal(sniffAudioMime(ENC.encode('RIFF\x10\x00\x00\x00WEBP')), null)

    assert.equal(sniffAudioMime(ENC.encode('OggS\x00\x02\x00\x00')), 'audio/ogg')
    assert.equal(sniffAudioMime(ENC.encode('fLaC\x00\x00\x00\x22')), 'audio/flac')
    assert.equal(sniffAudioMime(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f])), 'audio/webm')
    assert.equal(
      sniffAudioMime(Uint8Array.from([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70])),
      'audio/mp4',
    )
  })

  it('rejects disguised HTML, JSON, XML, and empty bodies even with spoofed Content-Type: audio/mpeg', () => {
    assert.equal(sniffAudioMime(new Uint8Array(0), 'audio/mpeg'), null)
    assert.equal(sniffAudioMime(ENC.encode('<!DOCTYPE html><html>Gateway Error</html>'), 'audio/mpeg'), null)
    assert.equal(sniffAudioMime(ENC.encode('   \n\t<html>502 Bad Gateway</html>'), 'audio/mpeg'), null)
    assert.equal(sniffAudioMime(ENC.encode('<?xml version="1.0"?><err/>'), 'audio/wav'), null)
    assert.equal(sniffAudioMime(ENC.encode('{"error":{"message":"quota"}}'), 'audio/mpeg; charset=utf-8'), null)
    assert.equal(sniffAudioMime(ENC.encode('  [{"error":"rate_limit"}]'), 'audio/ogg'), null)

    // Binary headerless payload with valid audio/<subtype> header normalizes cleanly
    assert.equal(
      sniffAudioMime(Uint8Array.from([0x01, 0x02, 0x03, 0x04]), 'Audio/AAC; codecs=mp4a.40.2'),
      'audio/aac',
    )
    assert.equal(
      sniffAudioMime(Uint8Array.from([0x01, 0x02, 0x03, 0x04]), 'application/octet-stream'),
      null,
    )
    assert.equal(sniffAudioMime(Uint8Array.from([0x01, 0x02, 0x03, 0x04]), 'audio/*'), null)
  })
})

describe('tts-engines: decodeBase64Strict', () => {
  it('decodes standard, URL-safe, unpadded, and whitespace-wrapped base64 into Uint8Array', () => {
    const sample = Uint8Array.from([0xfb, 0xff, 0x00, 0x41, 0x7f, 0x80, 0xfe])
    const std = encodeBase64(sample) // "+/8AQX+A/g=="
    assert.ok(std.includes('+') && std.includes('/'))
    assert.deepEqual(decodeBase64Strict(std), sample)

    // URL-safe (- and _) + unpadded
    const urlSafeUnpadded = std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    assert.deepEqual(decodeBase64Strict(urlSafeUnpadded), sample)

    // 1-byte and 2-byte unpadded lengths (len % 4 === 2 and len % 4 === 3)
    assert.deepEqual(decodeBase64Strict('YQ'), ENC.encode('a'))
    assert.deepEqual(decodeBase64Strict('YWI'), ENC.encode('ab'))
    assert.deepEqual(decodeBase64Strict('YWJj'), ENC.encode('abc'))

    // Embedded ASCII whitespace
    const helloB64 = encodeBase64(ENC.encode('Hello, world!'))
    const spacedB64 = `  ${helloB64.slice(0, 5)} \r\n ${helloB64.slice(5, 11)} \t ${helloB64.slice(11)}  `
    assert.deepEqual(decodeBase64Strict(spacedB64), ENC.encode('Hello, world!'))
  })

  it('throws TtsProviderError(bad_audio_payload) on empty, invalid length, bad padding, or corrupt chars', () => {
    for (const bad of [
      '',
      '   \r\n\t  ',
      'A',
      'AAAAA',
      '=',
      '==',
      'Y===',
      'YQ=',
      'YW==YW==',
      '=YWJj',
      'SGVs$G8=',
      'SGVs?G8=',
      'SGVs中G8=',
    ]) {
      assert.throws(
        () => decodeBase64Strict(bad),
        (err) => err instanceof TtsProviderError && err.code === 'bad_audio_payload',
        `expected bad_audio_payload for "${bad}"`,
      )
    }
  })
})

describe('tts-engines: resolveSpeechEndpointUrl & OpenAiCompatTtsEngine', () => {
  it('resolves TTS_OPENAI_PRESETS, permits loopback HTTP, and blocks remote HTTP & embedded credentials', () => {
    for (const presetId of Object.keys(TTS_OPENAI_PRESETS)) {
      const cfg = resolveOpenAiTtsConfig({ presetId })
      assert.equal(cfg.presetId, presetId)
      assert.ok(cfg.url.endsWith('/audio/speech'))
    }

    assert.equal(
      resolveSpeechEndpointUrl('http://127.0.0.1:8880/v1'),
      'http://127.0.0.1:8880/v1/audio/speech',
    )
    assert.equal(
      resolveSpeechEndpointUrl('http://localhost:8000/v1/'),
      'http://localhost:8000/v1/audio/speech',
    )
    assert.equal(
      resolveSpeechEndpointUrl('http://[::1]:8000/v1/audio/speech'),
      'http://[::1]:8000/v1/audio/speech',
    )
    assert.equal(
      resolveSpeechEndpointUrl('https://api.siliconflow.cn/v1'),
      'https://api.siliconflow.cn/v1/audio/speech',
    )

    for (const badUrl of [
      '',
      'http://api.openai.com/v1',
      'http://api.siliconflow.cn/v1',
      'http://127.0.0.1.evil.example/v1',
      'http://0.0.0.0:8880/v1',
      'https://user:pass@api.openai.com/v1',
      'http://user:pass@127.0.0.1:8880/v1',
      'ftp://127.0.0.1:8880/v1',
    ]) {
      assert.throws(
        () => resolveSpeechEndpointUrl(badUrl),
        (err) => err instanceof TtsProviderError && err.code === 'bad_url',
        `expected bad_url for "${badUrl}"`,
      )
    }
  })

  it('strips emotion tags, skips empty input, enforces redirect=error, Bearer auth, optional voice, and speed', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, init })
      return new Response(makeFakeMp3Bytes(), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    }

    const engine = new OpenAiCompatTtsEngine({
      baseUrl: 'http://127.0.0.1:8880/v1',
      model: 'kokoro',
      voice: '',
      apiKey: '  sk-test-openai-token-12345  ',
      fetchImpl,
    })

    // Empty / tag-only input skips HTTP call cleanly
    const skipped = await engine.synthesize('  <laugh> <break 300ms> <sigh>  ')
    assert.equal(skipped.audio.byteLength, 0)
    assert.equal(calls.length, 0)

    // Non-empty input with rate=1 omits voice (when empty) and omits speed (when rate === 1)
    const res1 = await engine.synthesize('你好<laugh>世界', { rate: 1 })
    assert.equal(res1.mime, 'audio/mpeg')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://127.0.0.1:8880/v1/audio/speech')
    assert.equal(calls[0].init.redirect, 'error')
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-test-openai-token-12345')
    const body1 = JSON.parse(calls[0].init.body)
    assert.equal(body1.input, '你好 世界')
    assert.equal(body1.voice, undefined)
    assert.equal(body1.speed, undefined)

    // Custom rate !== 1 and explicit voice
    await engine.synthesize('Fast speech', { voice: 'zf_xiaobei', rate: 1.25 })
    const body2 = JSON.parse(calls[1].init.body)
    assert.equal(body2.voice, 'zf_xiaobei')
    assert.equal(body2.speed, 1.25)

    // Cloud preset with requiresKey: true MUST reject with not_configured BEFORE making any HTTP POST
    let leakedPosts = 0
    const unconfiguredCloud = new OpenAiCompatTtsEngine({
      presetId: 'siliconflow-cosyvoice2',
      apiKey: () => null,
      fetchImpl: async () => {
        leakedPosts += 1
        return new Response(makeFakeMp3Bytes(), { status: 200 })
      },
    })
    assert.equal(unconfiguredCloud.status().ready, false)
    assert.equal(unconfiguredCloud.status().keyRequired, true)
    await assert.rejects(
      () => unconfiguredCloud.prepare(),
      (err) => err instanceof TtsProviderError && err.code === 'not_configured',
    )
    await assert.rejects(
      () => unconfiguredCloud.synthesize('Private vault note sentence'),
      (err) => err instanceof TtsProviderError && err.code === 'not_configured',
    )
    assert.equal(leakedPosts, 0, 'Must never POST private note text without required API key')

    // Overriding baseUrl to loopback HTTP relaxes requiresKey for local self-hosted servers
    const loopbackOverride = new OpenAiCompatTtsEngine({
      presetId: 'siliconflow-cosyvoice2',
      baseUrl: 'http://127.0.0.1:8880/v1',
      apiKey: () => null,
      fetchImpl,
    })
    assert.equal(loopbackOverride.status().ready, true)
    await loopbackOverride.synthesize('Local override')
    assert.equal(calls.length, 3)
  })

  it('redacts secrets BEFORE truncating <= 240 chars on 401 and caps error read at 8 KiB', async () => {
    let errorStreamCancelled = false
    const boundarySecretBody =
      `${'x'.repeat(222)} Bearer sk-test-SECRETBOUNDARY9876543210 ` + 'z'.repeat(16 * 1024)
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(ENC.encode(boundarySecretBody.slice(0, 4096)))
            controller.enqueue(ENC.encode(boundarySecretBody.slice(4096, 9000)))
            controller.enqueue(ENC.encode(boundarySecretBody.slice(9000)))
            controller.close()
          },
          cancel() {
            errorStreamCancelled = true
          },
        }),
        { status: 401 },
      )

    const engine = new OpenAiCompatTtsEngine({
      presetId: 'openai-official',
      apiKey: 'sk-test-dummy-key-12345678',
      fetchImpl,
    })

    await assert.rejects(
      () => engine.synthesize('Hello'),
      (err) => {
        assert.ok(err instanceof TtsProviderError)
        assert.equal(err.code, 'http_error')
        assert.equal(err.status, 401)
        assert.ok(err.message.length <= 240, `expected <= 240 chars, got ${err.message.length}`)
        assert.ok(!err.message.includes('SECRETBOUNDARY'))
        assert.ok(!err.message.includes('sk-test-'))
        return true
      },
    )
    assert.equal(errorStreamCancelled, true)
  })

  it('enforces the 16 MiB streaming audio cap (cancelling reader -> too_large) and rejects HTML 200', async () => {
    let cancelled = false
    const chunk = new Uint8Array(4 * 1024 * 1024)
    chunk.set(makeFakeMp3Bytes(), 0)

    const giantFetch = async () =>
      new Response(
        new ReadableStream({
           pull(controller) {
            controller.enqueue(chunk)
          },
          cancel() {
            cancelled = true
          },
        }),
        { status: 200, headers: { 'content-type': 'audio/mpeg' } },
      )

    const engine = new OpenAiCompatTtsEngine({
      presetId: 'selfhosted-kokoro',
      fetchImpl: giantFetch,
    })

    await assert.rejects(
      () => engine.synthesize('Too big'),
      (err) => err instanceof TtsProviderError && err.code === 'too_large',
    )
    assert.equal(cancelled, true)
    assert.equal(MAX_AUDIO_BYTES, 16 * 1024 * 1024)

    // Spoofed 200 HTML with Content-Type: audio/mpeg -> bad_audio_payload
    const htmlEngine = new OpenAiCompatTtsEngine({
      presetId: 'selfhosted-kokoro',
      fetchImpl: async () =>
        new Response('<html><body>Captive Portal</body></html>', {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        }),
    })
    await assert.rejects(
      () => htmlEngine.synthesize('Captive portal'),
      (err) => err instanceof TtsProviderError && err.code === 'bad_audio_payload',
    )
  })

  it('honors caller AbortSignal, interrupt(), and fallback cooldown recovery without cooling down on aborts', async () => {
    let nowMs = 1_000
    let primaryCalls = 0
    let fallbackCalls = 0
    let primaryShouldFail = false
    let hangNextRequest = false

    const fallbackEngine = {
      kind: 'system',
      mime: 'audio/wav',
      async synthesize() {
        fallbackCalls += 1
        return { audio: makeFakeWavBytes(), mime: 'audio/wav' }
      },
      interrupt() {},
      async close() {},
    }

    const engine = new OpenAiCompatTtsEngine({
      presetId: 'selfhosted-kokoro',
      cooldownMs: 5_000,
      now: () => nowMs,
      fallback: () => fallbackEngine,
      fetchImpl: async (_url, init) => {
        primaryCalls += 1
        if (hangNextRequest) {
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
          })
        }
        if (primaryShouldFail) {
          return new Response('upstream unavailable', { status: 503 })
        }
        return new Response(makeFakeMp3Bytes(), {
          status: 200,
          headers: { 'content-type': 'audio/mpeg' },
        })
      },
    })

    // 1. Mid-flight interrupt() aborts cleanly and does NOT trigger fallback or cooldown
    hangNextRequest = true
    const pendingInterrupt = engine.synthesize('Interrupt me')
    engine.interrupt()
    await assert.rejects(
      () => pendingInterrupt,
      (err) => err instanceof TtsProviderError && err.code === 'aborted',
    )
    assert.equal(fallbackCalls, 0)

    // 2. Caller AbortSignal aborts cleanly and does NOT trigger fallback
    const callerAc = new AbortController()
    const pendingSignal = engine.synthesize('Abort via signal', { signal: callerAc.signal })
    callerAc.abort(new Error('barge-in'))
    await assert.rejects(
      () => pendingSignal,
      (err) => err instanceof TtsProviderError && err.code === 'aborted',
    )
    assert.equal(fallbackCalls, 0)

    // 3. Primary 503 triggers fallback and enters 5_000ms cooldown
    hangNextRequest = false
    primaryShouldFail = true
    const callsBeforeFail = primaryCalls
    const fbRes1 = await engine.synthesize('Fallback 1')
    assert.equal(fbRes1.mime, 'audio/wav')
    assert.equal(primaryCalls, callsBeforeFail + 1)
    assert.equal(fallbackCalls, 1)

    // During cooldown (t = 3_500 < 6_000), primary fetchImpl is skipped completely
    nowMs = 3_500
    primaryShouldFail = false
    const fbRes2 = await engine.synthesize('Still cooling down')
    assert.equal(fbRes2.mime, 'audio/wav')
    assert.equal(primaryCalls, callsBeforeFail + 1)
    assert.equal(fallbackCalls, 2)

    // After cooldown expires (t = 6_000), primary is probed again and recovers
    nowMs = 6_000
    const recovered = await engine.synthesize('Back to primary')
    assert.equal(recovered.mime, 'audio/mpeg')
    assert.equal(primaryCalls, callsBeforeFail + 2)
    assert.equal(fallbackCalls, 2)

    await engine.close()
  })
})

describe('tts-engines: MimoTtsEngine', () => {
  it('rejects missing apiKey with not_configured and isolates api-key header (never Authorization)', async () => {
    const unconfigured = new MimoTtsEngine({ apiKey: '   ' })
    assert.equal(unconfigured.status().ready, false)
    assert.equal(unconfigured.status().keyRequired, true)
    assert.equal(unconfigured.status().keyPresent, false)

    await assert.rejects(
      () => unconfigured.synthesize('你好'),
      (err) => err instanceof TtsProviderError && err.code === 'not_configured',
    )

    let capturedUrl = ''
    let capturedInit
    const wavB64 = encodeBase64(makeFakeWavBytes())

    const mimo = new MimoTtsEngine({
      apiKey: '  mimo-test-secret-key-99887766  ',
      responseFormat: 'mp3',
      instructions: '温柔亲切',
      fetchImpl: async (url, init) => {
        capturedUrl = url
        capturedInit = init
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', audio: { data: wavB64 } } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })

    // Requests mp3 + rate = 1.3, server returns WAV bytes -> sniffed mime overrides to audio/wav
    const result = await mimo.synthesize('早上好<laugh>世界', { rate: 1.3, voice: '冰糖' })
    assert.equal(capturedUrl, 'https://api.xiaomimimo.com/v1/chat/completions')
    assert.equal(capturedInit.redirect, 'error')
    assert.equal(capturedInit.headers['api-key'], 'mimo-test-secret-key-99887766')
    assert.equal(capturedInit.headers.Authorization, undefined)
    assert.equal(capturedInit.headers.authorization, undefined)

    const payload = JSON.parse(capturedInit.body)
    assert.equal(payload.stream, false)
    assert.deepEqual(payload.audio, { voice: '冰糖', format: 'mp3' })
    assert.equal(payload.messages.length, 2)
    assert.equal(payload.messages[0].role, 'user')
    assert.ok(payload.messages[0].content.includes('温柔亲切'))
    assert.ok(payload.messages[0].content.includes('1.3'))
    assert.ok(
      payload.messages[0].content.includes('faster') || payload.messages[0].content.includes('语速'),
    )
    assert.deepEqual(payload.messages[1], { role: 'assistant', content: '早上好 世界' })

    // WAV magic overrides requested mp3
    assert.equal(result.mime, 'audio/wav')
    assert.deepEqual(result.audio, makeFakeWavBytes())
  })

  it('rejects corrupt base64, enforces 24 MiB JSON cap, and redacts MiMo errors before truncation', async () => {
    assert.equal(MAX_MIMO_JSON_BYTES, 24 * 1024 * 1024)

    const corruptB64Engine = new MimoTtsEngine({
      apiKey: 'mimo-test-key-12345678',
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { audio: { data: '!!!corrupt_base64$$$' } } }],
          }),
          { status: 200 },
        ),
    })
    await assert.rejects(
      () => corruptB64Engine.synthesize('测试损坏音频'),
      (err) => err instanceof TtsProviderError && err.code === 'bad_audio_payload',
    )

    let mimoOversizedCancelled = false
    const chunk6MiB = new Uint8Array(6 * 1024 * 1024).fill(0x41)
    const oversizedMimo = new MimoTtsEngine({
      apiKey: 'mimo-test-key-12345678',
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk6MiB)
            },
            cancel() {
              mimoOversizedCancelled = true
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })
    await assert.rejects(
      () => oversizedMimo.synthesize('测试超大响应'),
      (err) => err instanceof TtsProviderError && err.code === 'too_large',
    )
    assert.equal(mimoOversizedCancelled, true)

    const leakingMimo = new MimoTtsEngine({
      apiKey: 'mimo-test-key-12345678',
      fetchImpl: async () =>
        new Response(
          `${'m'.repeat(220)} api_key=mimo-test-LEAKEDKEY9988776655`,
          { status: 403 },
        ),
    })
    await assert.rejects(
      () => leakingMimo.synthesize('测试脱敏'),
      (err) => {
        assert.ok(err instanceof TtsProviderError)
        assert.equal(err.code, 'http_error')
        assert.equal(err.status, 403)
        assert.ok(err.message.length <= 240)
        assert.ok(!err.message.includes('LEAKEDKEY'))
        return true
      },
    )
  })
})

describe('segmenter: long Obsidian note regression (frontmatter + H1-H3 + code fence + URLs + 5x5 GFM table)', () => {
  it('emits clean natural sentences with zero spoken ---, zero URLs, and zero 5x5 table leakage', () => {
    const obsidianNote = [
      '---',
      'title: 语音模式里程碑复盘',
      'date: 2026-11-21',
      'tags: [obsidian, voice-mode, tts]',
      'aliases: [VoiceReview]',
      '---',
      '',
      '# 架构总览',
      '',
      '本插件采用纯内存流式管线设计，详情参阅 https://obsidian.md/plugins?id=voice-mode 官方主页。',
      '',
      '## 引擎对比章节',
      '',
      '本地推理与云端引擎在五项核心指标上的实测结果如下表所示，备选镜像见 <https://hf-mirror.com/models> 页面。',
      '',
      '| 引擎名称 | 首包延迟 | 离线可用 | 多语种支持 | 密钥策略 |',
      '| --- | :---: | ---: | :--- | :---: |',
      '| SenseVoice | 85ms | 支持 | 中英日韩粤 | 免密钥 |',
      '| VITS-zh-ll | 110ms | 支持 | 中文五音色 | 免密钥 |',
      '| Kokoro-82M | 95ms | 支持 | 中英混合 | 免密钥 |',
      '| SiliconFlow | 320ms | 需联网 | 多音色克隆 | Bearer |',
      '| Xiaomi MiMo | 290ms | 需联网 | 自然指令控制 | api-key |',
      '',
      '### 代码配置示例',
      '',
      '下面是一段不应被朗读的配置代码片段：',
      '',
      '```typescript',
      'const endpoint = "http://127.0.0.1:8880/v1/audio/speech";',
      'const separator = "---";',
      'console.log(endpoint, separator);',
      '```',
      '',
      '总结来说，系统在断网时也能自动降级到本地语音引擎，详情可访问 http://127.0.0.1:8880/docs 查看状态。',
      '全部回归验证顺利通过！',
    ].join('\n')

    // 1. Single-pass feed + flush
    const batchSeg = new SentenceSegmenter()
    const batchSentences = [...batchSeg.feed(obsidianNote), ...batchSeg.flush()]

    // 2. Fine-grained 11-char streaming deltas across all Markdown constructs
    const streamSeg = new SentenceSegmenter()
    const streamSentences = []
    for (let i = 0; i < obsidianNote.length; i += 11) {
      streamSentences.push(...streamSeg.feed(obsidianNote.slice(i, i + 11)))
    }
    streamSentences.push(...streamSeg.flush())

    for (const [mode, sentences] of [
      ['batch', batchSentences],
      ['stream', streamSentences],
    ]) {
      assert.ok(sentences.length >= 6, `${mode}: expected natural multi-sentence output`)
      const joined = sentences.join(' ')

      // Zero spoken frontmatter, horizontal/table dashes, pipes, URLs, or fenced code
      assert.equal(joined.includes('---'), false, `${mode}: must not speak ---`)
      assert.equal(joined.includes('|'), false, `${mode}: must not speak table pipes`)
      assert.equal(joined.includes('http'), false, `${mode}: must not speak http/https URLs`)
      assert.equal(joined.includes('obsidian.md'), false, `${mode}: must not speak domain`)
      assert.equal(joined.includes('hf-mirror.com'), false, `${mode}: must not speak angle URL`)
      assert.equal(joined.includes('127.0.0.1'), false, `${mode}: must not speak loopback URL`)
      assert.equal(joined.includes('VoiceReview'), false, `${mode}: must not speak YAML frontmatter`)
      assert.equal(joined.includes('console.log'), false, `${mode}: must not speak fenced code`)
      assert.equal(joined.includes('SenseVoice'), false, `${mode}: must not speak 5x5 table cells`)
      assert.equal(joined.includes('320ms'), false, `${mode}: must not speak 5x5 table cells`)

      // Headings and prose preserved cleanly
      assert.ok(joined.includes('架构总览'), `${mode}: H1 preserved`)
      assert.ok(joined.includes('引擎对比章节'), `${mode}: H2 preserved`)
      assert.ok(joined.includes('代码配置示例'), `${mode}: H3 preserved`)
      assert.ok(joined.includes('本插件采用纯内存流式管线设计'), `${mode}: intro prose preserved`)
      assert.ok(joined.includes('全部回归验证顺利通过'), `${mode}: closing prose preserved`)
    }
  })
})
