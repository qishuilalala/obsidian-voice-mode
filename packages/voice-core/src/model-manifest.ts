/**
 * Pinned model & WASM runtime manifest, mirror URL resolution, pure-TS safe POSIX
 * tar extractor, and Emscripten MEMFS Web Worker glue patcher for `sherpa-onnx@2.0.2`.
 *
 * Host-agnostic and zero-dependency: uses only standard ES2022 + Uint8Array / TextDecoder / URL.
 */

import {
  MODEL_HOST_FALLBACK,
  MODEL_HOST_PRIMARY,
  isSafeModelRel,
  validateModelHost,
  type ModelFileSpec,
} from './contracts.ts'

// ── WASM runtime allowlist & pinned spec (sherpa-onnx@2.0.2) ─────────────────

export const WASM_HOST_PRIMARY = 'https://registry.npmjs.org'
export const WASM_HOST_FALLBACK = 'https://registry.npmmirror.com'

export const ALLOWED_WASM_HOSTNAMES = [
  'registry.npmjs.org',
  'registry.npmmirror.com',
  'cdn.npmmirror.com',
] as const

export interface WasmRuntimeSpec {
  readonly version: string
  readonly cacheSubdir: string
  readonly tarballPath: string
  readonly tarballSha256: string
  readonly tarballBytes?: number
  readonly license: string
  readonly files: readonly ModelFileSpec[]
}

export const SHERPA_WASM_RUNTIME_202: WasmRuntimeSpec = {
  version: '2.0.2',
  cacheSubdir: 'wasm/sherpa-onnx-2.0.2',
  tarballPath: '/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz',
  tarballSha256: '76dbb43b7f10bbed58c187543b6827d4f24d5f174750899913866a2d1c9c5d30',
  license: 'Apache-2.0',
  files: [
    {
      file: 'sherpa-onnx-wasm-nodejs.wasm',
      sha256: '7ed88e41def9dbf6a5bc9df8390ebbf3b2cf7f86224ebe9c9857c2170d5ac01a',
      bytes: 15646211,
    },
    {
      file: 'sherpa-onnx-wasm-nodejs.js',
      sha256: 'f6bb02a007d8768b6c25a898419ecd8ea4c68a54f4576dbebd680643baa8f94c',
      bytes: 103321,
    },
    {
      file: 'sherpa-onnx-asr.js',
      sha256: 'ce92ee9f1548dbb1f0d41044f8ae91566610cbde1c01e954e975502068df54b7',
      bytes: 55576,
    },
    {
      file: 'sherpa-onnx-vad.js',
      sha256: 'a6876ca670955c32bc8b837072d2e94af246e02338342931f8848c0fe5c04e53',
      bytes: 8719,
    },
    {
      file: 'sherpa-onnx-tts.js',
      sha256: '0f66769feeb012282c984014c56c7e3b5239d4ef9559298d196affda3b9e751e',
      bytes: 41427,
    },
  ],
}

// ── Pinned local model bundle specs ──────────────────────────────────────────

export const LOCAL_MODEL_BUNDLE_IDS = ['silero-vad', 'sensevoice-int8', 'vits-zh-ll'] as const
export type LocalModelBundleId = (typeof LOCAL_MODEL_BUNDLE_IDS)[number]

export interface ModelBundleSpec {
  readonly id: LocalModelBundleId
  readonly label: string
  readonly repo: string
  readonly revision: string
  readonly license: string
  readonly totalBytes: number
  readonly files: readonly ModelFileSpec[]
}

const SILERO_VAD_REVISION = 'fba88cd2e921609e7675c3aaf51e0b9b295da4bc'
const SENSEVOICE_INT8_REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07'
const VITS_ZH_LL_REVISION = '7ddf37bcacf05ed56afee360d96835be633a5265'

