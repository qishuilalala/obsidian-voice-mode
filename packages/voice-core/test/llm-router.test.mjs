import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  LLM_PRESETS,
  LLM_PRESET_IDS,
  LlmRouterError,
  validateLoopbackUrl,
  validateEndpointUrl,
  resolveLlmEndpoint,
  completeChat,
  streamChat,
  applyCorrectionGuards,
} from '../src/index.ts'

function streamFromChunks(chunks) {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
}

describe('llm-router: presets, validateLoopbackUrl, and 5 security invariants', () => {
  it('defines all 11 presets and resolves OpenAI-compat and Anthropic endpoints', () => {
    for (const id of LLM_PRESET_IDS) {
      assert.ok(LLM_PRESETS[id], `missing preset ${id}`)
    }

    const ds = resolveLlmEndpoint({ presetId: 'deepseek' })
    assert.equal(ds.protocol, 'openai-compat')
    assert.equal(ds.url, 'https://api.deepseek.com/v1/chat/completions')

    const ant = resolveLlmEndpoint({ presetId: 'anthropic' })
    assert.equal(ant.protocol, 'anthropic-messages')
    assert.equal(ant.url, 'https://api.anthropic.com/v1/messages')

    const ollama = resolveLlmEndpoint({ presetId: 'ollama' })
    assert.equal(ollama.requiresKey, false)
    assert.equal(ollama.url, 'http://127.0.0.1:11434/v1/chat/completions')
  })

  it('validateLoopbackUrl strictly permits only credential-free loopback http(s) URLs', () => {
    assert.equal(validateLoopbackUrl('http://localhost:8765').hostname, 'localhost')
    assert.equal(validateLoopbackUrl('http://127.0.0.1:8765/health').hostname, '127.0.0.1')
    assert.equal(validateLoopbackUrl('https://127.0.0.1:8765').protocol, 'https:')
    assert.equal(validateLoopbackUrl('http://[::1]:8765').protocol, 'http:')

    for (const bad of [
      '',
      'not-a-url',
      'file:///tmp/daemon.sock',
      'https://attacker.example',
      'http://0.0.0.0:8765',
      'http://127.0.0.1.evil.com',
      'http://localhost.evil.com',
      'http://user:pass@127.0.0.1:8765',
    ]) {
      assert.throws(
        () => validateLoopbackUrl(bad),
        (err) => err instanceof LlmRouterError && err.code === 'invalid_url',
        `expected invalid_url for ${bad}`,
      )
    }
  })

  it('redline 1 & 2: rejects non-http(s), non-loopback http, lookalike loopbacks, and embedded credentials', () => {
    assert.throws(() => validateEndpointUrl('file:///etc/passwd'), LlmRouterError)
    assert.throws(() => validateEndpointUrl('ftp://example.com/v1'), LlmRouterError)
    assert.throws(() => validateEndpointUrl('http://api.openai.com/v1'), LlmRouterError)
    assert.throws(() => validateEndpointUrl('http://localhost.evil.com/v1'), LlmRouterError)
    assert.throws(() => validateEndpointUrl('http://0.0.0.0:11434/v1'), LlmRouterError)
    assert.throws(() => validateEndpointUrl('https://user:pass@api.openai.com/v1'), LlmRouterError)

    assert.equal(validateEndpointUrl('http://localhost:11434/v1').hostname, 'localhost')
    assert.equal(validateEndpointUrl('http://127.0.0.1:1234/v1').hostname, '127.0.0.1')
    assert.equal(validateEndpointUrl('http://[::1]:11434/v1').protocol, 'http:')
    assert.equal(validateEndpointUrl('https://api.deepseek.com/v1').protocol, 'https:')
  })

  it('redline 3, 4 & 5: forces redirect=error, deduplicates case-insensitive headers, redacts errors, and sends Anthropic headers', async () => {
    let capturedInit
    const mockAnthropicFetch = async (_url, init) => {
      capturedInit = init
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'Hello from Anthropic' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const reply = await completeChat(
      {
        presetId: 'anthropic',
        apiKey: 'sk-ant-testkey1234567890',
        extraHeaders: {
          'X-Api-Key': 'stale-key-should-be-overridden',
          'Anthropic-Version': '2020-01-01',
          'X-Trace-Id': 'trace-1',
        },
        fetchImpl: mockAnthropicFetch,
      },
      { system: 'Be concise.', messages: [{ role: 'user', content: 'Hi' }] },
    )
    assert.equal(reply, 'Hello from Anthropic')
    assert.equal(capturedInit.redirect, 'error')
    assert.equal(capturedInit.headers['x-api-key'], 'sk-ant-testkey1234567890')
    assert.equal(capturedInit.headers['X-Api-Key'], undefined)
    assert.equal(capturedInit.headers['anthropic-version'], '2023-06-01')
    assert.equal(capturedInit.headers['Anthropic-Version'], undefined)
    assert.equal(capturedInit.headers['anthropic-dangerous-direct-browser-access'], 'true')
    assert.equal(capturedInit.headers['x-trace-id'], 'trace-1')

    // OpenAI header deduplication for Authorization
    let openaiInit
    await completeChat(
      {
        presetId: 'openai',
        apiKey: 'sk-real-1234567890',
        extraHeaders: { Authorization: 'Bearer stale-should-not-duplicate' },
        fetchImpl: async (_u, init) => {
          openaiInit = init
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
        },
      },
      { messages: [{ role: 'user', content: 'hi' }] },
    )
    assert.equal(openaiInit.headers.authorization, 'Bearer sk-real-1234567890')
    assert.equal(openaiInit.headers.Authorization, undefined)

    // Redline 4: error body secret spanning truncation boundary is redacted
    const leakingErrorFetch = async () =>
      new Response(`${'e'.repeat(225)} Bearer sk-live-LEAKEDTOKEN987654321`, { status: 401 })

    await assert.rejects(
      () =>
        completeChat(
          { presetId: 'openai', apiKey: 'sk-test-1234567890', fetchImpl: leakingErrorFetch },
          { messages: [{ role: 'user', content: 'ping' }] },
        ),
      (err) => {
        assert.ok(err instanceof LlmRouterError)
        assert.equal(err.code, 'http_error')
        assert.equal(err.status, 401)
        assert.ok(!err.message.includes('LEAKEDTOKEN'))
        assert.ok(!err.message.includes('sk-live-'))
        return true
      },
    )
  })

  it('maps non-JSON 200, connect timeouts, and network errors to redacted LlmRouterError codes', async () => {
    // Non-JSON 200 response -> bad_response with redacted snippet
    await assert.rejects(
      () =>
        completeChat(
          {
            presetId: 'ollama',
            fetchImpl: async () => new Response('<html>login sk-live-HTMLSECRET123456</html>', { status: 200 }),
          },
          { messages: [{ role: 'user', content: 'hi' }] },
        ),
      (err) => {
        assert.ok(err instanceof LlmRouterError)
        assert.equal(err.code, 'bad_response')
        assert.ok(!err.message.includes('HTMLSECRET'))
        return true
      },
    )

    // Network error with secret in message -> network + redacted
    await assert.rejects(
      () =>
        completeChat(
          {
            presetId: 'ollama',
            fetchImpl: async () => {
              throw new TypeError('connect ECONNREFUSED https://u:pw@host?api_key=mysecret999')
            },
          },
          { messages: [{ role: 'user', content: 'hi' }] },
        ),
      (err) => {
        assert.ok(err instanceof LlmRouterError)
        assert.equal(err.code, 'network')
        assert.ok(!err.message.includes('u:pw'))
        assert.ok(!err.message.includes('mysecret999'))
        return true
      },
    )

    // Connect timeout -> timeout
    await assert.rejects(
      () =>
        completeChat(
          {
            presetId: 'ollama',
            timeoutMs: 25,
            fetchImpl: async (_u, init) =>
              new Promise((_res, rej) => {
                init.signal.addEventListener('abort', () => rej(init.signal.reason), { once: true })
              }),
          },
          { messages: [{ role: 'user', content: 'hi' }] },
        ),
      (err) => err instanceof LlmRouterError && err.code === 'timeout',
    )
  })
})

describe('llm-router: SSE streaming parser, split connect/idle timeout, and AbortSignal', () => {
  it('parses split OpenAI-compat SSE chunks and stops cleanly at [DONE]', async () => {
    const fetchImpl = async (_url, init) => {
      assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, 'Bearer sk-openai-12345678')
      return new Response(
        streamFromChunks([
          'data: {"choices":[{"delta":{"content":"你',
          '好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n\n',
          'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"IGNORED"}}]}\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }

    const deltas = []
    for await (const delta of streamChat(
      { presetId: 'deepseek', apiKey: 'sk-openai-12345678', fetchImpl },
      { messages: [{ role: 'user', content: 'hi' }] },
    )) {
      deltas.push(delta)
    }
    assert.deepEqual(deltas, ['你好', '世界'])
  })

  it('does not kill long streams exceeding connect timeoutMs when chunks arrive within streamIdleTimeoutMs, but times out stalled streams', async () => {
    const enc = new TextEncoder()
    const slowSteadyFetch = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (const word of ['A', 'B', 'C']) {
              await new Promise((r) => setTimeout(r, 20))
              controller.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"${word}"}}]}\n\n`))
            }
            controller.enqueue(enc.encode('data: [DONE]\n\n'))
            controller.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )

    // Total stream duration ~60ms > connect timeoutMs (40ms), yet each gap (20ms) < streamIdleTimeoutMs (80ms)
    const words = []
    for await (const w of streamChat(
      { presetId: 'ollama', timeoutMs: 40, streamIdleTimeoutMs: 80, fetchImpl: slowSteadyFetch },
      { messages: [{ role: 'user', content: 'hi' }] },
    )) {
      words.push(w)
    }
    assert.deepEqual(words, ['A', 'B', 'C'])

    // Stalled stream after headers -> streamIdleTimeoutMs triggers timeout error
    const stalledFetch = async (_u, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true })
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )

    await assert.rejects(
      async () => {
        for await (const chunk of streamChat(
          { presetId: 'ollama', timeoutMs: 200, streamIdleTimeoutMs: 25, fetchImpl: stalledFetch },
          { messages: [{ role: 'user', content: 'hi' }] },
        )) {
          void chunk
        }
      },
      (err) => err instanceof LlmRouterError && err.code === 'timeout',
    )
  })

  it('parses Anthropic content_block_delta SSE stream and respects AbortSignal', async () => {
    const fetchImpl = async () =>
      new Response(
        streamFromChunks([
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Alpha "}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Beta"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )

    const out = []
    for await (const d of streamChat(
      { presetId: 'anthropic', apiKey: 'sk-ant-1234567890', fetchImpl },
      { messages: [{ role: 'user', content: 'hi' }] },
    )) {
      out.push(d)
    }
    assert.deepEqual(out, ['Alpha ', 'Beta'])

    const ac = new AbortController()
    ac.abort(new Error('cancelled'))
    const abortFetch = async (_url, init) => {
      if (init.signal.aborted) throw init.signal.reason
      return new Response('', { status: 200 })
    }
    await assert.rejects(async () => {
      for await (const chunk of streamChat(
        { presetId: 'ollama', fetchImpl: abortFetch },
        { messages: [{ role: 'user', content: 'hi' }], signal: ac.signal },
      )) {
        void chunk
      }
    })
  })
})

describe('llm-router: 4-layer anti-hallucination correction guards', () => {
  it('accepts minimal typo/punctuation fixes and rejects hallucinations, preambles, and pure fillers', () => {
    assert.equal(applyCorrectionGuards('今天天汽真好我们去公园', '今天天气真好，我们去公园。'), '今天天气真好，我们去公园。')
    assert.equal(applyCorrectionGuards('原文不变', '   '), '原文不变')
    assert.equal(
      applyCorrectionGuards('现在几点', '现在是北京时间下午三点十五分，如果您还有其他问题请随时告诉我。'),
      '现在几点',
    )
    assert.equal(applyCorrectionGuards('现在几点了', '下午三点半'), '现在几点了')
    assert.equal(applyCorrectionGuards('今天天气不错', '修正后：今天天气不错'), '今天天气不错')
    assert.equal(applyCorrectionGuards('today is nice', "Here's a correction: Today is nice."), 'today is nice')
    assert.equal(applyCorrectionGuards('今天天气不错', '好的，以下是修正后的文本：今天天气不错。'), '今天天气不错')
    assert.equal(applyCorrectionGuards('打开设置', '好的'), '打开设置')
    assert.equal(applyCorrectionGuards('open settings', 'Sure'), 'open settings')
    assert.equal(applyCorrectionGuards('好的我知道了', '好的，我知道了。'), '好的，我知道了。')
  })
})
