/**
 * Streaming TTS sentence segmenter and Markdown cleaner (lookbehind-free).
 *
 * Handles YAML frontmatter, cross-delta backtick/tilde code fences, block math (`$$...$$`),
 * GFM pipe tables, Obsidian callouts/wikilinks, bare URLs, punctuation splitting with
 * decimal/version protection, `maxSentenceChars` safety valve, and emotion tag preservation.
 */

export type MarkdownTablePolicy = 'skip' | 'placeholder'

export interface StripMarkdownTablesOptions {
  /** Whether to drop Markdown pipe tables or replace each table with a short spoken hint. */
  policy?: MarkdownTablePolicy
  /** Spoken replacement used when `policy === 'placeholder'`. */
  placeholder?: string
}

export interface SegmenterOptions {
  /** Maximum characters per emitted sentence when punctuation is absent. */
  maxSentenceChars?: number
  /** How Markdown pipe tables should be handled for speech output (default: `'skip'`). */
  tablePolicy?: MarkdownTablePolicy
  /** Spoken hint emitted per table when `tablePolicy === 'placeholder'`. */
  tablePlaceholder?: string
}

const DEFAULT_TABLE_PLACEHOLDER = '此处省略一个表格。'
const SKIP_PREFIX = /^[\s.,，、:：;；!?！？)\]）"'”’〉》】]+$/
const INLINE_SENTENCE_END_RE = /[。！？!?；;…]/
const TABLE_DELIM_CELL_RE = /^:?-+:?$/
const TABLE_DELIM_CHARS_RE = /^[\s|:-]*$/
const UNESCAPED_PIPE_RE = /(?:^|[^\\])\|/
const FENCE_LANG_PREFIX_RE = /^[ \t]*[A-Za-z0-9_+.#-]{1,32}[ \t]*\r?\n/
const MAX_FRONTMATTER_KEY_CHARS = 120
const YAML_CLOSE = /^(?:---|\.\.\.)[ \t]*$/
const YAML_HEADER = /^[ \t]*(?:-[ \t]+)?(?:[\p{L}\p{N}_.-]+|"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')[ \t]*:/u
const YAML_KEY_PREFIX = /^[ \t]*(?:-[ \t]+)?(?:[\p{L}\p{N}_.-]+[ \t]*|"(?:[^"\\]|\\.)*(?:\\|"[ \t]*)?|'(?:[^']|'')*(?:'[ \t]*)?)$/u

/** A possible key stays ambiguous only until punctuation, a second word, or the probe limit. */
function classifyFirstLine(line: string, complete: boolean): 'metadata' | 'pending' | 'body' {
  if (/^[ \t]*#/.test(line)) return 'metadata'
  if (/^[ \t]*$/.test(line)) return 'pending'
  const header = YAML_HEADER.exec(line.slice(0, MAX_FRONTMATTER_KEY_CHARS + 1))
  if (header) {
    const next = line[header[0].length]
    if (next === undefined) return complete ? 'metadata' : 'pending'
    return next === ' ' || next === '\t' ? 'metadata' : 'body'
  }
  if (!complete && YAML_CLOSE.test(line)) return 'pending'
  if (!complete && line.length <= MAX_FRONTMATTER_KEY_CHARS) {
    if (isHighSurrogate(line.charCodeAt(line.length - 1)) || YAML_KEY_PREFIX.test(line)) return 'pending'
  }
  return 'body'
}

/** Inspect the document start exactly once, preserving unclosed metadata as readable input. */
class LeadingFrontmatter {
  private phase: 'opening' | 'first' | 'metadata' | 'body' = 'opening'
  private partial = ''
  private held = ''

  private release(body: string): string {
    this.phase = 'body'
    this.partial = ''
    this.held = ''
    return body
  }

  read(chunk: string, final = false): string {
    if (this.phase === 'body') return chunk
    let start = 0
    for (;;) {
      const nl = chunk.indexOf('\n', start)
      const complete = nl !== -1 || final
      this.partial += nl === -1 ? chunk.slice(start) : chunk.slice(start, nl)
      if (!complete && this.phase === 'metadata') return ''
      // Keep the raw CR so a CRLF split across calls can be reconstructed on fallback.
      const line = this.partial.endsWith('\r') ? this.partial.slice(0, -1) : this.partial
      const rest = nl === -1 ? '' : chunk.slice(nl + 1)
      if (this.phase === 'opening') {
        if (!complete && /^\uFEFF?(?:-{0,2}|---[ \t]*)$/.test(line)) return ''
        if (nl === -1 || !/^\uFEFF?---[ \t]*$/.test(line)) {
          return this.release(this.partial + (nl === -1 ? '' : '\n' + rest))
        }
        this.phase = 'first'
      } else {
        if (complete && YAML_CLOSE.test(line)) return this.release(rest)
        if (this.phase === 'first') {
          const kind = classifyFirstLine(line, complete)
          if (kind === 'body') {
            return this.release(this.held + this.partial + (nl === -1 ? '' : '\n' + rest))
          }
          if (kind === 'metadata') this.phase = 'metadata'
        }
        if (nl === -1) return final ? this.release(this.held + this.partial) : ''
        this.held += this.partial + '\n'
      }
      this.partial = ''
      start = nl + 1
      if (start === chunk.length && !final) return ''
    }
  }
}

/** True when `text` contains a sentence-ending `.` not preceded by an ASCII digit (lookbehind-free). */
function hasNonDecimalPeriodEnd(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 46) continue // '.'
    const prev = i > 0 ? text.charCodeAt(i - 1) : -1
    if (prev >= 48 && prev <= 57) continue // '0'..'9'
    if (i + 1 === text.length || /\s/.test(text[i + 1])) return true
  }
  return false
}

/**
 * True when `text` ends inside a bounded, still-plausible unclosed inline link,
 * wikilink, angle-URL, or active bare URL. Bounded by `maxOpenWindow` so an
 * accidental unclosed `[` never stalls streaming or bypasses `maxSentenceChars`.
 */
function hasOpenInlineConstruct(text: string, maxOpenWindow: number): boolean {
  const limit = Math.max(16, Math.min(maxOpenWindow, 160))

  const openWiki = text.lastIndexOf('[[')
  if (
    openWiki !== -1 &&
    text.indexOf(']]', openWiki + 2) === -1 &&
    text.length - openWiki < limit &&
    !/[。！？\n]/.test(text.slice(openWiki + 2))
  ) {
    return true
  }

  const openLinkParen = text.lastIndexOf('](')
  if (
    openLinkParen !== -1 &&
    text.indexOf(')', openLinkParen + 2) === -1 &&
    text.length - openLinkParen < limit &&
    !/[\s\n]/.test(text.slice(openLinkParen + 2))
  ) {
    return true
  }

  const openBracket = text.lastIndexOf('[')
  if (
    openBracket !== -1 &&
    text.indexOf(']', openBracket + 1) === -1 &&
    text.length - openBracket < limit &&
    !/[。！？\n]/.test(text.slice(openBracket + 1)) &&
    !hasNonDecimalPeriodEnd(text.slice(openBracket + 1))
  ) {
    return true
  }

  const openAngleUrl = text.lastIndexOf('<http')
  if (
    openAngleUrl !== -1 &&
    text.indexOf('>', openAngleUrl + 5) === -1 &&
    text.length - openAngleUrl < limit &&
    !/[\s\n]/.test(text.slice(openAngleUrl + 5))
  ) {
    return true
  }

  const bareUrlMatch = /https?:\/\/[^\s<>()[\]"'”’），。！？、；：]*$/.exec(text)
  if (bareUrlMatch && bareUrlMatch[0].length < limit) return true
  return false
}

/** True when a line is a GFM table alignment delimiter such as `| --- | :---: |` or `| :--: | - |`. */
function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || !trimmed.includes('|')) return false
  const stripped = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells = stripped.split('|').map((c) => c.trim())
  if (cells.length === 0) return false
  return cells.every((cell) => TABLE_DELIM_CELL_RE.test(cell))
}