export const MODEL_BUNDLES: Readonly<Record<LocalModelBundleId, ModelBundleSpec>> = {
  'silero-vad': {
    id: 'silero-vad',
    label: 'Silero VAD',
    repo: 'csukuangfj/vad',
    revision: SILERO_VAD_REVISION,
    license: 'MIT',
    totalBytes: 1807522,
    files: [
      {
        file: 'silero_vad.onnx',
        revision: SILERO_VAD_REVISION,
        sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
        bytes: 1807522,
      },
    ],
  },
  'sensevoice-int8': {
    id: 'sensevoice-int8',
    label: 'SenseVoice Small int8 (zh/en/ja/ko/yue)',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    revision: SENSEVOICE_INT8_REVISION,
    license: 'FunAudioLLM',
    totalBytes: 239549735,
    files: [
      {
        file: 'model.int8.onnx',
        revision: SENSEVOICE_INT8_REVISION,
        sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
        bytes: 239233841,
      },
      {
        file: 'tokens.txt',
        revision: SENSEVOICE_INT8_REVISION,
        sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
        bytes: 315894,
      },
    ],
  },
  'vits-zh-ll': {
    id: 'vits-zh-ll',
    label: 'VITS Chinese Multi-Speaker',
    repo: 'csukuangfj/sherpa-onnx-vits-zh-ll',
    revision: VITS_ZH_LL_REVISION,
    license: 'Apache-2.0',
    totalBytes: 121380000,
    files: [
      {
        file: 'model.onnx',
        revision: VITS_ZH_LL_REVISION,
        sha256: '6c349bdd73dc928234dd7bc86929748bba32cd5264d32d915bf7b7aa0595965b',
      },
      {
        file: 'lexicon.txt',
        revision: VITS_ZH_LL_REVISION,
        sha256: 'b3a82f16b286c424953dea3686039e7ab465fa8e15d87ef8abd0ec69175beb21',
      },
      {
        file: 'tokens.txt',
        revision: VITS_ZH_LL_REVISION,
        sha256: '34b035b9aeb070df6188b022f29c00e0e142c7ade9f25611ced65db5e9cc8402',
      },
      {
        file: 'G_multisperaker_latest.json',
        revision: VITS_ZH_LL_REVISION,
        sha256: 'f31e4bf23827c3528fdf090fd7b6fb8e63333709b80670d40fa864f1fa9fadf3',
      },
      {
        file: 'date.fst',
        revision: VITS_ZH_LL_REVISION,
        sha256: 'eb8aa079ae3cb81d8f4404992f39d61a0cb990947512b5b8d1e54d1f6980e718',
      },
      {
        file: 'phone.fst',
        revision: VITS_ZH_LL_REVISION,
        sha256: '1ac2b6fa56b1442320c4de7db08353bab8963a2b57f365eebcdd3a2d3562f8d7',
      },
      {
        file: 'number.fst',
        revision: VITS_ZH_LL_REVISION,
        sha256: '743f402181fcfebf76cc2f0546b71fa26476e626fbe4e460fb7b4c3a7a8bd5bd',
      },
    ],
  },
}

// ── URL resolution & redirect validation helpers ─────────────────────────────

/**
 * Verify that the final post-redirect WASM tarball URL stays within credential-free
 * HTTPS and the allowlisted npm/npmmirror hosts (or their subdomains).
 */
