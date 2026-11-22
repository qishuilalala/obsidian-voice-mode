import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_DAEMON_BASE_URL,
  DEFAULT_DAEMON_PROBE_TIMEOUT_MS,
  KOKORO_DEFAULT_SPEAKERS,
  DaemonClient,
  DaemonClientError,
  normalizeKokoroVoice,
  resolveDaemonBaseUrl,
} from '../src/index.ts'

function makeFakeWavBytes() {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, // WAVE
    0x66, 0x6d, 0x74, 0x20, // fmt
    0x10, 0x00, 0x00, 0x00,
  ])
}

function makeDaemonHealthResponse(extra = {}) {
  return new Response(
    JSON.stringify({
      ok: true,
      service: 'voice-daemon',
      version: '0.1.0',
      capabilities: ['asr:sensevoice', 'tts:kokoro-103'],
      voices: ['zf_001', 'zm_010', 'af_heart'],
      ...extra,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

describe('daemon-client: zero DOM/Node-global and zero lookbehind architecture guard', () => {
  it('uses zero Buffer, FormData, Blob, window, document, or regex lookbehind in daemon-client.ts', () => {
    const srcPath = fileURLToPath(new URL('../src/daemon-client.ts', import.meta.url))
    const src = readFileSync(srcPath, 'utf8')
    for (const forbidden of ['Buffer', 'FormData', 'Blob', 'window', 'document', 'atob', 'btoa']) {
      assert.equal(
        new RegExp(`\\b${forbidden}\\b`).test(src),
        false,
        `daemon-client.ts must not reference ${forbidden}`,
      )
    }
    assert.equal(src.includes('(?<='), false)
    assert.equal(src.includes('(?<!'), false)
  })
})

describe('daemon-client: loopback http/https URL guard, clean .asr/.tts seams, and Kokoro metadata', () => {
  it('accepts http:// and https:// loopback origins while rejecting remote hosts, LAN IPs, and embedded credentials', () => {
    assert.equal(DEFAULT_DAEMON_BASE_URL, 'http://127.0.0.1:18790')
    assert.equal(DEFAULT_DAEMON_PROBE_TIMEOUT_MS, 800)

    assert.equal(resolveDaemonBaseUrl(), 'http://127.0.0.1:18790')
    assert.equal(resolveDaemonBaseUrl('http://127.0.0.1:18790/'), 'http://127.0.0.1:18790')
    assert.equal(resolveDaemonBaseUrl('https://127.0.0.1:18790/v1/'), 'https://127.0.0.1:18790')
    assert.equal(resolveDaemonBaseUrl('https://localhost:19000/v1'), 'https://localhost:19000')
    assert.equal(resolveDaemonBaseUrl('http://[::1]:18790/v1'), 'http://[::1]:18790')
    assert.equal(resolveDaemonBaseUrl('https://[::1]:18790'), 'https://[::1]:18790')

    for (const bad of [
      'https://api.example.com:18790',
      'http://192.168.1.20:18790',
      'http://10.0.0.5:18790',
      'http://user:testpass@127.0.0.1:18790',
      'https://user:testpass@localhost:18790',
      'ws://127.0.0.1:18790',
    ]) {
      assert.throws(() => resolveDaemonBaseUrl(bad), DaemonClientError)
      assert.throws(() => new DaemonClient({ baseUrl: bad }), DaemonClientError)
    }

    const client = new DaemonClient({ baseUrl: 'https://127.0.0.1:18790' })
    assert.equal(client.asr.kind, 'daemon')
    assert.equal(client.tts.kind, 'kokoro-daemon')
    assert.equal(client.asAsrTransport(), client.asr)
    assert.equal(client.asTtsEngine(), client.tts)
  })

  it('exports curated KOKORO_DEFAULT_SPEAKERS and normalizes named voices and numeric sid 0..102', () => {
    const ids = KOKORO_DEFAULT_SPEAKERS.map((s) => s.id)
    for (const required of ['zf_001', 'zm_010', 'af_heart', 'am_adam', 'bf_emma']) {
      assert.ok(ids.includes(required), `missing curated speaker ${required}`)
    }

    assert.equal(normalizeKokoroVoice(''), 'zf_001')
    assert.equal(normalizeKokoroVoice('zm_010'), 'zm_010')
    assert.equal(normalizeKokoroVoice('af_heart'), 'af_heart')
    assert.equal(normalizeKokoroVoice('0'), '0')
    assert.equal(normalizeKokoroVoice('102'), '102')
    assert.equal(normalizeKokoroVoice('103'), 'zf_001')
    assert.equal(normalizeKokoroVoice('-1'), 'zf_001')
  })
})

describe('daemon-client: probeHealth (/v1/health) with strict service="voice-daemon" port-conflict check', () => {
  it('verifies status===200, ok===true, and service==="voice-daemon", rejecting port-conflicted services returning {}', async () => {
    let seenUrl = ''
    let seenInit = null

    const client = new DaemonClient({
      baseUrl: 'http://127.0.0.1:18790/v1',
      token: () => 'test-daemon-token-value',
      fetchImpl: async (url, init) => {
        seenUrl = String(url)
        seenInit = init
        return makeDaemonHealthResponse()
      },
    })

    const health = await client.probeHealth()
    assert.equal(seenUrl, 'http://127.0.0.1:18790/v1/health')
    assert.equal(seenInit.method, 'GET')
    assert.equal(seenInit.redirect, 'error')
    assert.equal(seenInit.headers.Authorization, 'Bearer test-daemon-token-value')
    assert.equal(health.ok, true)
    assert.equal(health.version, '0.1.0')
    assert.deepEqual(health.capabilities, ['asr:sensevoice', 'tts:kokoro-103'])
    assert.deepEqual(health.voices, ['zf_001', 'zm_010', 'af_heart'])

    // Port-conflict server returning 200 {} or { ok: true } without service: 'voice-daemon' MUST fail!
    for (const conflictPayload of [{}, { ok: true, service: 'other-local-app' }, { ok: false, service: 'voice-daemon' }]) {
      const conflictClient = new DaemonClient({
        fetchImpl: async () =>
          new Response(JSON.stringify(conflictPayload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      })
      const conflictHealth = await conflictClient.probeHealth()
      assert.equal(conflictHealth.ok, false)
    }
  })

  it('bounds hung health probes within default 800 ms (< 1s) and redacts leaked tokens in 401 responses', async () => {
    // Deliberately omit probeTimeoutMs & timeoutMs overrides to prove default <= 800 ms bound!
    const hungClient = new DaemonClient({
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    const t0 = Date.now()
    const hungHealth = await hungClient.probeHealth()
    const elapsed = Date.now() - t0
    assert.equal(hungHealth.ok, false)
    assert.ok(elapsed < 1000, `expected < 1000 ms default probe timeout, got ${elapsed} ms`)

    const leakedToken = 'sk-live-testsecret9876543210abcdef'
    const unauthClient = new DaemonClient({
      fetchImpl: async () =>
        new Response(`{"error":"invalid token Bearer ${leakedToken}"}`, { status: 401 }),
    })
    const unauthHealth = await unauthClient.probeHealth()
    assert.equal(unauthHealth.ok, false)
    assert.equal(unauthHealth.status, 401)
    assert.ok(!String(unauthHealth.error ?? '').includes(leakedToken))
  })
})

describe('daemon-client: kokoro-daemon TTS synthesis, health TTL caching, and < 1s default fallback', () => {
  it('caches healthy probe for 15s and synthesizes WAV via POST /v1/audio/speech', async () => {
    let healthCount = 0
    let speechCount = 0
    let capturedBody = null

    const client = new DaemonClient({
      baseUrl: 'https://localhost:18790',
      token: 'test-token-placeholder-123',
      fetchImpl: async (url, init) => {
        const u = String(url)
        if (u.endsWith('/v1/health')) {
          healthCount += 1
          return makeDaemonHealthResponse()
        }
        assert.equal(u, 'https://localhost:18790/v1/audio/speech')
        speechCount += 1
        assert.equal(init.redirect, 'error')
        assert.equal(init.headers.Authorization, 'Bearer test-token-placeholder-123')
        capturedBody = JSON.parse(String(init.body))
        return new Response(makeFakeWavBytes(), {
          status: 200,
          headers: { 'Content-Type': 'audio/wav' },
        })
      },
    })

    const res1 = await client.tts.synthesize('<whisper>你好 Kokoro</whisper> <break 300ms>', {
      voice: '50',
      rate: 1.25,
    })
    const res2 = await client.tts.synthesize('第二句复用健康缓存')

    assert.equal(healthCount, 1, 'second sentence within 15s TTL must reuse cached health')
    assert.equal(speechCount, 2)
    assert.deepEqual(capturedBody, {
      model: 'kokoro-v1.1-zh',
      input: '第二句复用健康缓存',
      voice: 'zf_001',
      speed: 1,
      response_format: 'wav',
    })
    assert.equal(res1.mime, 'audio/wav')
    assert.equal(res2.mime, 'audio/wav')
  })

  it('falls back to fallbackTts in < 1,000 ms WITHOUT timeoutMs override on hung port, port-conflict {}, 401, 404, 405, 503, and bad HTML payload', async () => {
    const fallbackEvents = []
    const fallbackTts = {
      kind: 'vits-wasm',
      mime: 'audio/wav',
      synthesize: async (text) => ({
        audio: new TextEncoder().encode(`fallback:${text}`),
        mime: 'audio/wav',
      }),
      close: async () => {},
    }

    // 1. Hung port WITHOUT timeoutMs override must fail over via default 800 ms health gate in < 1,000 ms!
    const hungClient = new DaemonClient({
      fallbackTts,
      onFallback: (surface, reason) => fallbackEvents.push({ scenario: 'hung-default', surface, reason }),
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    const tHung = Date.now()
    const hungOut = await hungClient.tts.synthesize('默认超时回退')
    const hungElapsed = Date.now() - tHung
    assert.ok(hungElapsed < 1000, `hung default fallback took ${hungElapsed} ms (>= 1000 ms)`)
    assert.equal(new TextDecoder().decode(hungOut.audio), 'fallback:默认超时回退')

    // Subsequent call within 5s failure cooldown should fail over immediately (< 50 ms) without re-hanging!
    const tCooldown = Date.now()
    await hungClient.tts.synthesize('冷却期秒回退')
    assert.ok(Date.now() - tCooldown < 50)

    // 2. Port-conflict ({}), offline, 401, 403, 404, 405, 503, and disguised HTML payload after healthy probe
    for (const scenario of ['port-conflict', 'offline', 401, 403, 404, 405, 503, 'bad-html']) {
      const client = new DaemonClient({
        fallbackTts,
        onFallback: (surface, reason) => fallbackEvents.push({ scenario, surface, reason }),
        fetchImpl: async (url) => {
          const u = String(url)
          if (scenario === 'offline') {
            throw new TypeError('fetch failed: ECONNREFUSED')
          }
          if (scenario === 'port-conflict') {
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
          }
          if (u.endsWith('/v1/health')) {
            return makeDaemonHealthResponse()
          }
          if (scenario === 'bad-html') {
            return new Response('<html>not audio</html>', {
              status: 200,
              headers: { 'Content-Type': 'audio/wav' },
            })
          }
          return new Response('{"error":"Bearer sk-test-leaked9876543210secret"}', {
            status: scenario,
          })
        },
      })

      const t0 = Date.now()
      const out = await client.tts.synthesize('测试回退')
      assert.ok(Date.now() - t0 < 1000)
      assert.equal(new TextDecoder().decode(out.audio), 'fallback:测试回退')
    }

    for (const ev of fallbackEvents) {
      assert.equal(ev.surface, 'tts')
      assert.ok(!ev.reason.includes('leaked9876543210secret'))
    }
  })
})

describe('daemon-client: daemon ASR transport and < 1s default fallback', () => {
  it('uploads 16 kHz RIFF WAV multipart to POST /v1/audio/transcriptions via client.asr (kind="daemon")', async () => {
    let seenSpeechUrl = ''
    let seenContentType = ''
    let seenBodyBytes = null

    const client = new DaemonClient({
      baseUrl: 'http://[::1]:18790',
      token: 'test-asr-token-placeholder',
      fetchImpl: async (url, init) => {
        const u = String(url)
        if (u.endsWith('/v1/health')) {
          return makeDaemonHealthResponse()
        }
        seenSpeechUrl = u
        seenContentType = init.headers['Content-Type']
        seenBodyBytes = init.body
        return new Response(JSON.stringify({ text: '  守护进程转写成功  ', language: 'zh' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    assert.equal(client.asr.kind, 'daemon')
    await client.asr.start({ language: 'zh-CN' })
    client.asr.pushAudio(new Float32Array([0.1, -0.1, 0.25, -0.25]))
    const result = await client.asr.finalize()

    assert.equal(seenSpeechUrl, 'http://[::1]:18790/v1/audio/transcriptions')
    assert.match(seenContentType, /^multipart\/form-data; boundary=/)
    assert.ok(seenBodyBytes instanceof Uint8Array)
    const ascii = new TextDecoder('latin1').decode(seenBodyBytes)
    assert.ok(ascii.includes('RIFF'))
    assert.ok(ascii.includes('WAVEfmt '))
    assert.equal(result.text, '守护进程转写成功')
    assert.equal(result.isFinal, true)
    assert.equal(result.language, 'zh')
  })

  it('falls back to fallbackAsr in < 1,000 ms WITHOUT timeoutMs override on hung daemon, port conflict, 401, 404, 500, and bad JSON', async () => {
    const events = []
    const fallbackAsr = {
      kind: 'openai-compat',
      transcribe: async () => ({ text: '回退转写文本', isFinal: true }),
      close: async () => {},
    }

    const hungClient = new DaemonClient({
      fallbackAsr,
      onFallback: (surface, reason) => events.push({ mode: 'hung-default', surface, reason }),
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        }),
    })
    const tHung = Date.now()
    const hungRes = await hungClient.asr.transcribe(new Float32Array(320), { language: 'zh-CN' })
    assert.ok(Date.now() - tHung < 1000)
    assert.equal(hungRes.text, '回退转写文本')

    for (const mode of ['port-conflict', 'offline', 401, 404, 500, 'bad-json']) {
      const client = new DaemonClient({
        fallbackAsr,
        onFallback: (surface, reason) => events.push({ mode, surface, reason }),
        fetchImpl: async (url) => {
          const u = String(url)
          if (mode === 'offline') {
            throw new Error('connect ECONNREFUSED 127.0.0.1:18790')
          }
          if (mode === 'port-conflict') {
            return new Response('{"hello":"not-voice-daemon"}', { status: 200 })
          }
          if (u.endsWith('/v1/health')) {
            return makeDaemonHealthResponse()
          }
          if (mode === 'bad-json') {
            return new Response('not-json', {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return new Response('unauthorized', { status: mode })
        },
      })

      const t0 = Date.now()
      const res = await client.asr.transcribe(new Float32Array(320), { language: 'zh-CN' })
      assert.ok(Date.now() - t0 < 1000)
      assert.equal(res.text, '回退转写文本')
    }

    assert.equal(events.length, 7)
    assert.ok(events.every((e) => e.surface === 'asr'))
  })
})
