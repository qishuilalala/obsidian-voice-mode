import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  SentenceSegmenter,
  plainText,
  sanitizeForTts,
  splitSentences,
  stripMarkdownTables,
  cutHead,
} from '../src/index.ts'

describe('segmenter: lookbehind-free guarantee', () => {
  it('contains zero regex lookbehind patterns anywhere in @voice-mode/core src/', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const negLb = '(?' + '<!'
    const posLb = '(?' + '<='
    for (const file of readdirSync(srcDir)) {
      if (!file.endsWith('.ts')) continue
      const content = readFileSync(join(srcDir, file), 'utf8')
      assert.equal(content.includes(negLb), false, `${file} must not contain negative lookbehind`)
      assert.equal(content.includes(posLb), false, `${file} must not contain positive lookbehind`)
    }
  })
})

describe('segmenter: performance guardrails', () => {
  it('splits a 100k-character mixed note within a generous time budget', () => {
    const paragraph = '这是一段用于性能测试的中文文本，包含标点、英文 word 和数字 123。'
    const english = 'This is an English sentence used for the segmentation performance budget.'
    const chunks = []
    let total = 0
    while (total < 100_000) {
      const line = chunks.length % 2 === 0 ? paragraph : english
      chunks.push(line)
      total += line.length + 1
    }
    const text = chunks.join('\n')
    assert.ok(text.length >= 100_000)

    const started = performance.now()
    const { sentences } = splitSentences(text)
    const elapsed = performance.now() - started

    assert.ok(sentences.length > 100, `expected many sentences, got ${sentences.length}`)
    assert.ok(elapsed < 500, `segmentation took ${elapsed.toFixed(1)} ms (budget 500 ms)`)
  })
})

describe('segmenter: Markdown table cleaning', () => {
  it('skips standard GFM pipe tables and alignment delimiters by default', () => {
    const md = [
      '前文介绍如下。',
      '',
      '| 项目 | 数值 | 说明 |',
      '| --- | :---: | ---: |',
      '| 延迟 | 120ms | 本地优先 |',
      '| 体积 | 45MB | int8 量化 |',
      '',
      '后文总结完成。',
    ].join('\n')

    const stripped = stripMarkdownTables(md)
    assert.ok(!stripped.includes('---'))
    assert.ok(!stripped.includes('120ms'))
    assert.ok(stripped.includes('前文介绍如下。'))
    assert.ok(stripped.includes('后文总结完成。'))
  })

  it('replaces multi-row tables with a single spoken placeholder when configured', () => {
    const md = [
      '以下是对比：',
      'Name | Score',
      '--- | ---',
      'Alice | 98',
      'Bob | 95',
      '总结结束。',
    ].join('\n')

    const stripped = stripMarkdownTables(md, {
      policy: 'placeholder',
      placeholder: '这里有一个对比表格。',
    })
    assert.equal(stripped.match(/这里有一个对比表格。/g)?.length, 1)
    assert.ok(!stripped.includes('Alice'))
    assert.ok(stripped.includes('总结结束。'))
  })

  it('strips stray delimiter rows while leaving pipes inside backtick and tilde code fences untouched', () => {
    const md = [
      '| --- | --- |',
      '```txt',
      '| code | col |',
      '| --- | --- |',
      '```',
      '~~~txt',
      '| tilde | col |',
      '| --- | --- |',
      '~~~',
      '正文保留。',
    ].join('\n')

    const stripped = stripMarkdownTables(md)
    assert.ok(stripped.includes('| code | col |'))
    assert.ok(stripped.includes('| tilde | col |'))
    assert.ok(stripped.includes('正文保留。'))
    const outsideFence = stripped.split('```')[0]
    assert.ok(!outsideFence.includes('---'))
  })

  it('handles streaming cross-delta Obsidian Markdown tables without reading headers or delimiters', () => {
    const seg = new SentenceSegmenter({
      tablePolicy: 'placeholder',
      tablePlaceholder: '略过一张表。',
    })
    const deltas = [
      '# 笔记标题\n请看 [[目标笔记|展示别名]] 的统计：\n| 指标',
      ' | 数值 |\n| :--: | ',
      '---: |\n| 吞吐 | 100 |\n| 延迟 ',
      '| 50ms |\n\n最后一句结论。',
    ]
    const out = []
    for (const d of deltas) out.push(...seg.feed(d))
    out.push(...seg.flush())

    const joined = out.join(' ')
    assert.ok(joined.includes('笔记标题'))
    assert.ok(joined.includes('展示别名'))
    assert.ok(joined.includes('略过一张表'))
    assert.ok(joined.includes('最后一句结论'))
    assert.ok(!joined.includes('指标'))
    assert.ok(!joined.includes('50ms'))
    assert.ok(!joined.includes('---'))
  })

  it('does not swallow non-table prose containing a pipe when next line is not a delimiter', () => {
    const seg = new SentenceSegmenter()
    const out = [
      ...seg.feed('方案 A | 方案 B\n'),
      ...seg.feed('下一行是正常正文。'),
      ...seg.flush(),
    ]
    assert.ok(out.some((s) => s.includes('方案 A') && s.includes('方案 B')))
    assert.ok(out.some((s) => s.includes('下一行是正常正文')))
  })
})