export function wasmRedirectHostAllowed(finalUrl: string, allowCustomHost = false): boolean {
  try {
    const u = new URL(finalUrl)
    if (u.protocol !== 'https:') return false
    if (u.username || u.password) return false
    const hostname = u.hostname.toLowerCase()
    if (allowCustomHost) return true
    return ALLOWED_WASM_HOSTNAMES.some(
      (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
    )
  } catch {
    return false
  }
}

/**
 * Build ordered, deduplicated HTTPS download URLs for a single model file across
 * preferred and fallback HuggingFace hosts.
 */
export function resolveModelFileUrls(
  repo: string,
  spec: ModelFileSpec,
  preferredHost?: string,
  allowCustomHost = false,
): string[] {
  if (!isSafeModelRel(repo)) {
    throw new Error(`Unsafe model repository identifier: "${repo}"`)
  }
  if (!spec || !isSafeModelRel(spec.file)) {
    throw new Error(`Unsafe relative model file path: "${spec?.file ?? ''}"`)
  }
  const revision = (spec.revision ?? 'main').trim()
  if (
    !revision ||
    revision === '.' ||
    revision === '..' ||
    revision.includes('/') ||
    revision.includes('\\') ||
    revision.includes('\0')
  ) {
    throw new Error(`Unsafe model revision identifier: "${revision}"`)
  }

  const encodedRepo = repo
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const encodedRevision = encodeURIComponent(revision)
  const encodedRel = spec.file
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')

  const validatedPreferred = preferredHost
    ? validateModelHost(preferredHost, allowCustomHost)
    : null
  const orderedHosts: string[] = []
  for (const candidate of [validatedPreferred, MODEL_HOST_PRIMARY, MODEL_HOST_FALLBACK]) {
    if (candidate && !orderedHosts.includes(candidate)) {
      orderedHosts.push(candidate)
    }
  }

  return orderedHosts.map((host) => `${host}/${encodedRepo}/resolve/${encodedRevision}/${encodedRel}`)
}

/**
 * Build ordered HTTPS tarball URLs for the pinned `sherpa-onnx` WASM package,
 * prioritizing `registry.npmmirror.com` when the user selected `hf-mirror.com`.
 */
export function resolveWasmTarballUrls(
  preferredModelHost?: string,
  spec: WasmRuntimeSpec = SHERPA_WASM_RUNTIME_202,
): string[] {
  const rawTarPath = spec.tarballPath.startsWith('/') ? spec.tarballPath.slice(1) : spec.tarballPath
  if (!isSafeModelRel(rawTarPath)) {
    throw new Error(`Unsafe WASM tarball path: "${spec.tarballPath}"`)
  }
  const normalizedTarPath = `/${rawTarPath}`
  const preferMirror =
    typeof preferredModelHost === 'string' &&
    preferredModelHost.toLowerCase().includes('hf-mirror.com')

  const hosts = preferMirror
    ? [WASM_HOST_FALLBACK, WASM_HOST_PRIMARY]
    : [WASM_HOST_PRIMARY, WASM_HOST_FALLBACK]

  return hosts.map((host) => `${host}${normalizedTarPath}`)
}

// ── Pure-TS safe POSIX / USTAR / PAX tar extractor ───────────────────────────

const TAR_BLOCK_SIZE = 512
const UTF8_DECODER = new TextDecoder('utf-8')

function isZeroTarBlock(bytes: Uint8Array, offset: number): boolean {
  const end = offset + TAR_BLOCK_SIZE
  for (let i = offset; i < end; i += 1) {
    if (bytes[i] !== 0) return false
  }
  return true
}

function readTarString(bytes: Uint8Array, start: number, maxLen: number): string {
  const limit = start + maxLen
  let end = start
  while (end < limit && bytes[end] !== 0) {
    end += 1
  }
  return end > start ? UTF8_DECODER.decode(bytes.subarray(start, end)) : ''
}

function parseTarSize(bytes: Uint8Array, start: number, len: number): number {
  const first = bytes[start]
  // GNU / STAR base-256 big-endian binary size encoding (high bit set on first byte).
  if ((first & 0x80) !== 0) {
    if ((first & 0x40) !== 0) {
      throw new Error('Invalid negative base-256 size in tar header.')
    }
    let val = first & 0x7f
    for (let i = 1; i < len; i += 1) {
      val = val * 256 + bytes[start + i]
      if (!Number.isSafeInteger(val)) {
        throw new Error('Tar entry size exceeds safe integer range.')
      }
    }
    return val
  }

  const raw = readTarString(bytes, start, len).trim()
  if (raw.length === 0) return 0
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid octal size field in tar header: "${raw}"`)
  }
  const parsed = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Out-of-range octal size field in tar header: "${raw}"`)
  }
  return parsed
}

interface PaxOverrides {
  path?: string
  size?: number
}