/** True when a line contains an unescaped table pipe outside Obsidian `[[target|alias]]` wikilinks. */
function isTableRowLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  const withoutWikilinks = trimmed.replace(/\[\[[^\]]*\]\]/g, '')
  return UNESCAPED_PIPE_RE.test(withoutWikilinks)
}

/**
 * Remove or summarize Markdown pipe tables and stray `| --- | --- |` delimiter rows.
 * Fenced code blocks (` ``` ` and `~~~`) are passed through untouched.
 */
export function stripMarkdownTables(
  text: string,
  options: StripMarkdownTablesOptions = {},
): string {
  const policy: MarkdownTablePolicy = options.policy ?? 'skip'
  const placeholder = options.placeholder ?? DEFAULT_TABLE_PLACEHOLDER
  const lines = String(text).split(/\r?\n/)
  const out: string[] = []
  let fenceChar: '`' | '~' | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trimStart()
    const fenceMatch = /^(`{3,}|~{3,})/.exec(trimmed)
    if (fenceMatch) {
      const ch = fenceMatch[1][0] as '`' | '~'
      if (fenceChar === null) fenceChar = ch
      else if (fenceChar === ch) fenceChar = null
      out.push(line)
      continue
    }
    if (fenceChar !== null) {
      out.push(line)
      continue
    }

    if (isTableRowLine(line) && i + 1 < lines.length && isTableDelimiterLine(lines[i + 1])) {
      i += 1
      while (i + 1 < lines.length && isTableRowLine(lines[i + 1])) {
        i += 1
      }
      if (policy === 'placeholder' && placeholder.trim()) {
        out.push(placeholder)
      } else {
        out.push('')
      }
      continue
    }

    if (isTableDelimiterLine(line)) {
      out.push('')
      continue
    }

    out.push(line)
  }

  return out.join('\n')
}

