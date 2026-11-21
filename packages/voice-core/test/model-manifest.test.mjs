import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import {
  WASM_HOST_PRIMARY,
  WASM_HOST_FALLBACK,
  ALLOWED_WASM_HOSTNAMES,
  SHERPA_WASM_RUNTIME_202,
  LOCAL_MODEL_BUNDLE_IDS,
  MODEL_BUNDLES,
  wasmRedirectHostAllowed,
  resolveModelFileUrls,
  resolveWasmTarballUrls,
  extractNpmTarEntries,
  buildMemfsSherpaGlue,
} from '../src/index.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function writeAsciiField(buf, offset, maxLen, text) {
  const bytes = ENCODER.encode(text)
  buf.set(bytes.subarray(0, maxLen), offset)
}

function makeTarHeader({ name, size, typeflag = '0', prefix = '', ustar = true }) {
  const header = new Uint8Array(512)
  writeAsciiField(header, 0, 100, name)
  writeAsciiField(header, 100, 8, '0000644\0')
  writeAsciiField(header, 108, 8, '0000000\0')
  writeAsciiField(header, 116, 8, '0000000\0')
  writeAsciiField(header, 124, 12, `${size.toString(8).padStart(11, '0')}\0`)
  writeAsciiField(header, 136, 12, '00000000000\0')
  // Fill chksum with spaces before computing sum.
  header.fill(0x20, 148, 156)
  header[156] = typeflag === '\0' ? 0 : typeflag.charCodeAt(0)
  if (ustar) {
    writeAsciiField(header, 257, 6, 'ustar\0')
    writeAsciiField(header, 263, 2, '00')
    if (prefix) {
      writeAsciiField(header, 345, 155, prefix)
    }
  }
  let sum = 0
  for (let i = 0; i < 512; i += 1) sum += header[i]
  writeAsciiField(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `)
  return header
}

function buildPaxRecord(key, value) {
  const suffix = ` ${key}=${value}\n`
  const suffixLen = ENCODER.encode(suffix).byteLength
  let total = suffixLen + String(suffixLen).length
  while (String(total).length + suffixLen !== total) {
    total = suffixLen + String(total).length
  }
  return ENCODER.encode(`${total}${suffix}`)
}

function buildTarArchive(entries, { trailingZeroBlocks = 2 } = {}) {
  const chunks = []
  for (const entry of entries) {
    const payload =
      entry.data instanceof Uint8Array ? entry.data : ENCODER.encode(entry.data ?? '')
    const header = makeTarHeader({
      name: entry.name,
      size: entry.declaredSize ?? payload.byteLength,
      typeflag: entry.typeflag ?? '0',
      prefix: entry.prefix ?? '',
      ustar: entry.ustar ?? true,
    })
    chunks.push(header)
    if (payload.byteLength > 0) {
      chunks.push(payload)
      const rem = payload.byteLength % 512
      if (rem !== 0) {
        chunks.push(new Uint8Array(512 - rem))
      }
    }
  }
  for (let i = 0; i < trailingZeroBlocks; i += 1) {
    chunks.push(new Uint8Array(512))
  }
  const totalBytes = chunks.reduce((acc, c) => acc + c.byteLength, 0)
  const out = new Uint8Array(totalBytes)
  let pos = 0
  for (const c of chunks) {
    out.set(c, pos)
    pos += c.byteLength
  }
  return out
}

const SYNTHETIC_WASM_JS = [
  'var Module=(()=>{return async function(moduleArg={}){',
  'var Module=moduleArg;',
  'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";',
  'var nodePath=require("path");',
  'var PATH={isAbs:nodePath.isAbsolute,normalize:nodePath.normalize,dirname:nodePath.dirname,basename:nodePath.basename,join:nodePath.join,join2:nodePath.join};',
  'var FS={cwd:()=>"/",memMounted:true};',
  'var PATH_FS={resolve:(...paths)=>{paths.unshift(FS.cwd());return nodePath.posix.resolve(...paths)},relative:(from,to)=>nodePath.posix.relative(from||FS.cwd(),to||FS.cwd())};',
  'var NODERAWFS={memMounted:false};',
  'if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS is currently only supported on Node.js environment.")}var _wrapNodeError=function(func){return func};var VFS={...FS};for(var _key in NODERAWFS){FS[_key]=_wrapNodeError(NODERAWFS[_key])}',
  'Module.ENVIRONMENT_IS_NODE=ENVIRONMENT_IS_NODE;',
  'Module.PATH=PATH;',
  'Module.PATH_FS=PATH_FS;',
  'Module.FS=FS;',
  'return Module;',
  '}})();',
].join('')

describe('model-manifest: pinned specs, SHA256 formats, and host/mirror URL helpers', () => {
  it('exposes pinned sherpa-onnx@2.0.2 WASM runtime and all 3 local model bundles with valid 64-hex SHA256s', () => {
    const shaRe = /^[0-9a-f]{64}$/
    assert.equal(SHERPA_WASM_RUNTIME_202.version, '2.0.2')
    assert.equal(SHERPA_WASM_RUNTIME_202.cacheSubdir, 'wasm/sherpa-onnx-2.0.2')
    assert.equal(SHERPA_WASM_RUNTIME_202.tarballPath, '/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz')
    assert.match(SHERPA_WASM_RUNTIME_202.tarballSha256, shaRe)
    assert.equal(SHERPA_WASM_RUNTIME_202.license, 'Apache-2.0')
    assert.equal(SHERPA_WASM_RUNTIME_202.files.length, 5)
    for (const file of SHERPA_WASM_RUNTIME_202.files) {
      assert.match(file.sha256, shaRe)
      assert.ok(typeof file.bytes === 'number' && file.bytes > 0)
    }

    assert.deepEqual(LOCAL_MODEL_BUNDLE_IDS, ['silero-vad', 'sensevoice-int8', 'vits-zh-ll'])
    assert.equal(MODEL_BUNDLES['silero-vad'].files.length, 1)
    assert.equal(MODEL_BUNDLES['sensevoice-int8'].files.length, 2)
    assert.equal(MODEL_BUNDLES['vits-zh-ll'].files.length, 7)

    for (const id of LOCAL_MODEL_BUNDLE_IDS) {
      const bundle = MODEL_BUNDLES[id]
      assert.equal(bundle.id, id)
      assert.match(bundle.revision, /^[0-9a-f]{40}$/)
      assert.ok(bundle.totalBytes > 0)
      for (const f of bundle.files) {
        assert.match(f.sha256, shaRe)
        assert.equal(f.revision, bundle.revision)
      }
    }
  })

  it('validates WASM redirect host allowlist and rejects HTTP, credentials, and lookalike domains', () => {
    assert.deepEqual(ALLOWED_WASM_HOSTNAMES, [
      'registry.npmjs.org',
      'registry.npmmirror.com',
      'cdn.npmmirror.com',
    ])
    assert.equal(
      wasmRedirectHostAllowed('https://registry.npmjs.org/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz'),
      true,
    )
    assert.equal(
      wasmRedirectHostAllowed('https://cdn.npmmirror.com/packages/sherpa-onnx/2.0.2/sherpa-onnx-2.0.2.tgz'),
      true,
    )
    assert.equal(
      wasmRedirectHostAllowed('https://files.cdn.npmmirror.com/packages/sherpa-onnx.tgz'),
      true,
    )
    assert.equal(
      wasmRedirectHostAllowed('http://registry.npmjs.org/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz'),
      false,
    )
    assert.equal(
      wasmRedirectHostAllowed('https://token:secret@registry.npmjs.org/sherpa-onnx.tgz'),
      false,
    )
    assert.equal(wasmRedirectHostAllowed('https://evil-registry.npmjs.org/pkg.tgz'), false)
    assert.equal(wasmRedirectHostAllowed('https://registry.npmjs.org.attacker.example/pkg.tgz'), false)
    assert.equal(wasmRedirectHostAllowed('https://mirror.corp.internal/pkg.tgz', false), false)
    assert.equal(wasmRedirectHostAllowed('https://mirror.corp.internal/pkg.tgz', true), true)
    assert.equal(wasmRedirectHostAllowed('http://mirror.corp.internal/pkg.tgz', true), false)
    assert.equal(wasmRedirectHostAllowed('not a valid url'), false)
  })

  it('orders and deduplicates model file URLs and WASM tarball URLs based on mirror preference', () => {
    const vadSpec = MODEL_BUNDLES['silero-vad'].files[0]
    assert.deepEqual(resolveModelFileUrls('csukuangfj/vad', vadSpec), [
      `https://huggingface.co/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
      `https://hf-mirror.com/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
    ])

    assert.deepEqual(resolveModelFileUrls('csukuangfj/vad', vadSpec, 'https://hf-mirror.com/'), [
      `https://hf-mirror.com/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
      `https://huggingface.co/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
    ])

    // Invalid or unallowlisted preferred host falls back cleanly to primary -> fallback.
    assert.deepEqual(resolveModelFileUrls('csukuangfj/vad', vadSpec, 'http://evil.example'), [
      `https://huggingface.co/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
      `https://hf-mirror.com/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
    ])

    // Custom enterprise mirror allowed only when allowCustomHost = true.
    assert.deepEqual(
      resolveModelFileUrls('csukuangfj/vad', vadSpec, 'https://models.corp.internal', true),
      [
        `https://models.corp.internal/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
        `https://huggingface.co/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
        `https://hf-mirror.com/csukuangfj/vad/resolve/${vadSpec.revision}/silero_vad.onnx`,
      ],
    )

    // Encodes nested path segments and defaults missing revision to main.
    assert.deepEqual(
      resolveModelFileUrls('owner/model', { file: 'sub dir/weights v1.onnx', sha256: '0'.repeat(64) }),
      [
        'https://huggingface.co/owner/model/resolve/main/sub%20dir/weights%20v1.onnx',
        'https://hf-mirror.com/owner/model/resolve/main/sub%20dir/weights%20v1.onnx',
      ],
    )

    assert.throws(() =>
      resolveModelFileUrls('csukuangfj/vad', { file: '../etc/passwd', sha256: '0'.repeat(64) }),
    )
    assert.throws(() => resolveModelFileUrls('../bad', vadSpec))

    assert.deepEqual(resolveWasmTarballUrls(), [
      `${WASM_HOST_PRIMARY}/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz`,
      `${WASM_HOST_FALLBACK}/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz`,
    ])
    assert.deepEqual(resolveWasmTarballUrls('https://hf-mirror.com'), [
      `${WASM_HOST_FALLBACK}/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz`,
      `${WASM_HOST_PRIMARY}/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz`,
    ])
  })
})

