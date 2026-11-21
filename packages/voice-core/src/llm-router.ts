/**
 * Zero-dependency dual-protocol BYOK LLM router (OpenAI-compatible + Anthropic Messages)
 * with URL/redirect/redaction invariants, split connect/idle timeouts, and 4-layer ASR guards.
 */

import type { LlmPresetId } from './engine-kind.ts'
import { redactBodySnippet, redactSecrets } from './redact.ts'

export type LlmProtocol = 'openai-compat' | 'anthropic-messages'
export type LlmErrorCode = 'bad_url' | 'invalid_url' | 'missing_config' | 'http_error' | 'timeout' | 'bad_response' | 'network'

export interface LlmPreset {
  id: LlmPresetId; label: string; protocol: LlmProtocol
  defaultBaseUrl: string; defaultModel: string; requiresKey: boolean
}
export interface LlmRouterConfig {
  presetId: LlmPresetId; protocol?: LlmProtocol; baseUrl?: string; model?: string; apiKey?: string
  maxTokens?: number; temperature?: number; timeoutMs?: number; streamIdleTimeoutMs?: number
  fetchImpl?: typeof fetch; extraHeaders?: Record<string, string>
}
export interface LlmMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface LlmChatRequest {
  messages: readonly LlmMessage[]; system?: string
  maxTokens?: number; temperature?: number; signal?: AbortSignal
}
export interface ResolvedLlmEndpoint {
  preset: LlmPreset; protocol: LlmProtocol; baseUrl: string
  url: string; model: string; requiresKey: boolean
}

export class LlmRouterError extends Error {
  readonly code: LlmErrorCode
  readonly status?: number
  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message); this.name = 'LlmRouterError'; this.code = code; this.status = status
  }
}

const p = (id: LlmPresetId, label: string, protocol: LlmProtocol, defaultBaseUrl: string, defaultModel: string, requiresKey: boolean): LlmPreset =>
  ({ id, label, protocol, defaultBaseUrl, defaultModel, requiresKey })

