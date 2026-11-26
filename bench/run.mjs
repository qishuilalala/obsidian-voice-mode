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
  },
})

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
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

const report = {
  schema: 'voice-mode/bench@1',
  product: values.product,
  version: '0.1.0',
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