describe('model-manifest: extractNpmTarEntries POSIX / USTAR / PAX tar parser', () => {
  it('extracts wanted regular files, strips a single package/ prefix, handles USTAR prefix + PAX headers, and returns owned buffers', () => {
    const paxData = new Uint8Array([
      ...buildPaxRecord('mtime', '1700000000'),
      ...buildPaxRecord('path', 'package/sherpa-onnx-vad.js'),
    ])
    const globalPax = buildPaxRecord('comment', 'deadbeefcafebabe')

    const tar = buildTarArchive([
      { name: 'pax_global_header', typeflag: 'g', data: globalPax },
      { name: 'package/', typeflag: '5', data: '' },
      { name: 'package/README.md', typeflag: '0', data: 'unwanted readme' },
      { name: 'sherpa-onnx-asr.js', prefix: 'package', typeflag: '0', data: 'ASR_CODE' },
      { name: 'PaxHeader/vad', typeflag: 'x', data: paxData },
      { name: 'package/truncated-name-overridden-by-pax', typeflag: '0', data: 'VAD_CODE' },
      { name: './package/sherpa-onnx-tts.js', typeflag: '\0', data: 'TTS_CODE' },
      { name: 'package/package/sherpa-onnx-vad.js', typeflag: '0', data: 'NESTED_NOT_WANTED' },
    ])

    const wanted = new Set([
      'sherpa-onnx-asr.js',
      'sherpa-onnx-vad.js',
      'sherpa-onnx-tts.js',
      'sherpa-onnx-wasm-nodejs.js',
    ])
    const out = extractNpmTarEntries(tar, wanted)

    assert.equal(out.size, 3)
    assert.equal(DECODER.decode(out.get('sherpa-onnx-asr.js')), 'ASR_CODE')
    assert.equal(DECODER.decode(out.get('sherpa-onnx-vad.js')), 'VAD_CODE')
    assert.equal(DECODER.decode(out.get('sherpa-onnx-tts.js')), 'TTS_CODE')
    assert.equal(out.has('sherpa-onnx-wasm-nodejs.js'), false)

    // Verify owned Uint8Array copy (not sharing backing ArrayBuffer with tar).
    for (const buf of out.values()) {
      assert.notEqual(buf.buffer, tar.buffer)
      assert.equal(buf.byteOffset, 0)
      assert.equal(buf.buffer.byteLength, buf.byteLength)
    }

    // Forbidden link & special device entry types ('1', '2', '3', '4', '6') must throw explicitly.
    for (const forbiddenType of ['1', '2', '3', '4', '6']) {
      const linkTar = buildTarArchive([
        { name: 'package/sherpa-onnx-wasm-nodejs.js', typeflag: forbiddenType, data: '' },
      ])
      assert.throws(() => extractNpmTarEntries(linkTar, wanted), /symbolic or hard link|special device/i)
    }
  })

  it('rejects path traversal, backslashes, absolute paths, and truncated archives', () => {
    const wanted = new Set(['sherpa-onnx-vad.js', 'evil.js'])

    for (const badName of [
      'package/../evil.js',
      '../sherpa-onnx-vad.js',
      'package\\sherpa-onnx-vad.js',
      '/etc/passwd',
    ]) {
      const badTar = buildTarArchive([{ name: badName, data: 'x' }])
      assert.throws(() => extractNpmTarEntries(badTar, wanted), /Unsafe/)
    }

    // PAX path traversal must also be caught.
    const paxTraversal = buildTarArchive([
      { name: 'PaxHeader/x', typeflag: 'x', data: buildPaxRecord('path', 'package/../../evil.js') },
      { name: 'package/sherpa-onnx-vad.js', data: 'x' },
    ])
    assert.throws(() => extractNpmTarEntries(paxTraversal, wanted), /Unsafe/)

    // Truncated header (< 512 bytes).
    assert.throws(() => extractNpmTarEntries(new Uint8Array(128), wanted), /Truncated tar archive/)

    // Truncated file payload (declared 2048 bytes, actual archive cut off mid-payload).
    const validTar = buildTarArchive(
      [{ name: 'package/sherpa-onnx-vad.js', data: new Uint8Array(2048).fill(0x41) }],
      { trailingZeroBlocks: 0 },
    )
    assert.throws(
      () => extractNpmTarEntries(validTar.subarray(0, 512 + 600), wanted),
      /Truncated tar archive/,
    )
  })

  it('handles empty archives, GNU LongLink (type L), base-256 sizes, and 10240-byte zero padding', () => {
    assert.equal(extractNpmTarEntries(new Uint8Array(0), new Set(['a'])).size, 0)

    const longTar = buildTarArchive(
      [
        {
          name: '././@LongLink',
          typeflag: 'L',
          data: 'package/deep/nested/target-file.txt\0',
        },
        { name: 'package/truncated', typeflag: '0', data: 'LONGLINK_OK' },
      ],
      { trailingZeroBlocks: 6 },
    )
    const extractedLong = extractNpmTarEntries(longTar, new Set(['deep/nested/target-file.txt']))
    assert.equal(DECODER.decode(extractedLong.get('deep/nested/target-file.txt')), 'LONGLINK_OK')

    // Base-256 binary size field (0x80 marker on first size byte).
    const base256Tar = buildTarArchive([{ name: 'package/bin.dat', data: 'ABCD' }])
    base256Tar.fill(0, 124, 136)
    base256Tar[124] = 0x80
    base256Tar[135] = 4
    const extractedBin = extractNpmTarEntries(base256Tar, new Set(['bin.dat']))
    assert.equal(DECODER.decode(extractedBin.get('bin.dat')), 'ABCD')
  })
})

