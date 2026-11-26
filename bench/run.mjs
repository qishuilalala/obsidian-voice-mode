#!/usr/bin/env node
// 单机基准台 runner（骨架版）：C1 链路自检 / C2 缓存校验；输出 bench@1 JSON。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { collectEnv } from './env.mjs'

const { values } = parseArgs({
  options: {
    product: { type: 'string', default: 'obsidian' },
    corpus: { type: 'string', default: 'c1' },
    out: { type: 'string', default: '.scratch/bench-report.json' },
    version: { type: 'string' },
    expression: { type: 'boolean', default: false },
  },
})

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/** Product version: explicit `--version` wins, otherwise the hosting repo's package.json. */
function readProductVersion() {
  if (values.version) return values.version
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'bench/corpus.manifest.json'), 'utf8'))
const corpus = manifest.corpora[values.corpus]
if (!corpus) {
  console.error(`[bench] unknown corpus: ${values.corpus}`)
  process.exit(2)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 16kHz mono 16-bit PCM WAV：1s 440Hz 正弦 + 0.5s 静音。 */
function makeSignalWav() {
  const rate = 16000
  const toneSamples = rate
  const silenceSamples = Math.round(rate * 0.5)
  const data = Buffer.alloc((toneSamples + silenceSamples) * 2)
  for (let i = 0; i < toneSamples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 0.3 * 32767)
    data.writeInt16LE(v, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return { wav: Buffer.concat([header, data]), durationS: (toneSamples + silenceSamples) / rate }
}

function rmsOf(samples) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

// E5: fixed text × mood grid for human expression rating (see bench/human-rating.md).
const EXPRESSION_TEXTS = [
  '今天天气很好，我们出去走走吧。',
  '这件事我需要认真想一想。',
  '别担心，一切都会好起来的。',
  '这个方案的风险点有三个。',
  'The quick brown fox jumps over the lazy dog.',
  'Please review the pull request before Friday.',
  '我记得你提过这个想法。',
  '数据说明增长速度在放缓。',
  '欢迎回来，路上辛苦了。',
  '请把刚才那段再讲一遍。',
]
const EXPRESSION_MOODS = ['neutral', 'gentle', 'urgent']

const metrics = {}
const notes = []
let envModel = 'n/a'

if (values.corpus === 'c1') {
  const { wav, durationS } = makeSignalWav()
  const pcm = []
  for (let i = 44; i + 1 < wav.length; i += 2) pcm.push(wav.readInt16LE(i) / 32768)
  metrics.c1_selftest = {
    durationS,
    rms: Number(rmsOf(pcm).toFixed(6)),
    sha256: sha256(wav),
    fromAudio: false,
  }
  notes.push('C1 为合成确定性信号：仅验证链路与报告格式，不产出 CER。')
} else if (values.corpus === 'c2') {
  const cacheDir = path.join(root, 'bench/.cache', corpus.id)
  if (!fs.existsSync(cacheDir)) {
    notes.push(`C2 语料未缓存（${cacheDir}），跳过真实指标；先按 manifest 抽样缓存。`)
  } else {
    const started = process.hrtime.bigint()
    const files = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.wav'))
    for (const file of files) sha256(fs.readFileSync(path.join(cacheDir, file)))
    metrics.c2_cache = {
      files: files.length,
      scanMs: Number(process.hrtime.bigint() - started) / 1e6,
      fromAudio: true,
    }
  }
} else {
  notes.push(`C3 私人录音不入库；派生统计在后续版本实现（当前 corpus=${values.corpus}）。`)
}

if (values.expression) {
  metrics.expression = {
    status: 'pending-human',
    scale: 5,
    dimensions: ['naturalness', 'emotion-fit', 'voice-consistency', 'barge-in-naturalness'],
    texts: EXPRESSION_TEXTS,
    moods: EXPRESSION_MOODS,
    instructions:
      'Double-blind rating per bench/human-rating.md (4 dimensions × 5-point scale); write results into metrics.expression.scores before comparing versions.',
  }
  notes.push('expression 为待人工评分模板；未评分前不得用于版本对比。')
}

const report = {
  schema: 'voice-mode/bench@1',
  product: values.product,
  version: readProductVersion(),
  corpus: corpus.id,
  env: collectEnv({ corpusId: corpus.id, host: values.product, modelId: envModel }),
  metrics,
  gate: { mode: 'report-only', result: 'pass' },
  notes,
}

const outPath = path.resolve(root, values.out)
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
console.log(`[bench] ${values.product}/${corpus.id} -> ${outPath} (report-only)`)
