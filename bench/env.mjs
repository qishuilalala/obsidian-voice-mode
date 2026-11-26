import os from 'node:os'
import { execFileSync } from 'node:child_process'

function gitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd: new URL('..', import.meta.url).pathname,
    }).trim()
  } catch {
    return 'unknown'
  }
}

/** 12 字段环境标注（docs/08 §3 口径）。 */
export function collectEnv({ corpusId, warm = 'cold', host = 'unknown', modelId = 'n/a' }) {
  return {
    os: `${process.platform}-${os.release()}`,
    arch: process.arch,
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    memGB: Math.round(os.totalmem() / 1e9),
    node: process.version,
    host,
    modelId,
    warm,
    corpusId,
    segmentation: 'silenceMs=1500',
    gitSha: gitSha(),
    timestamp: new Date().toISOString(),
  }
}