describe('model-manifest: buildMemfsSherpaGlue & source hygiene', () => {
  it('patches synthetic wasmJs, preserves MEMFS, provides pure POSIX path helpers, and isolates freeConfig across IIFEs', async () => {
    const glue = buildMemfsSherpaGlue({
      wasmJs: SYNTHETIC_WASM_JS,
      vadJs: 'function freeConfig() { return "vad-free"; }\nfunction createVad() { return freeConfig(); }',
      asrJs: 'function freeConfig() { return "asr-free"; }\nclass OfflineRecognizer { check() { return freeConfig(); } }',
      ttsJs: 'function freeConfig() { return "tts-free"; }\nfunction createOfflineTts() { return freeConfig(); }',
    })

    assert.ok(glue.includes('var ENVIRONMENT_IS_NODE=false;'))
    assert.ok(!glue.includes('require("path")'))
    assert.ok(!glue.includes('if(!ENVIRONMENT_IS_NODE){throw new Error("NODERAWFS'))
    assert.ok(glue.includes('const SherpaVad = (() => {'))
    assert.ok(glue.includes('const SherpaAsr = (() => {'))
    assert.ok(glue.includes('const SherpaTts = (() => {'))

    const sandbox = {
      TextDecoder,
      TextEncoder,
      Uint8Array,
      Float32Array,
      URL,
      console,
    }
    sandbox.globalThis = sandbox
    vm.runInNewContext(glue, sandbox)

    const mod = await sandbox.SherpaOnnxModule({})
    assert.equal(mod.ENVIRONMENT_IS_NODE, false)
    assert.equal(mod.FS.memMounted, true)
    assert.equal(mod.PATH.isAbs('/models/silero_vad.onnx'), true)
    assert.equal(mod.PATH.isAbs('relative.onnx'), false)
    assert.equal(mod.PATH.dirname('/models/silero_vad.onnx'), '/models')
    assert.equal(mod.PATH.dirname('/'), '/')
    assert.equal(mod.PATH.basename('/models/silero_vad.onnx'), 'silero_vad.onnx')
    assert.equal(mod.PATH.basename('/'), '')
    assert.equal(mod.PATH.join('/models', 'sub/../tokens.txt'), '/models/tokens.txt')
    assert.equal(mod.PATH_FS.resolve('models', 'model.int8.onnx'), '/models/model.int8.onnx')
    assert.equal(mod.PATH_FS.relative('/models/a', '/models/b/c'), '../b/c')

    assert.equal(sandbox.SherpaVad.createVad(), 'vad-free')
    assert.equal(new sandbox.SherpaAsr.OfflineRecognizer().check(), 'asr-free')
    assert.equal(sandbox.SherpaTts.createOfflineTts(), 'tts-free')

    // Optional ttsJs omitted -> SherpaTts is null without ReferenceError.
    const noTtsGlue = buildMemfsSherpaGlue({
      wasmJs: SYNTHETIC_WASM_JS,
      vadJs: 'function createVad() { return 1; }',
      asrJs: 'function createOnlineRecognizer() { return 2; }',
    })
    const sandbox2 = {}
    sandbox2.globalThis = sandbox2
    vm.runInNewContext(noTtsGlue, sandbox2)
    assert.equal(sandbox2.SherpaTts, null)

    // Throws descriptive Error if any expected patch target is missing.
    assert.throws(
      () => buildMemfsSherpaGlue({ wasmJs: 'var broken = true;', vadJs: '1', asrJs: '1' }),
      /ENVIRONMENT_IS_NODE/,
    )
    assert.throws(
      () =>
        buildMemfsSherpaGlue({
          wasmJs:
            'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";',
          vadJs: '1',
          asrJs: '1',
        }),
      /nodePath/,
    )
    assert.throws(
      () =>
        buildMemfsSherpaGlue({
          wasmJs: [
            'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";',
            'var nodePath=require("path");',
          ].join(''),
          vadJs: '1',
          asrJs: '1',
        }),
      /NODERAWFS/,
    )
  })

  it('verifies cached real sherpa-onnx@2.0.2 WASM & JS files in zero-Node Worker sandbox when cache is present', async (t) => {
    const cacheDir = path.join(os.homedir(), '.cache', 'voice-mode', 'models', 'wasm', 'sherpa-onnx-2.0.2')
    if (!fs.existsSync(cacheDir)) {
      t.skip('Local sherpa-onnx-2.0.2 cache not present on this machine')
      return
    }

    for (const spec of SHERPA_WASM_RUNTIME_202.files) {
      const fullPath = path.join(cacheDir, spec.file)
      const bytes = fs.readFileSync(fullPath)
      assert.equal(bytes.byteLength, spec.bytes, `Byte size mismatch for ${spec.file}`)
      const digest = crypto.createHash('sha256').update(bytes).digest('hex')
      assert.equal(digest, spec.sha256, `SHA256 mismatch for ${spec.file}`)
    }

    const wasmJs = fs.readFileSync(path.join(cacheDir, 'sherpa-onnx-wasm-nodejs.js'), 'utf8')
    const vadJs = fs.readFileSync(path.join(cacheDir, 'sherpa-onnx-vad.js'), 'utf8')
    const asrJs = fs.readFileSync(path.join(cacheDir, 'sherpa-onnx-asr.js'), 'utf8')
    const ttsJs = fs.readFileSync(path.join(cacheDir, 'sherpa-onnx-tts.js'), 'utf8')
    const wasmBinary = new Uint8Array(
      fs.readFileSync(path.join(cacheDir, 'sherpa-onnx-wasm-nodejs.wasm')),
    )

    const glue = buildMemfsSherpaGlue({ wasmJs, vadJs, asrJs, ttsJs })

    const workerSandbox = {
      WebAssembly,
      ArrayBuffer,
      SharedArrayBuffer,
      DataView,
      Int8Array,
      Uint8Array,
      Uint8ClampedArray,
      Int16Array,
      Uint16Array,
      Int32Array,
      Uint32Array,
      Float32Array,
      Float64Array,
      BigInt64Array,
      BigUint64Array,
      TextDecoder,
      TextEncoder,
      URL,
      Math,
      Date,
      performance,
      crypto: globalThis.crypto,
      console,
      setTimeout,
      clearTimeout,
    }
    workerSandbox.globalThis = workerSandbox
    workerSandbox.self = workerSandbox

    vm.runInNewContext(glue, workerSandbox)

    assert.equal(typeof workerSandbox.SherpaVad.createVad, 'function')
    assert.equal(typeof workerSandbox.SherpaAsr.OfflineRecognizer, 'function')
    assert.equal(typeof workerSandbox.SherpaTts.createOfflineTts, 'function')

    const mod = await workerSandbox.SherpaOnnxModule({ wasmBinary })
    mod.FS.writeFile('/memfs-probe.bin', new Uint8Array([9, 8, 7, 6]))
    const readBack = mod.FS.readFile('/memfs-probe.bin')
    assert.deepEqual(Array.from(readBack), [9, 8, 7, 6])
    mod.FS.unlink('/memfs-probe.bin')
  })

  it('contains zero regex lookbehinds across all @voice-mode/core source files', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url))
    const entries = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
    assert.ok(entries.includes('model-manifest.ts'))
    const lookbehindMarkers = ['(?<=', '(?<!']
    for (const file of entries) {
      const content = fs.readFileSync(path.join(srcDir, file), 'utf8')
      for (const marker of lookbehindMarkers) {
        assert.equal(
          content.includes(marker),
          false,
          `Forbidden regex lookbehind ${marker} found in ${file}`,
        )
      }
    }
  })
})
