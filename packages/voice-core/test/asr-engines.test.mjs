import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ASR_OPENAI_BASE_URL,
  DEFAULT_ASR_OPENAI_MODEL,
  MAX_ASR_AUDIO_BYTES,
  MAX_ASR_RESPONSE_BYTES,
  MAX_ASR_ERROR_BYTES,
  AsrProviderError,
  resolveTranscriptionsEndpointUrl,
  encodeMonoPcm16Wav,
  buildMultipartFormData,
  normalizeWhisperLanguage,
  OpenAiCompatAsrTransport,
  sniffAudioMime,
  resolveLlmEndpoint,
  streamChat,
  completeChat,
} from '../src/index.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

/** Extract ASCII/UTF-8 text & raw binary slices from a Uint8Array RFC 7578 multipart body. */
function inspectMultipart(body, contentType) {
  assert.ok(body instanceof Uint8Array, 'multipart body must be a Uint8Array')
  const match = /^multipart\/form-data;\s*boundary=([^\s;]+)$/.exec(contentType)
  assert.ok(match, `expected multipart/form-data boundary header, got: ${contentType}`)
  const boundary = match[1]
  const rawLatin1 = Array.from(body, (b) => String.fromCharCode(b)).join('')
  const delim = `--${boundary}`
  const closing = `--${boundary}--\r\n`
  assert.ok(rawLatin1.startsWith(`${delim}\r\n`), 'must start with boundary')
  assert.ok(rawLatin1.endsWith(closing), 'must end with closing boundary')

  const inner = rawLatin1.slice(`${delim}\r\n`.length, rawLatin1.length - closing.length)
  const rawParts = inner.split(`\r\n${delim}\r\n`)
  return rawParts.map((part) => {
    const sep = part.indexOf('\r\n\r\n')
    assert.ok(sep !== -1, 'each multipart section must contain CRLFCRLF header separator')
    const headerLatin1 = part.slice(0, sep)
    let valueLatin1 = part.slice(sep + 4)
    if (valueLatin1.endsWith('\r\n')) {
      valueLatin1 = valueLatin1.slice(0, -2)
    }
    const headerBytes = Uint8Array.from(headerLatin1, (c) => c.charCodeAt(0))
    const valueBytes = Uint8Array.from(valueLatin1, (c) => c.charCodeAt(0))
    return {
      headers: DEC.decode(headerBytes),
      textValue: DEC.decode(valueBytes),
      bytes: valueBytes,
    }
  })
}