/** Strip Markdown, YAML frontmatter, code fences, block math, callout markers, and URLs while keeping emotion tags intact. */
export function plainText(text: string, options: StripMarkdownTablesOptions = {}): string {
  return cleanMarkdownBody(new LeadingFrontmatter().read(String(text), true), options)
}

function cleanMarkdownBody(text: string, options: StripMarkdownTablesOptions): string {
  const withoutFences = text
    .replace(/`{3,}[\s\S]*?`{3,}/g, ' ')
    .replace(/~{3,}[\s\S]*?~{3,}/g, ' ')
  const withoutMath = withoutFences.replace(/\$\$[\s\S]*?\$\$/g, ' ')
  const withoutTables = stripMarkdownTables(withoutMath, options)
  return withoutTables
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^\s<>]+>/gi, ' ')
    .replace(/https?:\/\/[^\s<>()[\]"'”’），。！？、；：]+/gi, ' ')
    .replace(/^[ \t]*>[ \t]*\[![A-Za-z0-9_-]+\][+-]?(?:[ \t]+(.*))?$/gm, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^(?:[ \t]*>[ \t]?)+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/^[-*_]{3,}\s*$/gm, ' ')
    // Whitelist real HTML tags only so custom emotion tags survive for `emotion.ts`.
    .replace(
      /<\/?(?:b|i|u|br|p|span|div|strong|em|s|sub|sup|h[1-6]|ul|ol|li|a|img|code|pre|blockquote|hr|table|tr|td|th)\b[^>]*>/gi,
      ' ',
    )
}

/**
 * Character-level sanitization for TTS: strips punctuation noise that speech engines
 * pronounce literally while preserving `<` and `>` for emotion tags.
 */
export function sanitizeForTts(text: string): string {
  return String(text)
    .replace(/[*_#|^=+~`]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .trim()
}

/** Split text on CJK and ASCII sentence terminators while protecting decimals and version numbers. */
export function splitSentences(chunk: string): { sentences: string[]; tail: string } {
  const sentences: string[] = []
  let start = 0
  const re = /[。！？!?；;…\n]+|\.(?=\s|$)/g
  let m: RegExpExecArray | null
  let lastEnd = 0
  while ((m = re.exec(chunk)) !== null) {
    const end = m.index + m[0].length
    // Hold trailing `digit.` across deltas so `3.` + `14` or `1.` + `2.3` stays intact.
    if (m[0] === '.' && end === chunk.length && /\d/.test(chunk[m.index - 1] ?? '')) continue
    sentences.push(chunk.slice(start, end))
    start = end
    lastEnd = end
  }
  return { sentences, tail: chunk.slice(lastEnd) }
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Split `text` at the last soft break (`，,、\s`) within `max` chars, falling back to `max / 2`.
 * Guards `max <= 0` and never splits inside a UTF-16 surrogate pair.
 */
export function cutHead(text: string, max: number): [string, string] {
  if (!text || !Number.isFinite(max) || max <= 0) return ['', text]
  if (text.length <= max) return [text, '']

  let idx = -1
  for (let i = Math.min(Math.floor(max), text.length) - 1; i > 0; i--) {
    if (/[，,、\s]/.test(text[i])) {
      idx = i + 1
      break
    }
  }
  if (idx <= 0) idx = Math.max(1, Math.floor(max / 2))

  if (
    idx > 0 &&
    idx < text.length &&
    isHighSurrogate(text.charCodeAt(idx - 1)) &&
    isLowSurrogate(text.charCodeAt(idx))
  ) {
    idx = idx > 1 ? idx - 1 : Math.min(2, text.length)
  }

  return [text.slice(0, idx), text.slice(idx)]
}

export class SentenceSegmenter {
  private rawBuffer = ''
  private readonly maxChars: number
  private readonly tablePolicy: MarkdownTablePolicy
  private readonly tablePlaceholder: string

  // YAML frontmatter state (document start only)
  private frontmatter = new LeadingFrontmatter()

  // Cross-delta code fence state (` ``` ` and `~~~`)
  private fenceChar: '`' | '~' | null = null
  private hangChars = ''
  private fenced = ''

  // Cross-delta block math state (`$$...$$`)
  private inMath = false
  private hangDollar = ''
  private mathBuf = ''

  // Cross-delta Markdown pipe table state
  private inTable = false
  private tableHintEmitted = false
  private pendingHeader: string | null = null
  private lineBuf = ''
  private lineCommitted = false

  constructor(options: SegmenterOptions = {}) {
    const requested = options.maxSentenceChars ?? 200
    this.maxChars = Number.isFinite(requested) ? Math.max(2, Math.floor(requested)) : 200
    this.tablePolicy = options.tablePolicy ?? 'skip'
    this.tablePlaceholder = options.tablePlaceholder ?? DEFAULT_TABLE_PLACEHOLDER
  }

  private emitTableBoundary(): string {
    if (this.tablePolicy === 'placeholder' && !this.tableHintEmitted && this.tablePlaceholder.trim()) {
      this.tableHintEmitted = true
      return `${this.tablePlaceholder}\n`
    }
    return '\n'
  }

  /** Cross-delta fenced code block filter supporting both ` ``` ` and `~~~`. */
  private dropFences(chunk: string): string {
    let s = this.hangChars + chunk
    this.hangChars = ''
    const trail = /(`+|~+)$/.exec(s)
    const hang = trail ? trail[0] : ''
    if (hang.length > 0 && hang.length <= 2) {
      this.hangChars = hang
      s = s.slice(0, -hang.length)
    }
    let out = ''
    for (;;) {
      const m = this.fenceChar === null
        ? /(`{3,}|~{3,})/.exec(s)
        : this.fenceChar === '`'
          ? /`{3,}/.exec(s)
          : /~{3,}/.exec(s)
      if (!m) {
        if (this.fenceChar !== null) this.fenced += s
        else out += s
        return out
      }
      if (this.fenceChar !== null) {
        this.fenced += s.slice(0, m.index)
        this.fenceChar = null
        this.fenced = ''
      } else {
        out += s.slice(0, m.index) + '\n'
        this.fenceChar = m[0][0] as '`' | '~'
      }
      s = s.slice(m.index + m[0].length)
    }
  }

  /** Cross-delta block math (`$$...$$`) filter. */
  private dropBlockMath(chunk: string): string {
    let s = this.hangDollar + chunk
    this.hangDollar = ''
    if (s.endsWith('$') && !s.endsWith('$$')) {
      this.hangDollar = '$'
      s = s.slice(0, -1)
    }
    let out = ''
    for (;;) {
      const idx = s.indexOf('$$')
      if (idx === -1) {
        if (this.inMath) this.mathBuf += s
        else out += s
        return out
      }
      if (this.inMath) {
        this.mathBuf = ''
        this.inMath = false
        out += ' '
      } else {
        out += s.slice(0, idx) + ' '
        this.inMath = true
      }
      s = s.slice(idx + 2)
    }
  }

  /** Cross-delta Markdown pipe table filter with zero latency for regular prose lines. */
  private filterTables(chunk: string): string {
    const normalized = chunk.replace(/\r\n/g, '\n')
    let out = ''
    let pos = 0

    while (pos < normalized.length) {
      const nl = normalized.indexOf('\n', pos)
      if (nl !== -1) {
        const segment = normalized.slice(pos, nl)
        pos = nl + 1

        if (this.lineCommitted) {
          out += segment + '\n'
          this.lineCommitted = false
          continue
        }

        const line = this.lineBuf + segment
        this.lineBuf = ''
        out += this.handleCompleteLine(line)
      } else {
        const rest = normalized.slice(pos)
        pos = normalized.length

        if (this.lineCommitted) {
          out += rest
          continue
        }

        this.lineBuf += rest

        if (this.inTable) {
          continue
        }

        if (this.pendingHeader !== null) {
          if (!TABLE_DELIM_CHARS_RE.test(this.lineBuf)) {
            const releasedHeader = this.pendingHeader
            this.pendingHeader = null
            out += releasedHeader + '\n'
            this.tryFlushRegularLineBuf((chunkOut) => {
              out += chunkOut
            })
          }
          continue
        }

        this.tryFlushRegularLineBuf((chunkOut) => {
          out += chunkOut
        })
      }
    }

    return out
  }

  private tryFlushRegularLineBuf(emit: (s: string) => void): void {
    if (hasOpenInlineConstruct(this.lineBuf, this.maxChars)) return
    if (isTableRowLine(this.lineBuf)) return
    const shouldFlush =
      INLINE_SENTENCE_END_RE.test(this.lineBuf) ||
      hasNonDecimalPeriodEnd(this.lineBuf) ||
      this.lineBuf.length >= this.maxChars
    if (shouldFlush) {
      emit(this.lineBuf)
      this.lineBuf = ''
      this.lineCommitted = true
    }
  }

  private handleCompleteLine(line: string): string {
    if (this.inTable) {
      if (isTableRowLine(line) || isTableDelimiterLine(line)) {
        return ''
      }
      this.inTable = false
      this.tableHintEmitted = false
      if (!line.trim()) return '\n'
      return line + '\n'
    }

    if (this.pendingHeader !== null) {
      const header = this.pendingHeader
      this.pendingHeader = null
      if (isTableDelimiterLine(line)) {
        this.inTable = true
        this.tableHintEmitted = false
        return this.emitTableBoundary()
      }
      const emitted = header + '\n'
      if (isTableRowLine(line)) {
        this.pendingHeader = line
        return emitted
      }
      return emitted + line + '\n'
    }

    if (isTableDelimiterLine(line)) {
      return '\n'
    }

    if (isTableRowLine(line)) {
      this.pendingHeader = line
      return ''
    }

    return line + '\n'
  }

  private flushTableState(): string {
    let out = ''
    if (this.inTable) {
      if (this.lineBuf && !isTableRowLine(this.lineBuf) && !isTableDelimiterLine(this.lineBuf)) {
        out += this.lineBuf
      }
    } else if (this.pendingHeader !== null) {
      if (this.lineBuf && isTableDelimiterLine(this.lineBuf)) {
        out += this.emitTableBoundary()
      } else {
        out += this.pendingHeader + '\n'
        if (this.lineBuf && !isTableDelimiterLine(this.lineBuf)) {
          out += this.lineBuf
        }
      }
    } else if (this.lineBuf && !isTableDelimiterLine(this.lineBuf)) {
      out += this.lineBuf
    }

    this.inTable = false
    this.tableHintEmitted = false
    this.pendingHeader = null
    this.lineBuf = ''
    this.lineCommitted = false
    return out
  }

  private cleanCompleteText(raw: string): string {
    return cleanMarkdownBody(raw, {
      policy: this.tablePolicy,
      placeholder: this.tablePlaceholder,
    })
  }

  private capSentence(s: string, out: string[]): void {
    let rest = s
    while (rest.length > this.maxChars) {
      const [head, tail] = cutHead(rest, this.maxChars)
      if (!head) break
      rest = tail
      const t = sanitizeForTts(head).trim()
      if (t && !SKIP_PREFIX.test(t)) out.push(t)
    }
    const t = sanitizeForTts(rest).trim()
    if (t && !SKIP_PREFIX.test(t)) out.push(t)
  }

  /** Split `rawBuffer` at complete sentence boundaries, running `plainText()` per complete sentence. */
  private drainRawBuffer(out: string[], isFinal: boolean): void {
    if (!this.rawBuffer) return

    if (!isFinal && hasOpenInlineConstruct(this.rawBuffer, this.maxChars)) {
      const lastNl = this.rawBuffer.lastIndexOf('\n')
      if (lastNl === -1) return
      const readyPrefix = this.rawBuffer.slice(0, lastNl + 1)
      this.rawBuffer = this.rawBuffer.slice(lastNl + 1)
      const cleaned = this.cleanCompleteText(readyPrefix)
      const { sentences, tail } = splitSentences(cleaned)
      for (const s of sentences) this.capSentence(s, out)
      if (tail.trim()) this.capSentence(tail, out)
      return
    }

    const { sentences, tail } = splitSentences(this.rawBuffer)
    this.rawBuffer = tail
    for (const rawSentence of sentences) {
      const cleaned = this.cleanCompleteText(rawSentence)
      if (!cleaned) continue
      const sub = splitSentences(cleaned)
      for (const s of sub.sentences) this.capSentence(s, out)
      if (sub.tail.trim()) this.capSentence(sub.tail, out)
    }

    if (!isFinal) {
      while (
        this.rawBuffer.length > this.maxChars &&
        !hasOpenInlineConstruct(this.rawBuffer, this.maxChars)
      ) {
        const cleaned = this.cleanCompleteText(this.rawBuffer)
        if (cleaned.length <= this.maxChars) {
          this.rawBuffer = cleaned
          break
        }
        const [head, rest] = cutHead(cleaned, this.maxChars)
        if (!head) break
        this.rawBuffer = rest
        const t = sanitizeForTts(head).trim()
        if (t && !SKIP_PREFIX.test(t)) out.push(t)
      }
      return
    }

    if (this.rawBuffer) {
      const cleaned = this.cleanCompleteText(this.rawBuffer)
      this.rawBuffer = ''
      if (cleaned) {
        const sub = splitSentences(cleaned)
        for (const s of sub.sentences) this.capSentence(s, out)
        if (sub.tail.trim()) this.capSentence(sub.tail, out)
      }
    }
  }

  /** Feed a raw streaming delta and return all completed sentences. */
  feed(chunk: string): string[] {
    if (!chunk) return []
    const noFrontmatter = this.frontmatter.read(chunk)
    const noFence = noFrontmatter ? this.dropFences(noFrontmatter) : ''
    const noMath = noFence ? this.dropBlockMath(noFence) : ''
    const noTable = noMath ? this.filterTables(noMath) : ''
    if (!noTable) return []
    this.rawBuffer += noTable
    const out: string[] = []
    this.drainRawBuffer(out, false)
    return out
  }

  /** Flush remaining buffered text at end-of-stream and reset internal state. */
  flush(): string[] {
    let tailRaw = this.frontmatter.read('', true)
    this.frontmatter = new LeadingFrontmatter()

    if (this.hangChars) {
      if (this.fenceChar !== null) this.fenced += this.hangChars
      else tailRaw += this.hangChars
      this.hangChars = ''
    }

    if (this.hangDollar) {
      if (this.inMath) this.mathBuf += this.hangDollar
      else tailRaw += this.hangDollar
      this.hangDollar = ''
    }

    if (this.inMath) {
      tailRaw += this.mathBuf
      this.inMath = false
      this.mathBuf = ''
    }

    if (tailRaw) {
      const filtered = this.filterTables(tailRaw)
      if (filtered) this.rawBuffer += filtered
    }

    const trailingTable = this.flushTableState()
    if (trailingTable) this.rawBuffer += trailingTable

    if (this.fenceChar !== null) {
      const restored = this.fenced.replace(FENCE_LANG_PREFIX_RE, '')
      this.rawBuffer += restored
      this.fenceChar = null
      this.fenced = ''
    }

    const out: string[] = []
    this.drainRawBuffer(out, true)
    this.rawBuffer = ''
    return out
  }
}