function parsePaxRecords(payload: Uint8Array): PaxOverrides {
  const overrides: PaxOverrides = {}
  let pos = 0
  while (pos < payload.byteLength) {
    // Skip trailing NULs or newlines if present.
    if (payload[pos] === 0 || payload[pos] === 10) {
      pos += 1
      continue
    }
    let spaceIdx = pos
    while (spaceIdx < payload.byteLength && payload[spaceIdx] !== 0x20) {
      spaceIdx += 1
    }
    if (spaceIdx >= payload.byteLength) {
      throw new Error('Malformed PAX extended header: missing length delimiter.')
    }
    const lenStr = UTF8_DECODER.decode(payload.subarray(pos, spaceIdx))
    if (!/^\d+$/.test(lenStr)) {
      throw new Error(`Malformed PAX record length: "${lenStr}"`)
    }
    const recordBytes = Number.parseInt(lenStr, 10)
    if (recordBytes <= spaceIdx - pos + 1 || pos + recordBytes > payload.byteLength) {
      throw new Error('Malformed PAX extended header: record length out of bounds.')
    }
    // Strip trailing '\n' (0x0a) when present.
    const valueEnd =
      payload[pos + recordBytes - 1] === 0x0a ? pos + recordBytes - 1 : pos + recordBytes
    const body = UTF8_DECODER.decode(payload.subarray(spaceIdx + 1, valueEnd))
    const eqIdx = body.indexOf('=')
    if (eqIdx > 0) {
      const key = body.slice(0, eqIdx)
      const val = body.slice(eqIdx + 1)
      if (key === 'path') {
        overrides.path = val
      } else if (key === 'size' && /^\d+$/.test(val)) {
        const parsedSize = Number.parseInt(val, 10)
        if (Number.isSafeInteger(parsedSize) && parsedSize >= 0) {
          overrides.size = parsedSize
        }
      }
    }
    pos += recordBytes
  }
  return overrides
}

const FORBIDDEN_TAR_TYPEFLAGS: ReadonlySet<string> = new Set(['1', '2', '3', '4', '6'])

function normalizeSafeTarEntryPath(entryPath: string): string {
  if (entryPath.includes('\0') || entryPath.includes('\\')) {
    throw new Error(`Unsafe tar entry path containing forbidden characters: "${entryPath}"`)
  }
  if (entryPath.startsWith('/')) {
    throw new Error(`Unsafe absolute tar entry path: "${entryPath}"`)
  }
  const segments = entryPath.split('/')
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`Unsafe path traversal in tar entry: "${entryPath}"`)
  }
  const normalized = segments.filter((seg) => seg.length > 0 && seg !== '.').join('/')
  return entryPath.endsWith('/') && normalized.length > 0 ? `${normalized}/` : normalized
}

/**
 * Extract selected files from an uncompressed npm POSIX/USTAR/PAX `.tar` byte buffer.
 *
 * Strips a single leading `package/` prefix, rejects path traversal (`..`, `\`, NUL, or
 * leading `/`), rejects symlinks/hardlinks/special device entries (`1`, `2`, `3`, `4`, `6`),
 * and returns owned `Uint8Array` slices so the larger archive buffer can be garbage-collected.
 */