describe('asr-engines: zero DOM/Node-global and zero lookbehind architecture guard', () => {
  it('uses zero Buffer, FormData, Blob, window, document, atob, btoa, or regex lookbehind in asr-engines.ts', () => {
    const srcPath = fileURLToPath(new URL('../src/asr-engines.ts', import.meta.url))
    const src = readFileSync(srcPath, 'utf8')
    for (const forbidden of ['Buffer', 'FormData', 'Blob', 'window', 'document', 'atob', 'btoa']) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\b`).test(src),
        false,
        `asr-engines.ts must not reference ${forbidden}`,
      )
    }
    assert.equal(src.includes('(?<='), false, 'asr-engines.ts must not use positive lookbehind')
    assert.equal(src.includes('(?<!'), false, 'asr-engines.ts must not use negative lookbehind')
  })
})

describe('asr-engines: resolveTranscriptionsEndpointUrl & normalizeWhisperLanguage', () => {
  it('validates HTTPS & loopback HTTP, strips duplicate /audio/transcriptions, and rejects remote HTTP & user:pass@', () => {
    assert.equal(DEFAULT_ASR_OPENAI_BASE_URL, 'https://api.openai.com/v1')
    assert.equal(DEFAULT_ASR_OPENAI_MODEL, 'whisper-1')
    assert.equal(MAX_ASR_AUDIO_BYTES, 25 * 1024 * 1024)
    assert.equal(MAX_ASR_RESPONSE_BYTES, 1 * 1024 * 1024)
    assert.equal(MAX_ASR_ERROR_BYTES, 8 * 1024)

    const def = resolveTranscriptionsEndpointUrl()
    assert.deepEqual(def, {
      baseUrl: 'https://api.openai.com/v1',
      url: 'https://api.openai.com/v1/audio/transcriptions',
      isLoopbackHttp: false,
    })

    const dedup = resolveTranscriptionsEndpointUrl(
      'https://api.siliconflow.cn/v1/audio/transcriptions/',
    )
    assert.deepEqual(dedup, {
      baseUrl: 'https://api.siliconflow.cn/v1',
      url: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      isLoopbackHttp: false,
    })

    const doubleDedup = resolveTranscriptionsEndpointUrl(
      'https://api.openai.com/v1/audio/transcriptions/audio/transcriptions/',
    )
    assert.equal(doubleDedup.url, 'https://api.openai.com/v1/audio/transcriptions')

    const lo1 = resolveTranscriptionsEndpointUrl('http://127.0.0.1:8000/v1/')
    assert.deepEqual(lo1, {
      baseUrl: 'http://127.0.0.1:8000/v1',
      url: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      isLoopbackHttp: true,
    })

    const lo2 = resolveTranscriptionsEndpointUrl('http://localhost:9000/v1')
    assert.equal(lo2.isLoopbackHttp, true)
    assert.equal(lo2.url, 'http://localhost:9000/v1/audio/transcriptions')

    const loIpv6 = resolveTranscriptionsEndpointUrl('http://[::1]:8000/v1/audio/transcriptions')
    assert.equal(loIpv6.isLoopbackHttp, true)
    assert.equal(loIpv6.url, 'http://[::1]:8000/v1/audio/transcriptions')

    for (const badUrl of [
      'not-a-valid-url',
      'http://api.openai.com/v1',
      'http://api.groq.com/openai/v1',
      'http://0.0.0.0:8000/v1',
      'http://127.0.0.1.evil.example/v1',
      'https://user:pass@api.openai.com/v1',
      'http://user:pass@127.0.0.1:8000/v1',
      'ftp://127.0.0.1:8000/v1',
    ]) {
      assert.throws(
        () => resolveTranscriptionsEndpointUrl(badUrl),
        (err) => err instanceof AsrProviderError && err.code === 'bad_url',
        `expected bad_url for "${badUrl}"`,
      )
    }
  })

  it('normalizes Whisper language codes, preserving Cantonese yue and omitting empty/auto', () => {
    assert.equal(normalizeWhisperLanguage(undefined), undefined)
    assert.equal(normalizeWhisperLanguage(''), undefined)
    assert.equal(normalizeWhisperLanguage('   '), undefined)
    assert.equal(normalizeWhisperLanguage('auto'), undefined)
    assert.equal(normalizeWhisperLanguage('AUTO'), undefined)

    assert.equal(normalizeWhisperLanguage('yue'), 'yue')
    assert.equal(normalizeWhisperLanguage('yue-HK'), 'yue')
    assert.equal(normalizeWhisperLanguage('zh-HK'), 'yue')
    assert.equal(normalizeWhisperLanguage('zh_HK'), 'yue')
    assert.equal(normalizeWhisperLanguage('zh-Hant-HK'), 'yue')

    assert.equal(normalizeWhisperLanguage('zh-CN'), 'zh')
    assert.equal(normalizeWhisperLanguage('zh-TW'), 'zh')
    assert.equal(normalizeWhisperLanguage('en-US'), 'en')
    assert.equal(normalizeWhisperLanguage('ja-JP'), 'ja')
    assert.equal(normalizeWhisperLanguage('ko-KR'), 'ko')
  })
})

describe('asr-engines: encodeMonoPcm16Wav & buildMultipartFormData', () => {
  it('encodes mono Float32 PCM into a standard 44-byte RIFF/WAVE PCM16LE Uint8Array (clamping [-1, 1] and NaN -> 0)', () => {
    const samples = new Float32Array([0, 1, -1, 0.5, -0.5, Number.NaN, 2.5, -4.0])
    const wav = encodeMonoPcm16Wav(samples, 16000)

    assert.ok(wav instanceof Uint8Array)
    assert.equal(wav.byteLength, 44 + samples.length * 2)
    assert.equal(sniffAudioMime(wav), 'audio/wav')

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    assert.equal(DEC.decode(wav.subarray(0, 4)), 'RIFF')
    assert.equal(view.getUint32(4, true), 36 + samples.length * 2)
    assert.equal(DEC.decode(wav.subarray(8, 12)), 'WAVE')
    assert.equal(DEC.decode(wav.subarray(12, 16)), 'fmt ')
    assert.equal(view.getUint32(16, true), 16)
    assert.equal(view.getUint16(20, true), 1) // PCM
    assert.equal(view.getUint16(22, true), 1) // mono
    assert.equal(view.getUint32(24, true), 16000)
    assert.equal(view.getUint32(28, true), 32000)
    assert.equal(view.getUint16(32, true), 2)
    assert.equal(view.getUint16(34, true), 16)
    assert.equal(DEC.decode(wav.subarray(36, 40)), 'data')
    assert.equal(view.getUint32(40, true), samples.length * 2)

    assert.equal(view.getInt16(44 + 0, true), 0)
    assert.equal(view.getInt16(44 + 2, true), 32767)
    assert.equal(view.getInt16(44 + 4, true), -32768)
    assert.equal(view.getInt16(44 + 6, true), 16384)
    assert.equal(view.getInt16(44 + 8, true), -16384)
    assert.equal(view.getInt16(44 + 10, true), 0) // NaN -> 0
    assert.equal(view.getInt16(44 + 12, true), 32767) // 2.5 -> 1
    assert.equal(view.getInt16(44 + 14, true), -32768) // -4.0 -> -1
  })

  it('encodes binary RFC 7578 multipart payloads and sanitizes backslashes / quotes / CRLF in field and file names', () => {
    const rawBinary = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0x80, 0xfe])
    const { body, contentType } = buildMultipartFormData(
      [
        ['model', 'whisper-1'],
        ['bad\\"field\r\nInjected: 1', 'safe-val'],
      ],
      {
        fieldName: 'file\\"\r\nX-Evil: yes',
        fileName: 'C:\\tmp\\speech"\r\n.wav',
        contentType: 'audio/wav\r\nX-Bad: 1',
        bytes: rawBinary,
      },
    )

    const parts = inspectMultipart(body, contentType)
    assert.equal(parts.length, 3)
    assert.ok(parts[0].headers.includes('name="model"'))
    assert.equal(parts[0].textValue, 'whisper-1')

    // Injected backslashes, CRLF, and quotes inside parameter names are percent-escaped, never raw header lines
    assert.equal(parts[1].headers.includes('\r\nInjected:'), false)
    assert.ok(parts[1].headers.includes('name="bad%5C%22field%0D%0AInjected: 1"'))
    assert.equal(parts[1].textValue, 'safe-val')

    assert.equal(parts[2].headers.includes('\r\nX-Evil:'), false)
    assert.equal(parts[2].headers.includes('\r\nX-Bad:'), false)
    assert.equal(parts[2].headers.split('\r\n').length, 2)
    assert.ok(parts[2].headers.includes('name="file%5C%22%0D%0AX-Evil: yes"'))
    assert.ok(parts[2].headers.includes('filename="C:%5Ctmp%5Cspeech%22%0D%0A.wav"'))
    assert.deepEqual(parts[2].bytes, rawBinary)
  })
})

describe('asr-engines: OpenAiCompatAsrTransport security, protocol, buffering, and error bounds', () => {
  it('rejects missing apiKey on HTTPS with 0 HTTP POSTs, and allows keyless loopback HTTP without Authorization', async () => {
    let httpsPosts = 0
    const unconfiguredCloud = new OpenAiCompatAsrTransport({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: () => '   ',
      fetchImpl: async () => {
        httpsPosts += 1
        return new Response(JSON.stringify({ text: 'leaked' }), { status: 200 })
      },
    })

    await assert.rejects(
      () => unconfiguredCloud.transcribe(new Float32Array([0.1, -0.1, 0.2])),
      (err) => err instanceof AsrProviderError && err.code === 'not_configured',
    )
    assert.equal(httpsPosts, 0, 'must never upload voice audio to HTTPS endpoint without API key')

    // Empty PCM returns immediately without network calls
    const emptyEvt = await unconfiguredCloud.transcribe(new Float32Array(0))
    assert.deepEqual(emptyEvt, { text: '', isFinal: true, durationMs: 0 })
    assert.equal(httpsPosts, 0)

    // Loopback HTTP works keyless and omits Authorization header
    const loopbackCalls = []
    const localWhisper = new OpenAiCompatAsrTransport({
      baseUrl: 'http://127.0.0.1:8000/v1',
      language: 'auto',
      fetchImpl: async (url, init) => {
        loopbackCalls.push({ url, init })
        return new Response('  本地语音识别成功  ', {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      },
    })

    const localRes = await localWhisper.transcribe(new Float32Array(1600))
    assert.equal(localRes.text, '本地语音识别成功')
    assert.equal(localRes.isFinal, true)
    assert.equal(localRes.durationMs, 100)
    assert.equal(loopbackCalls.length, 1)
    assert.equal(loopbackCalls[0].url, 'http://127.0.0.1:8000/v1/audio/transcriptions')
    assert.equal(loopbackCalls[0].init.redirect, 'error')
    assert.equal(loopbackCalls[0].init.headers.Authorization, undefined)

    // Language 'auto' must be omitted from multipart fields
    const localParts = inspectMultipart(
      loopbackCalls[0].init.body,
      loopbackCalls[0].init.headers['Content-Type'],
    )
    const fieldNames = localParts.map((p) => /name="([^"]+)"/.exec(p.headers)?.[1])
    assert.deepEqual(fieldNames, ['model', 'response_format', 'file'])
  })

  it('sends Uint8Array multipart WAV + Bearer + normalized language + prompt and supports start/pushAudio/finalize cap', async () => {
    const calls = []
    const cloudAsr = new OpenAiCompatAsrTransport({
      baseUrl: 'https://api.groq.com/openai/v1/',
      model: 'whisper-large-v3-turbo',
      apiKey: '  gsk_test_secret_token_12345678  ',
      language: 'zh-CN',
      prompt: 'Obsidian 双链笔记',
      maxSpeechSec: 0.01, // 160 samples cap
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return new Response(
          JSON.stringify({ text: '  Obsidian 双链笔记测试  ', language: 'zh' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })

    await cloudAsr.start({ language: 'zh-CN' })
    cloudAsr.pushAudio(new Float32Array(100).fill(0.25))
    cloudAsr.pushAudio(new Float32Array(120).fill(-0.25)) // capped at 160 total samples!
    const evt = await cloudAsr.finalize()

    assert.equal(evt.text, 'Obsidian 双链笔记测试')
    assert.equal(evt.language, 'zh')
    assert.equal(evt.isFinal, true)
    assert.equal(evt.durationMs, 10) // 160 / 16000 * 1000 = 10ms

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions')
    assert.equal(calls[0].init.redirect, 'error')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer gsk_test_secret_token_12345678')
    assert.ok(calls[0].init.body instanceof Uint8Array)

    const parts = inspectMultipart(calls[0].init.body, calls[0].init.headers['Content-Type'])
    const byName = Object.fromEntries(
      parts.map((p) => [/name="([^"]+)"/.exec(p.headers)?.[1], p]),
    )
    assert.equal(byName.model.textValue, 'whisper-large-v3-turbo')
    assert.equal(byName.response_format.textValue, 'json')
    assert.equal(byName.language.textValue, 'zh')
    assert.equal(byName.prompt.textValue, 'Obsidian 双链笔记')
    assert.ok(byName.file.headers.includes('filename="speech.wav"'))
    assert.ok(byName.file.headers.includes('Content-Type: audio/wav'))
    assert.equal(byName.file.bytes.byteLength, 44 + 160 * 2)
    assert.equal(sniffAudioMime(byName.file.bytes), 'audio/wav')
  })

  it('redacts secrets BEFORE <= 240-char truncation on 401/500 errors and caps error stream at 8 KiB', async () => {
    for (const status of [401, 500]) {
      let errorStreamCancelled = false
      const secretAtBoundary =
        `${'e'.repeat(222)} Bearer sk-live-ASRSECRETBOUNDARY987654321 ` + 'z'.repeat(14 * 1024)

      const transport = new OpenAiCompatAsrTransport({
        apiKey: 'sk-test-valid-key-12345678',
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(ENC.encode(secretAtBoundary.slice(0, 4096)))
                controller.enqueue(ENC.encode(secretAtBoundary.slice(4096, 9000)))
                controller.enqueue(ENC.encode(secretAtBoundary.slice(9000)))
                controller.close()
              },
              cancel() {
                errorStreamCancelled = true
              },
            }),
            { status },
          ),
      })

      await assert.rejects(
        () => transport.transcribe(new Float32Array([0.1, 0.2])),
        (err) => {
          assert.ok(err instanceof AsrProviderError)
          assert.equal(err.code, 'http_error')
          assert.equal(err.status, status)
          assert.ok(err.message.length <= 240, `expected <= 240 chars, got ${err.message.length}`)
          assert.ok(!err.message.includes('ASRSECRETBOUNDARY'))
          assert.ok(!err.message.includes('sk-live-'))
          return true
        },
      )
      assert.equal(errorStreamCancelled, true)
    }
  })

  it('enforces MAX_ASR_AUDIO_BYTES (25 MiB) upload cap, MAX_ASR_RESPONSE_BYTES (1 MiB) cap, abort(), and AbortSignal', async () => {
    let uploadPosts = 0
    const transport = new OpenAiCompatAsrTransport({
      baseUrl: 'http://127.0.0.1:8000/v1',
      fetchImpl: async () => {
        uploadPosts += 1
        return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
      },
    })

    // 13 Mi samples * 2 bytes + 44 > 25 MiB -> too_large with 0 network POSTs
    const oversizedPcm = new Float32Array(13 * 1024 * 1024)
    await assert.rejects(
      () => transport.transcribe(oversizedPcm),
      (err) => err instanceof AsrProviderError && err.code === 'too_large',
    )
    assert.equal(uploadPosts, 0)

    // > 1 MiB response body -> cancels stream and throws too_large
    let responseCancelled = false
    const chunk512K = new Uint8Array(512 * 1024).fill(0x61)
    const giantResponseAsr = new OpenAiCompatAsrTransport({
      baseUrl: 'http://127.0.0.1:8000/v1',
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(chunk512K)
            },
            cancel() {
              responseCancelled = true
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })
    await assert.rejects(
      () => giantResponseAsr.transcribe(new Float32Array([0.1, -0.1])),
      (err) => err instanceof AsrProviderError && err.code === 'too_large',
    )
    assert.equal(responseCancelled, true)

    // Synchronous abort(), mid-flight abort(), caller AbortSignal, and timeout
    let fetchStartedResolve
    const fetchStarted = new Promise((resolve) => {
      fetchStartedResolve = resolve
    })
    const hangingAsr = new OpenAiCompatAsrTransport({
      baseUrl: 'http://127.0.0.1:8000/v1',
      fetchImpl: async (_url, init) => {
        fetchStartedResolve?.()
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        })
      },
    })

    // 1. Synchronous abort() right after transcribe() call
    const pendingSync = hangingAsr.transcribe(new Float32Array([0.2, -0.2]))
    hangingAsr.abort()
    await assert.rejects(
      () => pendingSync,
      (err) => err instanceof AsrProviderError && err.code === 'aborted',
    )

    // 2. Mid-flight abort() after fetchImpl has started
    const pendingMidFlight = hangingAsr.transcribe(new Float32Array([0.2, -0.2]))
    await fetchStarted
    hangingAsr.abort()
    await assert.rejects(
      () => pendingMidFlight,
      (err) => err instanceof AsrProviderError && err.code === 'aborted',
    )

    // 3. Caller AbortSignal cancellation
    const callerAc = new AbortController()
    const pending2 = hangingAsr.transcribe(new Float32Array([0.2, -0.2]), {
      signal: callerAc.signal,
    })
    callerAc.abort(new Error('user cancelled'))
    await assert.rejects(
      () => pending2,
      (err) => err instanceof AsrProviderError && err.code === 'aborted',
    )

    // 4. Timeout enforcement -> timeout code
    const timeoutAsr = new OpenAiCompatAsrTransport({
      baseUrl: 'http://127.0.0.1:8000/v1',
      timeoutMs: 25,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
        }),
    })
    await assert.rejects(
      () => timeoutAsr.transcribe(new Float32Array([0.1, -0.1])),
      (err) => err instanceof AsrProviderError && err.code === 'timeout',
    )

    // 5. Captive portal HTML 200 -> bad_response with redacted snippet
    const badJsonAsr = new OpenAiCompatAsrTransport({
      baseUrl: 'http://127.0.0.1:8000/v1',
      fetchImpl: async () =>
        new Response('<html>Login sk-live-CAPTIVESECRET12345678</html>', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    })
    await assert.rejects(
      () => badJsonAsr.transcribe(new Float32Array([0.1])),
      (err) => {
        assert.ok(err instanceof AsrProviderError)
        assert.equal(err.code, 'bad_response')
        assert.ok(!err.message.includes('CAPTIVESECRET'))
        return true
      },
    )

    await hangingAsr.close()
    await assert.rejects(
      () => hangingAsr.transcribe(new Float32Array([0.1])),
      (err) => err instanceof AsrProviderError && err.code === 'aborted',
    )
  })
})

describe('llm-router hardening: loopback baseUrl override, non-SSE JSON fallback, and < 400 lines budget', () => {
  it('relaxes requiresKey when a cloud preset baseUrl is overridden to loopback HTTP', async () => {
    const overridden = resolveLlmEndpoint({
      presetId: 'openai',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })
    assert.equal(overridden.requiresKey, false)
    assert.equal(overridden.url, 'http://127.0.0.1:11434/v1/chat/completions')

    // Cloud HTTPS override still requires API key
    const httpsOverride = resolveLlmEndpoint({
      presetId: 'openai',
      baseUrl: 'https://my-gateway.example.com/v1',
    })
    assert.equal(httpsOverride.requiresKey, true)

    // Keyless completeChat succeeds against loopback override
    const reply = await completeChat(
      {
        presetId: 'deepseek',
        baseUrl: 'http://localhost:1234/v1',
        fetchImpl: async (_url, init) => {
          assert.equal(init.headers.authorization, undefined)
          return new Response(
            JSON.stringify({ choices: [{ message: { content: 'Local loopback reply' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        },
      },
      { messages: [{ role: 'user', content: 'ping' }] },
    )
    assert.equal(reply, 'Local loopback reply')
  })

  it('supports non-SSE application/json fallback in streamChat for OpenAI and Anthropic protocols', async () => {
    const openaiChunks = []
    for await (const delta of streamChat(
      {
        presetId: 'openai',
        baseUrl: 'http://127.0.0.1:8080/v1',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: 'Non-SSE OpenAI fallback' } }] }),
            { status: 200, headers: { 'content-type': 'Application/JSON; charset=utf-8' } },
          ),
      },
      { messages: [{ role: 'user', content: 'hi' }] },
    )) {
      openaiChunks.push(delta)
    }
    assert.deepEqual(openaiChunks, ['Non-SSE OpenAI fallback'])

    const anthropicChunks = []
    for await (const delta of streamChat(
      {
        presetId: 'anthropic',
        apiKey: 'sk-ant-test-key-12345678',
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              content: [
                { type: 'text', text: 'Anthropic ' },
                { type: 'text', text: 'JSON fallback' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      },
      { messages: [{ role: 'user', content: 'hi' }] },
    )) {
      anthropicChunks.push(delta)
    }
    assert.deepEqual(anthropicChunks, ['Anthropic JSON fallback'])

    // Empty JSON message content yields zero chunks cleanly
    const emptyChunks = []
    for await (const delta of streamChat(
      {
        presetId: 'ollama',
        fetchImpl: async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
      { messages: [{ role: 'user', content: 'hi' }] },
    )) {
      emptyChunks.push(delta)
    }
    assert.deepEqual(emptyChunks, [])
  })

  it('keeps llm-router.ts strictly under 400 lines (<= 397 lines)', () => {
    const routerPath = fileURLToPath(new URL('../src/llm-router.ts', import.meta.url))
    const content = readFileSync(routerPath, 'utf8')
    const lineCount = content.split('\n').length
    assert.ok(lineCount < 400, `llm-router.ts must be < 400 lines, got ${lineCount}`)
    assert.ok(lineCount <= 397, `llm-router.ts should be <= 397 lines, got ${lineCount}`)
  })
})