export const LLM_PRESETS: Readonly<Record<LlmPresetId, LlmPreset>> = {
  deepseek: p('deepseek', 'DeepSeek', 'openai-compat', 'https://api.deepseek.com/v1', 'deepseek-chat', true),
  'dashscope-qwen': p('dashscope-qwen', 'DashScope (Qwen)', 'openai-compat', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus', true),
  'volcengine-doubao': p('volcengine-doubao', 'Volcengine Ark (Doubao)', 'openai-compat', 'https://ark.cn-beijing.volces.com/api/v3', 'doubao-seed-1-6-250615', true),
  'moonshot-kimi': p('moonshot-kimi', 'Moonshot (Kimi)', 'openai-compat', 'https://api.moonshot.cn/v1', 'moonshot-v1-8k', true),
  siliconflow: p('siliconflow', 'SiliconFlow', 'openai-compat', 'https://api.siliconflow.cn/v1', 'Qwen/Qwen2.5-7B-Instruct', true),
  openrouter: p('openrouter', 'OpenRouter', 'openai-compat', 'https://openrouter.ai/api/v1', 'openai/gpt-4o-mini', true),
  openai: p('openai', 'OpenAI', 'openai-compat', 'https://api.openai.com/v1', 'gpt-4o-mini', true),
  anthropic: p('anthropic', 'Anthropic', 'anthropic-messages', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5', true),
  ollama: p('ollama', 'Ollama (Local)', 'openai-compat', 'http://127.0.0.1:11434/v1', 'qwen2.5:7b', false),
  lmstudio: p('lmstudio', 'LM Studio (Local)', 'openai-compat', 'http://127.0.0.1:1234/v1', 'local-model', false),
  custom: p('custom', 'Custom', 'openai-compat', '', '', false),
}

const ANTHROPIC_API_VERSION = '2023-06-01'
const MAX_ERROR_BYTES = 8 * 1024
const MAX_FALLBACK_CONTENT_LENGTH = 1024 * 1024

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  return Boolean(m && Number(m[1]) <= 255 && Number(m[2]) <= 255 && Number(m[3]) <= 255)
}

function parseHttpUrl(rawUrl: string, code: 'bad_url' | 'invalid_url', label: string): URL {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!trimmed) throw new LlmRouterError(code, `${label} is required`)
  let url: URL
  try { url = new URL(trimmed) } catch { throw new LlmRouterError(code, `${label} is not a valid URL`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LlmRouterError(code, `${label} must use http or https`)
  if (url.username || url.password) throw new LlmRouterError(code, `${label} must not include embedded credentials`)
  return url
}

/** Strict loopback-only URL validator (for local daemon endpoints). */
export function validateLoopbackUrl(rawUrl: string): URL {
  const url = parseHttpUrl(rawUrl, 'invalid_url', 'loopback URL')
  if (!isLoopbackHost(url.hostname)) throw new LlmRouterError('invalid_url', 'URL must target a loopback host')
  return url
}

/** Security invariant: allow only https or loopback http, and forbid embedded credentials. */
export function validateEndpointUrl(rawUrl: string): URL {
  const url = parseHttpUrl(rawUrl, 'bad_url', 'baseUrl')
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) throw new LlmRouterError('bad_url', 'plaintext http is only permitted for loopback hosts')
  return url
}

/** Resolve preset + config overrides into a validated endpoint URL and model. */
export function resolveLlmEndpoint(config: LlmRouterConfig): ResolvedLlmEndpoint {
  const matched = Object.hasOwn(LLM_PRESETS, config.presetId) ? LLM_PRESETS[config.presetId] : LLM_PRESETS.custom
  const protocol = config.protocol ?? matched.protocol
  const rawBase = (config.baseUrl?.trim() || matched.defaultBaseUrl).trim()
  const model = (config.model?.trim() || matched.defaultModel).trim()
  if (!model) throw new LlmRouterError('missing_config', 'model is required')
  const url = validateEndpointUrl(rawBase)
  const suffix = protocol === 'anthropic-messages' ? '/messages' : '/chat/completions'
  const noSlash = url.pathname.replace(/\/+$/, '')
  const basePath = noSlash.endsWith(suffix) ? noSlash.slice(0, -suffix.length) : noSlash
  url.pathname = `${basePath}${suffix}`
  const isLoopbackOverride = Boolean(config.baseUrl?.trim()) && url.protocol === 'http:'
  return { preset: matched, protocol, baseUrl: `${url.origin}${basePath}`, url: url.toString(), model, requiresKey: isLoopbackOverride ? false : matched.requiresKey }
}

/** Merge extra headers with canonical lowercase deduplication so auth/protocol headers never duplicate. */
function mergeHeaders(extra: Record<string, string> | undefined, canonical: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {}
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      const lower = k.trim().toLowerCase()
      if (lower) merged[lower] = v
    }
  }
  for (const [k, v] of Object.entries(canonical)) merged[k.toLowerCase()] = v
  return merged
}

function buildRequestInit(
  config: LlmRouterConfig,
  endpoint: ResolvedLlmEndpoint,
  req: LlmChatRequest,
  stream: boolean,
): { headers: Record<string, string>; body: string } {
  const apiKey = (config.apiKey ?? '').trim()
  if (endpoint.requiresKey && !apiKey) {
    throw new LlmRouterError('missing_config', `API key is required for preset ${endpoint.preset.id}`)
  }
  const maxTokens = req.maxTokens ?? config.maxTokens
  const temperature = req.temperature ?? config.temperature

  if (endpoint.protocol === 'anthropic-messages') {
    const canonical: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    }
    const sys = [req.system?.trim(), ...req.messages.filter((m) => m.role === 'system').map((m) => m.content)].filter(Boolean)
    const messages = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))
    const payload: Record<string, unknown> = { model: endpoint.model, max_tokens: maxTokens ?? 1024, messages, stream }
    if (sys.length > 0) payload.system = sys.join('\n\n')
    if (temperature !== undefined) payload.temperature = temperature
    return { headers: mergeHeaders(config.extraHeaders, canonical), body: JSON.stringify(payload) }
  }

  const canonical: Record<string, string> = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
  const messages: LlmMessage[] = req.system?.trim()
    ? [{ role: 'system', content: req.system.trim() }, ...req.messages]
    : [...req.messages]
  const payload: Record<string, unknown> = { model: endpoint.model, messages, stream }
  if (maxTokens !== undefined) payload.max_tokens = maxTokens
  if (temperature !== undefined) payload.temperature = temperature
  return { headers: mergeHeaders(config.extraHeaders, canonical), body: JSON.stringify(payload) }
}