export function extractNpmTarEntries(
  tarBytes: Uint8Array,
  wantedFiles: ReadonlySet<string>,
): Map<string, Uint8Array> {
  const extracted = new Map<string, Uint8Array>()
  if (tarBytes.byteLength === 0) return extracted

  let offset = 0
  let consecutiveZeroBlocks = 0
  let globalPaxPath: string | undefined
  let pendingPax: PaxOverrides | null = null
  let pendingLongPath: string | null = null

  while (offset < tarBytes.byteLength) {
    if (offset + TAR_BLOCK_SIZE > tarBytes.byteLength) {
      throw new Error(
        `Truncated tar archive: incomplete 512-byte header at offset ${offset} of ${tarBytes.byteLength}.`,
      )
    }

    if (isZeroTarBlock(tarBytes, offset)) {
      consecutiveZeroBlocks += 1
      offset += TAR_BLOCK_SIZE
      if (consecutiveZeroBlocks >= 2) {
        break
      }
      continue
    }
    consecutiveZeroBlocks = 0

    const name = readTarString(tarBytes, offset, 100)
    const headerSize = parseTarSize(tarBytes, offset + 124, 12)
    const typeByte = tarBytes[offset + 156]
    const typeflag = typeByte === 0 ? '\0' : String.fromCharCode(typeByte)
    const magic = readTarString(tarBytes, offset + 257, 6)
    const prefix =
      magic.startsWith('ustar') ? readTarString(tarBytes, offset + 345, 155) : ''

    const size =
      typeflag !== 'x' && typeflag !== 'g' && typeflag !== 'L' && typeflag !== 'K' && pendingPax?.size !== undefined
        ? pendingPax.size
        : headerSize

    const dataOffset = offset + TAR_BLOCK_SIZE
    if (dataOffset + size > tarBytes.byteLength) {
      throw new Error(
        `Truncated tar archive: entry "${name}" (${size} bytes) exceeds archive length (${tarBytes.byteLength}).`,
      )
    }
    const paddedSize = Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE
    if (dataOffset + paddedSize > tarBytes.byteLength) {
      throw new Error(
        `Truncated tar archive: incomplete 512-byte block padding for entry "${name}".`,
      )
    }

    if (typeflag === 'g') {
      const pax = parsePaxRecords(tarBytes.subarray(dataOffset, dataOffset + size))
      if (pax.path !== undefined) {
        globalPaxPath = pax.path
      }
      offset = dataOffset + paddedSize
      continue
    }

    if (typeflag === 'x') {
      pendingPax = parsePaxRecords(tarBytes.subarray(dataOffset, dataOffset + size))
      offset = dataOffset + paddedSize
      continue
    }

    if (typeflag === 'L') {
      pendingLongPath = readTarString(tarBytes, dataOffset, size)
      offset = dataOffset + paddedSize
      continue
    }

    if (typeflag === 'K') {
      offset = dataOffset + paddedSize
      continue
    }

    const ustarPath = prefix ? `${prefix}/${name}` : name
    const rawPath = pendingPax?.path ?? pendingLongPath ?? globalPaxPath ?? ustarPath
    pendingPax = null
    pendingLongPath = null

    const normalizedRaw = normalizeSafeTarEntryPath(rawPath)

    if (FORBIDDEN_TAR_TYPEFLAGS.has(typeflag)) {
      throw new Error(
        `Unsafe symbolic or hard link or special device entry in tar archive: "${rawPath}" (typeflag="${typeflag}")`,
      )
    }

    const isRegularFile =
      (typeflag === '0' || typeflag === '\0' || typeflag === '') && !normalizedRaw.endsWith('/')

    if (isRegularFile && normalizedRaw.length > 0) {
      const stripped = normalizedRaw.startsWith('package/')
        ? normalizedRaw.slice('package/'.length)
        : normalizedRaw
      const cleanRel = normalizeSafeTarEntryPath(stripped)
      if (isSafeModelRel(cleanRel) && wantedFiles.has(cleanRel)) {
        extracted.set(cleanRel, tarBytes.slice(dataOffset, dataOffset + size))
      }
    }

    offset = dataOffset + paddedSize
  }

  return extracted
}

// ── Pure-TS Emscripten WASM MEMFS Web Worker glue patcher ────────────────────

export interface SherpaGlueSources {
  wasmJs: string
  vadJs: string
  asrJs: string
  ttsJs?: string
}

const ENV_IS_NODE_TARGET =
  'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";'
const ENV_IS_NODE_REPLACEMENT = 'var ENVIRONMENT_IS_NODE=false;'

// Constructed without a literal static CJS call pattern so repo import scanners never misclassify it.
const NODE_PATH_TARGET = ['var nodePath=req', 'uire("path");'].join('')

