#!/usr/bin/env node
// 评测基线最小回归（P1-6）：跑 C1 smoke 并校验 bench@1 报告 schema。
// 单产品（默认 obsidian）在本仓运行；若相邻目录存在 st/daemon/dsh 检出，则一并校验。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// Optional companion checkouts for cross-product validation (never hardcode machine paths):
// VOICE_MODE_COMPANION_ROOT=/path/to/parent with st/daemon/dsh subdirectories.
const companionRoot = process.env.VOICE_MODE_COMPANION_ROOT?.trim() ?? ''
const companions = companionRoot
  ? [
      { product: 'st', repo: path.join(companionRoot, 'sillytavern-voice-mode') },
      { product: 'daemon', repo: path.join(companionRoot, 'voice-mode-daemon') },
      { product: 'dsh', repo: path.join(companionRoot, 'dsh-voice-mode') },
    ]
  : []
const products = [{ product: 'obsidian', repo: null }, ...companions]

const failures = []
for (const { product, repo } of products) {
  if (repo && !fs.existsSync(path.join(repo, '.git'))) {
    console.log(`[skip] ${product}: checkout not found at ${repo}`)
    continue
  }
  const out = path.join(os.tmpdir(), `bench-check-${product}.json`)
  const args = ['bench/run.mjs', '--corpus', 'c1', '--product', product, '--out', out]
  if (repo) args.push('--repo-root', repo)
  execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', timeout: 120_000 })

  const report = JSON.parse(fs.readFileSync(out, 'utf8'))
  const checks = [
    ['schema', report.schema === 'voice-mode/bench@1'],
    ['product', report.product === product],
    ['corpus', report.corpus === 'c1-synthetic'],
    ['version', typeof report.version === 'string' && report.version.length > 0 && report.version !== 'unknown'],
    ['gate', report.gate?.result === 'pass'],
    ['env.gitSha', typeof report.env?.gitSha === 'string' && report.env.gitSha !== 'unknown'],
  ]
  for (const [name, ok] of checks) {
    if (!ok) failures.push(`${product}: ${name} failed`)
  }
  console.log(`[ok] ${product}: ${report.version} @ ${report.env?.gitSha} (${report.corpus})`)
}

if (failures.length > 0) {
  console.error(`\ncheck-bench: ${failures.length} failure(s):`)
  for (const failure of failures) console.error(' -', failure)
  process.exit(1)
}
console.log('\ncheck-bench: all bench@1 reports valid.')