async function readErrorSnippet(res: Response): Promise<string> {
  try {
    if (!res.body || typeof res.body.getReader !== 'function') {
      const len = Number(res.headers.get('content-length') ?? 0)
      if (Number.isFinite(len) && len > MAX_FALLBACK_CONTENT_LENGTH) return ''
      return redactBodySnippet((await res.text()).slice(0, MAX_ERROR_BYTES), 240)
    }
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      while (total < MAX_ERROR_BYTES) {
        const { done, value } = await reader.read()
        if (done || !value) break
        const take = Math.min(value.byteLength, MAX_ERROR_BYTES - total)
        if (take > 0) { chunks.push(value.subarray(0, take)); total += take }
        if (total >= MAX_ERROR_BYTES) await reader.cancel().catch(() => undefined)
      }
    } finally { reader.releaseLock() }
    const merged = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { merged.set(c, off); off += c.byteLength }
    return redactBodySnippet(new TextDecoder().decode(merged), 240)
  } catch { return '' }
}

interface Watchdog { kick: () => void; stop: () => void; didTimeout: () => boolean }

function createWatchdog(ac: AbortController, ms: number): Watchdog {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let stopped = false
  const stop = (): void => { stopped = true; if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
  const kick = (): void => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => { timedOut = true; ac.abort(new Error('llm request timed out')) }, ms)
  }
  return { kick, stop, didTimeout: () => timedOut }
}