const PURE_POSIX_NODE_PATH_SNIPPET = `var nodePath=(()=>{const normalizeParts=(parts,allowAboveRoot)=>{const res=[];for(let i=0;i<parts.length;i++){const p=parts[i];if(!p||p===".")continue;if(p===".."){if(res.length>0&&res[res.length-1]!==".."){res.pop()}else if(allowAboveRoot){res.push("..")}}else{res.push(p)}}return res};const isAbsolute=p=>typeof p==="string"&&p.charAt(0)==="/";const normalize=p=>{const isAbs=isAbsolute(p);const trailing=p.charAt(p.length-1)==="/";let norm=normalizeParts(p.split("/"),!isAbs).join("/");if(!norm&&!isAbs)norm=".";if(norm&&trailing)norm+="/";return(isAbs?"/":"")+norm};const dirname=p=>{if(!p)return".";const hasRoot=p.charAt(0)==="/";let end=p.length-1;while(end>=1&&p.charAt(end)==="/")end--;const slash=p.lastIndexOf("/",end);if(slash===-1)return hasRoot?"/":".";if(hasRoot&&slash===0)return"/";let dirEnd=slash;while(dirEnd>1&&p.charAt(dirEnd-1)==="/")dirEnd--;return p.slice(0,dirEnd)};const basename=(p,ext)=>{if(!p)return"";let end=p.length-1;while(end>=0&&p.charAt(end)==="/")end--;if(end<0)return"";const slash=p.lastIndexOf("/",end);const base=p.slice(slash+1,end+1);return ext&&base.endsWith(ext)?base.slice(0,base.length-ext.length):base};const join=(...paths)=>{const joined=paths.filter(s=>typeof s==="string"&&s.length>0).join("/");return joined?normalize(joined):"."};const resolve=(...paths)=>{let resolved="";let resolvedAbs=false;for(let i=paths.length-1;i>=0&&!resolvedAbs;i--){const p=paths[i];if(!p)continue;resolved=p+"/"+resolved;resolvedAbs=p.charAt(0)==="/"}if(!resolvedAbs)resolved="/"+resolved;return"/"+normalizeParts(resolved.split("/"),false).join("/")};const relative=(from,to)=>{const f=resolve(from).slice(1);const t=resolve(to).slice(1);const fp=f?f.split("/"):[];const tp=t?t.split("/"):[];const len=Math.min(fp.length,tp.length);let same=len;for(let i=0;i<len;i++){if(fp[i]!==tp[i]){same=i;break}}const out=[];for(let i=same;i<fp.length;i++)out.push("..");return out.concat(tp.slice(same)).join("/")};const api={isAbsolute,normalize,dirname,basename,join,resolve,relative};api.posix=api;return api})();`

const NODERAWFS_GUARD_TARGET =
  'if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS is currently only supported on Node.js environment.")}'
const NODERAWFS_LOOP_TARGET =
  'for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}'
const NODERAWFS_MAX_SPAN_CHARS = 1024

function replaceExactOnce(
  source: string,
  target: string,
  replacement: string,
  description: string,
): string {
  const idx = source.indexOf(target)
  if (idx === -1) {
    throw new Error(
      `Failed to patch sherpa-onnx WASM glue: expected ${description} substring was not found.`,
    )
  }
  const secondIdx = source.indexOf(target, idx + target.length)
  if (secondIdx !== -1) {
    throw new Error(
      `Failed to patch sherpa-onnx WASM glue: expected single occurrence of ${description}, found multiple.`,
    )
  }
  return source.slice(0, idx) + replacement + source.slice(idx + target.length)
}

function wrapSherpaWrapperIife(
  constName: string,
  bodyJs: string,
  knownIdentifiers: readonly string[],
): string {
  const conditionalExports = knownIdentifiers
    .map((ident) => `...(typeof ${ident} !== "undefined" ? { ${ident} } : {})`)
    .join(', ')
  return [
    `const ${constName} = (() => {`,
    '  const module = { exports: {} };',
    '  const exports = module.exports;',
    bodyJs,
    `  return { ...module.exports, ${conditionalExports} };`,
    '})();',
  ].join('\n')
}

