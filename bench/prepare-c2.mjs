#!/usr/bin/env node
// C2 语料准备（不下载）：扫描 bench/.cache/<corpus>/ 下的 wav 文件，计算 SHA256 并写回
// corpus.manifest.json 的 c2.sha256List（供 run.mjs 校验缓存完整性）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const manifestPath = path.join(root, 'bench/corpus.manifest.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const corpus = manifest.corpora.c2
const cacheDir = path.join(root, 'bench/.cache', corpus.id)

if (!fs.existsSync(cacheDir)) {
  console.log(`[bench] C2 cache not found: ${cacheDir}`)
  console.log('[bench] Download AISHELL-1 test, pick 20-30 clips, place them here, then re-run this script.')
  console.log('[bench] Optional: write a sibling <name>.txt transcript for each clip (CER reference).')
  process.exit(0)
}

const files = fs
  .readdirSync(cacheDir)
  .filter((file) => file.endsWith('.wav'))
  .sort()
const entries = files.map((file) => {
  const bytes = fs.readFileSync(path.join(cacheDir, file))
  const refFile = path.join(cacheDir, file.replace(/\.wav$/, '.txt'))
  return {
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    refText: fs.existsSync(refFile) ? file.replace(/\.wav$/, '.txt') : null,
  }
})

corpus.sha256List = entries
manifest.corpora.c2 = corpus
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify({ prepared: entries.length, corpus: corpus.id, cacheDir }, null, 2))