async function openResponse(
  config: LlmRouterConfig,
  endpoint: ResolvedLlmEndpoint,
  req: LlmChatRequest,
  stream: boolean,
): Promise<{ res: Response; ac: AbortController; idleMs: number; cleanup: () => void }> {
  const fetchImpl = config.fetchImpl ?? fetch
  const { headers, body } = buildRequestInit(config, endpoint, req, stream)
  const ac = new AbortController()
  const onAbort = (): void => ac.abort(req.signal?.reason)
  if (req.signal?.aborted) onAbort()
  else req.signal?.addEventListener('abort', onAbort, { once: true })
  const connectMs = config.timeoutMs ?? 30000
  const idleMs = config.streamIdleTimeoutMs ?? connectMs
  const connectWatch = createWatchdog(ac, connectMs)
  connectWatch.kick()
  const cleanup = (): void => { connectWatch.stop(); req.signal?.removeEventListener('abort', onAbort) }
  try {
    const res = await fetchImpl(endpoint.url, { method: 'POST', headers, body, signal: ac.signal, redirect: 'error' })
    connectWatch.stop()
    if (!res.ok) {
      const errWatch = createWatchdog(ac, idleMs)
      errWatch.kick()
      const detail = await readErrorSnippet(res)
      errWatch.stop()
      cleanup()
      throw new LlmRouterError('http_error', `HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
    }
    return { res, ac, idleMs, cleanup }
  } catch (err) {
    cleanup()
    if (err instanceof LlmRouterError) throw err
    if (connectWatch.didTimeout()) throw new LlmRouterError('timeout', `LLM connection timed out after ${connectMs} ms`)
    if (req.signal?.aborted) throw err
    throw new LlmRouterError('network', redactSecrets(err instanceof Error ? err.message : String(err)))
  }
}

async function readJsonCompletion(
  res: Response, ac: AbortController, idleMs: number, protocol: LlmProtocol, signal?: AbortSignal,
): Promise<string> {
  const bodyWatch = createWatchdog(ac, idleMs)
  bodyWatch.kick()
  try {
    let raw: string
    try { raw = await res.text() } catch (err) {
      if (bodyWatch.didTimeout()) throw new LlmRouterError('timeout', `LLM response body timed out after ${idleMs} ms`)
      if (signal?.aborted) throw err
      throw new LlmRouterError('network', redactSecrets(err instanceof Error ? err.message : String(err)))
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new LlmRouterError('bad_response', `non-JSON response: ${redactBodySnippet(raw, 160)}`) }
    if (typeof parsed !== 'object' || parsed === null) throw new LlmRouterError('bad_response', 'JSON response root must be an object')
    const data = parsed as Record<string, unknown>
    if (protocol === 'anthropic-messages') {
      const blocks = Array.isArray(data.content) ? data.content : []
      return blocks
        .filter((b): b is { type: string; text: string } => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => b.text).join('')
    }
    const first = (Array.isArray(data.choices) ? data.choices[0] : undefined) as { message?: { content?: unknown }; delta?: { content?: unknown } } | undefined
    return typeof first?.message?.content === 'string' ? first.message.content : typeof first?.delta?.content === 'string' ? first.delta.content : ''
  } finally { bodyWatch.stop() }
}

/** Non-streaming chat completion returning the full assistant text. */
export async function completeChat(config: LlmRouterConfig, req: LlmChatRequest): Promise<string> {
  const endpoint = resolveLlmEndpoint(config)
  const { res, ac, idleMs, cleanup } = await openResponse(config, endpoint, req, false)
  try { return await readJsonCompletion(res, ac, idleMs, endpoint.protocol, req.signal) } finally { cleanup() }
}

function extractSseDelta(protocol: LlmProtocol, dataLine: string): { text?: string; done?: boolean } {
  if (dataLine === '[DONE]') return { done: true }
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(dataLine) as Record<string, unknown> } catch { return {} }
  if (protocol === 'anthropic-messages') {
    if (parsed.type === 'message_stop') return { done: true }
    if (parsed.type === 'content_block_delta') {
      const d = parsed.delta as { type?: string; text?: string } | undefined
      if (d?.type === 'text_delta' && typeof d.text === 'string') return { text: d.text }
    }
    return {}
  }
  const first = (Array.isArray(parsed.choices) ? parsed.choices[0] : undefined) as { delta?: { content?: unknown } } | undefined
  return typeof first?.delta?.content === 'string' ? { text: first.delta.content } : {}
}

/** Streaming SSE chat completion with separate connect timeout and per-chunk idle watchdog. */
export async function* streamChat(config: LlmRouterConfig, req: LlmChatRequest): AsyncGenerator<string, void, void> {
  const endpoint = resolveLlmEndpoint(config)
  const { res, ac, idleMs, cleanup } = await openResponse(config, endpoint, req, true)
  if ((res.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    try { const text = await readJsonCompletion(res, ac, idleMs, endpoint.protocol, req.signal); if (text) yield text; return }
    finally { cleanup() }
  }
  const reader = res.body?.getReader()
  if (!reader) { cleanup(); throw new LlmRouterError('bad_response', 'streaming response body is missing') }
  const idleWatch = createWatchdog(ac, idleMs)
  const decoder = new TextDecoder()
  let buf = ''
  let dataLines: string[] = []
  try {
    for (;;) {
      idleWatch.kick()
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() } catch (err) {
        if (idleWatch.didTimeout()) throw new LlmRouterError('timeout', `LLM stream idle timed out after ${idleMs} ms`)
        if (req.signal?.aborted) throw err
        throw new LlmRouterError('network', redactSecrets(err instanceof Error ? err.message : String(err)))
      }
      if (chunk.done) break
      idleWatch.kick()
      buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n')
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line === '') {
          if (dataLines.length > 0) {
            const evt = extractSseDelta(endpoint.protocol, dataLines.join('\n').trim())
            dataLines = []
            if (evt.text) yield evt.text
            if (evt.done) return
          }
        } else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        nl = buf.indexOf('\n')
      }
    }
    if (buf.startsWith('data:')) dataLines.push(buf.slice(5).trimStart())
    if (dataLines.length > 0) {
      const evt = extractSseDelta(endpoint.protocol, dataLines.join('\n').trim())
      if (evt.text) yield evt.text
    }
  } finally {
    idleWatch.stop()
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    cleanup()
  }
}

// ── 4-layer ASR LLM correction anti-hallucination guards ─────────────────────

const CORRECTION_PREAMBLE_RE =
  /^(?:以下是|这是|已|文本)?(?:修正|纠正|更正|纠错)|^(?:here(?:'s| is) (?:the |an |a )?|i have |text after )?(?:corrected|correction)\b/i
const CORRECTION_FILLER_WORDS =
  '当然可以|当然|好吧|好的?|行吧|行|是的|嗯|收到|明白了|知道了' +
  '|Thank you|Of course|Got it|OK|Okay|Sure|Certainly|Alright|Understood|Hello|Hi|Yes|Thanks'
const CORRECTION_FILLER_PREFIX_RE = new RegExp(`^(?:(?:${CORRECTION_FILLER_WORDS})(?:\\s*[,，、:：.。!！?？)）]|\\s))+`, 'i')
const CORRECTION_PURE_FILLER_RE = new RegExp(`^(?:(?:${CORRECTION_FILLER_WORDS})(?:\\s*[,，、:：.。!！?？)）]\\s*|\\s+))*(?:${CORRECTION_FILLER_WORDS})\\s*$`, 'i')
const CORRECTION_MIN_SIMILARITY = 0.45
const SIMILARITY_MAX_CHARS = 1500

function normalizedSimilarity(a: string, b: string): number {
  const norm = (s: string) => Array.from(s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''))
  const x = norm(a); const y = norm(b); const n = Math.max(x.length, y.length)
  if (n === 0 || n > SIMILARITY_MAX_CHARS) return 1
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const cur = [i]
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return 1 - prev[y.length]! / n
}

export function correctionSystem(lang: 'zh' | 'en'): string {
  return lang === 'en'
    ? 'You are a speech-recognition corrector. Make only minimal fixes: correct typos/homophones and punctuation, preserving original meaning and style. Do not rewrite, add content, or answer questions. Output only the corrected text.'
    : '你是中文语音识别纠错器。请只做最小修正：改错别字/同音字、补标点，保持原意与口语风格；不要改写、补充或回答问题。只输出修正后的文本，不要任何解释。'
}

/** 4-layer anti-hallucination guard: empty fallback, length gate, Levenshtein gate, preamble/filler gate. */
export function applyCorrectionGuards(original: string, candidate: string): string {
  const trimmed = String(original ?? '').trim()
  if (!trimmed) return original
  const corrected = String(candidate ?? '').trim()
  if (!corrected) return original
  if (corrected.length > Math.max(trimmed.length * 3, trimmed.length + 24)) return original
  if (normalizedSimilarity(trimmed, corrected) < CORRECTION_MIN_SIMILARITY) return original
  if (CORRECTION_PREAMBLE_RE.test(corrected)) return original
  let noFiller = corrected
  for (;;) {
    const next = noFiller.replace(CORRECTION_FILLER_PREFIX_RE, '').trimStart()
    const after = CORRECTION_PURE_FILLER_RE.test(next) ? '' : next
    if (after === noFiller) break
    noFiller = after
  }
  if (noFiller !== corrected && (noFiller === '' || CORRECTION_PREAMBLE_RE.test(noFiller))) return original
  return corrected
}