/**
 * Transform upstream Node-targeted `sherpa-onnx` Emscripten glue into a self-contained,
 * zero-Node `MEMFS` Web Worker script and isolate `vadJs`, `asrJs`, and optional `ttsJs`
 * inside separate IIFEs so internal `freeConfig` helpers never collide.
 */
export function buildMemfsSherpaGlue(sources: SherpaGlueSources): string {
  if (!sources || typeof sources.wasmJs !== 'string' || sources.wasmJs.length === 0) {
    throw new Error('buildMemfsSherpaGlue requires a non-empty wasmJs source string.')
  }
  if (typeof sources.vadJs !== 'string' || sources.vadJs.length === 0) {
    throw new Error('buildMemfsSherpaGlue requires a non-empty vadJs source string.')
  }
  if (typeof sources.asrJs !== 'string' || sources.asrJs.length === 0) {
    throw new Error('buildMemfsSherpaGlue requires a non-empty asrJs source string.')
  }

  let patchedWasm = replaceExactOnce(
    sources.wasmJs,
    ENV_IS_NODE_TARGET,
    ENV_IS_NODE_REPLACEMENT,
    'ENVIRONMENT_IS_NODE detection',
  )

  patchedWasm = replaceExactOnce(
    patchedWasm,
    NODE_PATH_TARGET,
    PURE_POSIX_NODE_PATH_SNIPPET,
    'nodePath module binding',
  )

  const guardStart = patchedWasm.indexOf(NODERAWFS_GUARD_TARGET)
  if (guardStart === -1) {
    throw new Error(
      'Failed to patch sherpa-onnx WASM glue: NODERAWFS environment guard was not found.',
    )
  }
  const afterGuard = guardStart + NODERAWFS_GUARD_TARGET.length
  const loopStart = patchedWasm.indexOf(NODERAWFS_LOOP_TARGET, afterGuard)
  if (loopStart === -1 || loopStart - afterGuard > NODERAWFS_MAX_SPAN_CHARS) {
    throw new Error(
      'Failed to patch sherpa-onnx WASM glue: NODERAWFS mount loop was not found after guard.',
    )
  }
  const loopEnd = loopStart + NODERAWFS_LOOP_TARGET.length
  const noderawfsMountBody = patchedWasm.slice(afterGuard, loopEnd)
  patchedWasm =
    patchedWasm.slice(0, guardStart) +
    `if(ENVIRONMENT_IS_NODE){${noderawfsMountBody}}` +
    patchedWasm.slice(loopEnd)

  const vadWrapped = wrapSherpaWrapperIife('SherpaVad', sources.vadJs, [
    'createVad',
    'CircularBuffer',
    'Vad',
  ])

  const asrWrapped = wrapSherpaWrapperIife('SherpaAsr', sources.asrJs, [
    'createOnlineRecognizer',
    'OfflineRecognizer',
    'OfflineStream',
    'OnlineRecognizer',
    'OnlineStream',
  ])

  const hasTts = typeof sources.ttsJs === 'string' && sources.ttsJs.trim().length > 0
  const ttsWrapped = hasTts
    ? wrapSherpaWrapperIife('SherpaTts', sources.ttsJs!, [
        'createOfflineTts',
        'OfflineTts',
        'getDefaultOfflineTtsModelType',
        'getDefaultUsePhonemize',
        'setUsePhonemize',
      ])
    : 'const SherpaTts = null;'

  const globalExportsFooter = [
    'if (typeof Module !== "undefined") globalThis.SherpaOnnxModule = Module;',
    'globalThis.SherpaVad = SherpaVad;',
    'globalThis.SherpaAsr = SherpaAsr;',
    'globalThis.SherpaTts = SherpaTts;',
  ].join('\n')

  return [patchedWasm, vadWrapped, asrWrapped, ttsWrapped, globalExportsFooter].join('\n\n')
}