describe('segmenter: frontmatter, tilde fences, math, callouts, bare URLs, cross-delta links, and cutHead', () => {
  it('strips YAML frontmatter, tilde fences, block math, Obsidian callout tags, and bare URLs', () => {
    const note = [
      '---',
      'title: 测试笔记',
      'tags: [voice, obsidian]',
      '---',
      '',
      '> [!note]+ 核心结论',
      '> 详情见 https://example.com/path?a=1 与 <https://obsidian.md> 即可。',
      '',
      '$$',
      'E = mc^2',
      '$$',
      '',
      '~~~python',
      'print("secret code")',
      '~~~',
      '',
      '内联 `VoiceEngine` 与 [[RawNote|可读别名]] 以及 [[PlainNote]] 均保留。',
    ].join('\n')

    const cleaned = sanitizeForTts(plainText(note))
    assert.ok(!cleaned.includes('tags'))
    assert.ok(!cleaned.includes('[!note]'))
    assert.ok(!cleaned.includes('https://'))
    assert.ok(!cleaned.includes('mc^2'))
    assert.ok(!cleaned.includes('secret code'))
    assert.ok(cleaned.includes('核心结论'))
    assert.ok(cleaned.includes('VoiceEngine'))
    assert.ok(cleaned.includes('可读别名'))
    assert.ok(cleaned.includes('PlainNote'))

    // Verify streaming cross-delta behavior on the same Obsidian note
    const seg = new SentenceSegmenter()
    const streamed = []
    for (let i = 0; i < note.length; i += 7) {
      streamed.push(...seg.feed(note.slice(i, i + 7)))
    }
    streamed.push(...seg.flush())
    const joined = streamed.join(' ')
    assert.ok(!joined.includes('tags'))
    assert.ok(!joined.includes('[!note]'))
    assert.ok(!joined.includes('https://'))
    assert.ok(!joined.includes('mc^2'))
    assert.ok(!joined.includes('secret code'))
    assert.ok(joined.includes('核心结论'))
    assert.ok(joined.includes('VoiceEngine'))
    assert.ok(joined.includes('可读别名'))
    assert.ok(joined.includes('PlainNote'))
  })

  it('prevents cross-delta Markdown links and wikilinks from leaking URLs or pipes', () => {
    const seg = new SentenceSegmenter()
    const out = [
      ...seg.feed('请阅读 [开发文档](https://ex'),
      ...seg.feed('ample.com/guide.html) 和 [[内部路径|'),
      ...seg.feed('口语标题]]，然后继续。'),
      ...seg.flush(),
    ]
    const joined = out.join(' ')
    assert.ok(joined.includes('开发文档'))
    assert.ok(joined.includes('口语标题'))
    assert.ok(!joined.includes('http'))
    assert.ok(!joined.includes('example.com'))
    assert.ok(!joined.includes('内部路径'))
    assert.ok(!joined.includes('|'))
  })

  it('suppresses split code fences, strips language tag on unclosed fence flush, and recovers hanging ticks', () => {
    const seg = new SentenceSegmenter()
    const out = [
      ...seg.feed('先说一句。`'),
      ...seg.feed('``ts\nconst x = 1;\nconsole.log(x);\n``'),
      ...seg.feed('`再说一句。'),
      ...seg.flush(),
    ]
    assert.deepEqual(out, ['先说一句。', '再说一句。'])

    const unclosed = new SentenceSegmenter()
    const outUnclosed = [
      ...unclosed.feed('开头。```typescript\n未闭合内容依然会朗读'),
      ...unclosed.flush(),
    ]
    const joinedUnclosed = outUnclosed.join(' ')
    assert.ok(joinedUnclosed.includes('未闭合内容依然会朗读'))
    assert.ok(!outUnclosed.includes('typescript'))

    const trailingTicks = new SentenceSegmenter()
    const outTicks = [...trailingTicks.feed('用 `npm` 安装`'), ...trailingTicks.flush()]
    assert.ok(outTicks.join(' ').includes('npm'))
  })

  it('protects decimals/versions, enforces maxSentenceChars, preserves emotion tags, and keeps UTF-16 surrogates intact', () => {
    const seg = new SentenceSegmenter()
    const out = [
      ...seg.feed('版本 1.'),
      ...seg.feed('2.3 与圆周率 3.'),
      ...seg.feed('14 都不该被拆散。'),
      ...seg.flush(),
    ]
    assert.deepEqual(out, ['版本 1.2.3 与圆周率 3.14 都不该被拆散。'])

    const sp = splitSentences('Pi is 3.')
    assert.deepEqual(sp.sentences, [])
    assert.equal(sp.tail, 'Pi is 3.')

    const wallSeg = new SentenceSegmenter({ maxSentenceChars: 20 })
    const wall = '这是一段很长的没有终止标点的文本，中间有逗号，还有一些内容继续延伸下去'
    const wallOut = [...wallSeg.feed(wall), ...wallSeg.flush()]
    assert.ok(wallOut.length >= 2)
    for (const s of wallOut) assert.ok(s.length <= 20)

    const raw = '<p>你好</p> **世界** <whisper>悄悄话</whisper> <break 300ms> <laugh> #噪声'
    const cleaned = sanitizeForTts(plainText(raw))
    assert.ok(cleaned.includes('<whisper>悄悄话</whisper>'))
    assert.ok(cleaned.includes('<break 300ms>'))
    assert.ok(cleaned.includes('<laugh>'))
    assert.ok(!cleaned.includes('<p>'))

    // cutHead guards max <= 0 and never splits UTF-16 surrogate pairs
    assert.deepEqual(cutHead('hello', 0), ['', 'hello'])
    assert.deepEqual(cutHead('hello', -5), ['', 'hello'])
    const emojiText = '一二😀三四五六' // '一'(0),'二'(1),high(2),low(3)...
    const [head, tail] = cutHead(emojiText, 6) // floor(6/2) = 3 lands inside surrogate pair!
    assert.equal(head.isWellFormed(), true)
    assert.equal(tail.isWellFormed(), true)
    assert.equal(head + tail, emojiText)
  })

  it('handles split CRLF frontmatter, nested blockquotes, and unclosed [ without stalling maxSentenceChars', () => {
    // 1. Split CRLF frontmatter across `---\r` and `\n...` and mid-stream `---` without newline
    const fmSeg = new SentenceSegmenter()
    const fmOut = [
      ...fmSeg.feed('---\r'),
      ...fmSeg.feed('\ntitle: Split CRLF\r\nnote: ---'),
      ...fmSeg.feed('-still-yaml\r\n---\r\n> > 嵌套引用正文。'),
      ...fmSeg.flush(),
    ]
    const fmJoined = fmOut.join(' ')
    assert.ok(!fmJoined.includes('Split CRLF'))
    assert.ok(!fmJoined.includes('still-yaml'))
    assert.ok(!fmJoined.includes('>'))
    assert.ok(fmJoined.includes('嵌套引用正文'))

    // 2. Unclosed `[` on a single long streaming line must not stall or bypass maxSentenceChars
    const stallSeg = new SentenceSegmenter({ maxSentenceChars: 24 })
    const liveEmitted = stallSeg.feed(
      '注意 [此处口误未闭合，后续连续输出很长一段中文内容用于测试流式切分。第二句立刻输出。',
    )
    assert.ok(liveEmitted.length >= 2, 'should emit live sentences without waiting for flush()')
    for (const s of liveEmitted) assert.ok(s.length <= 24)
    const rest = stallSeg.flush()
    assert.ok([...liveEmitted, ...rest].join('').includes('第二句立刻输出'))
  })

  it('recognizes metadata at the start of a note at any chunk boundary', () => {
    const body = '正文第一句。正文第二句。'
    const metadata = [
      '---\n# comment\ntags:\n  - voice\n---\n',
      '---\n"custom key": "value"\n---\n',
      "---\n'custom key': value\n...\n",
      '---\n𠮷名: 某人\n---\n',
      '---\n- name: sample\n---\n',
      '---\n---\n',
      '\uFEFF--- \r\n\r\n...\r\n',
      '---\nnotes: |\n  ---\n  metadata continues\n---\n',
      '---\nnotes: |\n  ...\n  metadata continues\n...\n',
    ]
    for (const prefix of metadata) {
      const note = prefix + body
      assert.equal(plainText(note), body, prefix)
      for (const size of [1, 2, 7, note.length]) {
        const segmenter = new SentenceSegmenter()
        const spoken = []
        for (let i = 0; i < note.length; i += size) spoken.push(...segmenter.feed(note.slice(i, i + size)))
        assert.deepEqual([...spoken, ...segmenter.flush()], ['正文第一句。', '正文第二句。'], prefix)
      }
    }
  })

  it('speaks prose between horizontal rules as soon as the first sentence arrives', () => {
    for (const firstLine of ['第一句。', 'Here is the answer.']) {
      const prefix = '---\n\n' + firstLine
      const tail = '\n---\n第三句。'
      assert.ok(plainText(prefix + tail).includes(firstLine))
      for (const chunks of [[prefix], [...prefix]]) {
        const segmenter = new SentenceSegmenter()
        assert.deepEqual(chunks.flatMap(chunk => segmenter.feed(chunk)), [firstLine])
        assert.deepEqual([...segmenter.feed(tail), ...segmenter.flush()], ['第三句。'])
      }
    }
  })

  it('bounds ambiguous keys identically in a complete note and in streamed chunks', () => {
    const key = 'a'.repeat(125)
    const content = '---\n' + key + ': preserved.\n---\nDone.'
    assert.ok(plainText(content).includes('preserved.'))
    for (const chunks of [[content], [...content]]) {
      const segmenter = new SentenceSegmenter()
      const spoken = [...chunks.flatMap(chunk => segmenter.feed(chunk)), ...segmenter.flush()]
      assert.deepEqual(spoken, [key + ': preserved.', 'Done.'])
    }
  })

  it('recognizes a closing delimiter at EOF, recovers unclosed metadata, and resets on flush', () => {
    const segmenter = new SentenceSegmenter()
    for (const note of ['---\n---', '---\r\ntitle: Note\r\n...']) {
      assert.deepEqual([...segmenter.feed(note), ...segmenter.flush()], [])
    }
    assert.deepEqual([...segmenter.feed('---\ntitle: unfinished'), ...segmenter.flush()], ['title: unfinished'])
    assert.deepEqual([...segmenter.feed('---\n\n第一句。第二句。'), ...segmenter.flush()], ['第一句。', '第二句。'])
  })
})
