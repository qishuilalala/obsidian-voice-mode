import {
  ALLOWED_WASM_HOSTNAMES,
  MODEL_BUNDLES,
  MODEL_HOST_FALLBACK,
  MODEL_HOST_PRIMARY,
  SHERPA_WASM_RUNTIME_202,
  WASM_HOST_FALLBACK,
  WASM_HOST_PRIMARY,
  extractNpmTarEntries,
  isSafeModelRel,
  redactSecrets,
  redirectHostAllowed,
  validateModelHost,
  wasmRedirectHostAllowed,
  type ModelFileSpec,
} from "@voice-mode/core";
import type { WorkerModelBinary } from "@voice-mode/browser";
import {
  assertPathOutsideVault,
  computeBytesSha256,
  computeFileSha256,
  createDesktopFsAdapter,
  readFileAsArrayBuffer,
  resolveExternalModelCacheDir,
  selectPathOps,
  type DesktopFileHandle,
  type DesktopFileStat,
  type DesktopFsAdapter,
  type DesktopHttpsModule,
} from "./desktop-fs.ts";

export interface ModelDownloadBundleSpec {
  readonly id: string;
  readonly label: string;
  readonly repo: string;
  readonly revision: string;
  readonly license: string;
  readonly files: readonly ModelFileSpec[];
}

export interface WasmExtractedFileSpec {
  readonly file: string;
  readonly sha256: string;
  readonly bytes?: number;
}

export interface WasmTarballSpec {
  readonly id: string;
  readonly version: string;
  readonly tarballPath: string;
  readonly sha256: string;
  readonly bytes?: number;
  readonly primaryHost: string;
  readonly fallbackHost: string;
  readonly allowedHosts: readonly string[];
  readonly license: string;
  readonly files: readonly WasmExtractedFileSpec[];
}

export const WASM_ALLOWED_HOSTNAMES = ALLOWED_WASM_HOSTNAMES;

export const VAD_MODEL_BUNDLE: Readonly<ModelDownloadBundleSpec> = MODEL_BUNDLES["silero-vad"];

export const SENSEVOICE_MODEL_BUNDLE: Readonly<ModelDownloadBundleSpec> =
  MODEL_BUNDLES["sensevoice-int8"];

export const SHERPA_WASM_TARBALL: Readonly<WasmTarballSpec> = {
  id: `sherpa-onnx-${SHERPA_WASM_RUNTIME_202.version}`,
  version: SHERPA_WASM_RUNTIME_202.version,
  tarballPath: SHERPA_WASM_RUNTIME_202.tarballPath,
  sha256: SHERPA_WASM_RUNTIME_202.tarballSha256,
  bytes: SHERPA_WASM_RUNTIME_202.tarballBytes,
  primaryHost: WASM_HOST_PRIMARY,
  fallbackHost: WASM_HOST_FALLBACK,
  allowedHosts: ALLOWED_WASM_HOSTNAMES,
  license: SHERPA_WASM_RUNTIME_202.license,
  files: SHERPA_WASM_RUNTIME_202.files,
};

export const MANAGED_MODEL_SUBDIRS = [
  MODEL_BUNDLES["silero-vad"].repo,
  MODEL_BUNDLES["sensevoice-int8"].repo,
  MODEL_BUNDLES["vits-zh-ll"].repo,
  SHERPA_WASM_RUNTIME_202.cacheSubdir,
] as const;

const VERIFICATION_INDEX_FILENAME = "verified-sha256-v1.json";
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_HEADERS_TIMEOUT_MS = 30_000;
const DEFAULT_CHUNK_IDLE_TIMEOUT_MS = 60_000;
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const CONTENT_RANGE_START_RE = /^bytes\s+(\d+)-\d+\/(?:\d+|\*)$/i;

export type LocalBinaryTarget = "vad" | "asr-offline" | "tts-vits";

export interface HttpStreamRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface HttpStreamResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  destroy?(error?: Error): void;
}

export type HttpStreamFetch = (request: HttpStreamRequest) => Promise<HttpStreamResponse>;

export interface ModelDownloadProgress {
  readonly phase: "downloading" | "verifying" | "extracting" | "complete";
  readonly bundleId: string;
  readonly file: string;
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
  readonly overallDownloadedBytes: number;
  readonly overallTotalBytes: number;
  readonly host: string;
  readonly percent: number | null;
}

export interface DownloadDictationStackOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ModelDownloadProgress) => void;
}

export interface VerifiedAssetRecord {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface DictationStackStatus {
  readonly cacheDir: string;
  readonly ready: boolean;
  readonly vadReady: boolean;
  readonly senseVoiceReady: boolean;
  readonly wasmReady: boolean;
  readonly verifiedFiles: readonly VerifiedAssetRecord[];
  readonly missingOrCorruptFiles: readonly string[];
  readonly totalVerifiedBytes: number;
  readonly elapsedMs: number;
}

export interface WasmGlueTexts {
  readonly wasmBinaryPath: string;
  readonly wasmJs: string;
  readonly asrJs: string;
  readonly vadJs: string;
  readonly ttsJs: string;
}

export interface LoadedDictationAssets {
  readonly glue: WasmGlueTexts;
  readonly wasmBinary: ArrayBuffer;
  readonly vadBinaries: WorkerModelBinary[];
  readonly asrBinaries: WorkerModelBinary[];
}

export interface DesktopModelManagerOptions {
  readonly customCacheDir?: string;
  readonly vaultBasePath?: string | null;
  readonly preferredModelHost?: string;
  readonly preferredWasmHost?: string;
  readonly vadBundle?: ModelDownloadBundleSpec;
  readonly senseVoiceBundle?: ModelDownloadBundleSpec;
  readonly vitsBundle?: ModelDownloadBundleSpec | null;
  readonly wasmTarball?: WasmTarballSpec;
  readonly adapter?: DesktopFsAdapter;
  readonly httpStreamFetch?: HttpStreamFetch;
  readonly maxRedirects?: number;
  readonly headersTimeoutMs?: number;
  readonly chunkIdleTimeoutMs?: number;
}

class SecurityRedirectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecurityRedirectError";
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const err = new Error("Model download was cancelled.");
  err.name = "AbortError";
  return err;
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Validate a WASM tarball host or redirect target against HTTPS, credential-free URLs,
 * and the explicit npm registry / mirror host allowlist.
 */
export function isWasmRedirectHostAllowed(
  rawUrl: string,
  allowedHosts: readonly string[] = WASM_ALLOWED_HOSTNAMES,
): boolean {
  if (allowedHosts === ALLOWED_WASM_HOSTNAMES) {
    return wasmRedirectHostAllowed(rawUrl);
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") {
      return false;
    }
    if (parsed.username || parsed.password || parsed.port !== "") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase();
    return allowedHosts.some((allowed) => {
      const cleanAllowed = allowed.toLowerCase();
      return hostname === cleanAllowed || hostname.endsWith(`.${cleanAllowed}`);
    });
  } catch {
    return false;
  }
}

function normalizeHttpHeaders(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) {
    const lower = key.toLowerCase();
    out[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function createNodeHttpsStreamFetch(httpsMod: DesktopHttpsModule): HttpStreamFetch {
  return (request: HttpStreamRequest): Promise<HttpStreamResponse> =>
    new Promise<HttpStreamResponse>((resolve, reject) => {
      if (request.signal?.aborted) {
        reject(createAbortError(request.signal.reason));
        return;
      }

      let settled = false;
      const cleanupAbort = (): void => {
        request.signal?.removeEventListener("abort", onAbort);
      };

      const clientReq = httpsMod.get(
        request.url,
        { headers: request.headers },
        (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          settled = true;
          cleanupAbort();
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: normalizeHttpHeaders(res.headers),
            body: res,
            destroy: (err?: Error): void => {
              res.destroy(err);
            },
          });
        },
      );

      const onAbort = (): void => {
        const abortErr = createAbortError(request.signal?.reason);
        clientReq.destroy(abortErr);
        if (!settled) {
          settled = true;
          cleanupAbort();
          reject(abortErr);
        }
      };

      request.signal?.addEventListener("abort", onAbort, { once: true });

      clientReq.on("error", (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAbort();
        reject(err);
      });
    });
}

function createUnavailableHttpStreamFetch(): HttpStreamFetch {
  return (): Promise<HttpStreamResponse> =>
    Promise.reject(new Error("Desktop HTTPS transport is unavailable in this runtime."));
}

function formatStatFingerprint(stat: DesktopFileStat, sha256: string): string {
  return `${stat.size}:${stat.ino}:${stat.ctimeMs}:${sha256.toLowerCase()}`;
}

async function gunzipBytes(
  compressed: Uint8Array,
  adapter: DesktopFsAdapter,
): Promise<Uint8Array> {
  if (adapter.zlib) {
    const out = adapter.zlib.gunzipSync(compressed);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
  if (typeof DecompressionStream === "function") {
    const ds = new DecompressionStream("gzip");
    const copy = new Uint8Array(compressed.byteLength);
    copy.set(compressed);
    const decompressedStream = new Blob([copy.buffer]).stream().pipeThrough(ds);
    const ab = await new Response(decompressedStream).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error("Gzip decompression is unavailable in this runtime.");
}

/**
 * Extract and validate expected files from an uncompressed POSIX/USTAR/PAX tar buffer
 * using `@voice-mode/core`'s hardened `extractNpmTarEntries` parser.
 */
export function extractPinnedTarEntries(
  tarBytes: Uint8Array,
  expectedFiles: readonly WasmExtractedFileSpec[],
): ReadonlyMap<string, Uint8Array> {
  const wanted = new Set(expectedFiles.map((f) => f.file));
  const extracted = extractNpmTarEntries(tarBytes, wanted);
  for (const spec of expectedFiles) {
    if (!extracted.has(spec.file)) {
      throw new Error(`Required WASM runtime file "${spec.file}" was missing from archive.`);
    }
  }
  return extracted;
}

/**
 * Desktop speech model cache & download manager.
 *
 * Guarantees:
 * - Zero network activity during `checkStatus()`, `loadLocalAssets()`, `readWasmGlueTexts()`,
 *   and `readTargetBinaries()`;
 * - Hard Vault-isolation guard before every read, download, or deletion;
 * - Hop-by-hop redirect host allowlist validation (`maxRedirects = 5`), `.part` HTTP 206 resume,
 *   30s headers timeout + 60s chunk idle watchdog, and streaming SHA256 verification before
 *   atomic `.part -> final` rename.
 */
export class DesktopModelManager {
  private readonly adapter: DesktopFsAdapter;
  private readonly customCacheDir: string;
  private readonly vaultBasePath: string | null;
  private readonly preferredModelHost: string;
  private readonly preferredWasmHost: string | undefined;
  private readonly vadBundle: ModelDownloadBundleSpec;
  private readonly senseVoiceBundle: ModelDownloadBundleSpec;
  private readonly vitsBundle: ModelDownloadBundleSpec | null;
  private readonly wasmTarball: WasmTarballSpec;
  private readonly httpStreamFetch: HttpStreamFetch;
  private readonly maxRedirects: number;
  private readonly headersTimeoutMs: number;
  private readonly chunkIdleTimeoutMs: number;

  private readonly verifiedCache = new Map<string, string>();
  private indexLoadedForDir: string | null = null;
  private activeDownload: Promise<DictationStackStatus> | null = null;

  constructor(options: DesktopModelManagerOptions = {}) {
    this.adapter = options.adapter ?? createDesktopFsAdapter();
    this.customCacheDir = options.customCacheDir ?? "";
    this.vaultBasePath = options.vaultBasePath ?? null;
    this.preferredModelHost =
      validateModelHost(options.preferredModelHost ?? MODEL_HOST_PRIMARY) ?? MODEL_HOST_PRIMARY;
    this.preferredWasmHost = options.preferredWasmHost;
    this.vadBundle = options.vadBundle ?? VAD_MODEL_BUNDLE;
    this.senseVoiceBundle = options.senseVoiceBundle ?? SENSEVOICE_MODEL_BUNDLE;
    this.vitsBundle = options.vitsBundle ?? null;
    this.wasmTarball = options.wasmTarball ?? SHERPA_WASM_TARBALL;
    this.httpStreamFetch =
      options.httpStreamFetch ??
      (this.adapter.https
        ? createNodeHttpsStreamFetch(this.adapter.https)
        : createUnavailableHttpStreamFetch());
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.headersTimeoutMs = options.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    this.chunkIdleTimeoutMs = options.chunkIdleTimeoutMs ?? DEFAULT_CHUNK_IDLE_TIMEOUT_MS;
  }

  /**
   * Resolve and validate that the external cache directory sits strictly outside the Vault.
   */
  resolveCacheDir(): string {
    return resolveExternalModelCacheDir({
      customDir: this.customCacheDir,
      vaultBasePath: this.vaultBasePath,
      adapter: this.adapter,
    });
  }

  /**
   * Inspect and verify local dictation assets (`Silero VAD` + `SenseVoice int8` + `sherpa-onnx WASM`)
   * with zero network requests. Uses `${size}:${ino}:${ctimeMs}:${sha256}` caching so warm checks
   * complete in `< 5 ms`.
   */
  async checkStatus(): Promise<DictationStackStatus> {
    const startedAt = this.adapter.now();
    const cacheDir = this.resolveCacheDir();
    await this.ensureVerificationIndexLoaded(cacheDir);

    const verifiedFiles: VerifiedAssetRecord[] = [];
    const missingOrCorruptFiles: string[] = [];
    let indexDirty = false;

    const verifyGroup = async (
      entries: ReadonlyArray<{
        readonly relPath: string;
        readonly sha256: string;
        readonly bytes?: number;
      }>,
    ): Promise<boolean> => {
      let allOk = true;
      for (const entry of entries) {
        const result = await this.verifySingleLocalFile(
          cacheDir,
          entry.relPath,
          entry.sha256,
          entry.bytes,
        );
        if (result.updatedCache) {
          indexDirty = true;
        }
        if (result.record) {
          verifiedFiles.push(result.record);
        } else {
          allOk = false;
          missingOrCorruptFiles.push(entry.relPath);
        }
      }
      return allOk;
    };

    const vadEntries = this.buildBundleLocalEntries(this.vadBundle);
    const senseVoiceEntries = this.buildBundleLocalEntries(this.senseVoiceBundle);
    const wasmEntries = this.buildWasmLocalEntries(this.wasmTarball);

    const vadReady = await verifyGroup(vadEntries);
    const senseVoiceReady = await verifyGroup(senseVoiceEntries);
    const wasmReady = await verifyGroup(wasmEntries);

    if (indexDirty) {
      await this.persistVerificationIndex(cacheDir);
    }

    let totalVerifiedBytes = 0;
    for (const item of verifiedFiles) {
      totalVerifiedBytes += item.bytes;
    }

    return {
      cacheDir,
      ready: vadReady && senseVoiceReady && wasmReady,
      vadReady,
      senseVoiceReady,
      wasmReady,
      verifiedFiles,
      missingOrCorruptFiles,
      totalVerifiedBytes,
      elapsedMs: Math.max(0, this.adapter.now() - startedAt),
    };
  }

  /**
   * Explicitly download, SHA256-verify, and atomically install the full desktop offline
   * dictation stack (`Silero VAD` + `SenseVoice int8` + `sherpa-onnx@2.0.2` WASM).
   */
  downloadDictationStack(
    options: DownloadDictationStackOptions = {},
  ): Promise<DictationStackStatus> {
    if (this.activeDownload) {
      return this.activeDownload;
    }
    const run = this.executeDownloadDictationStack(options).finally(() => {
      if (this.activeDownload === run) {
        this.activeDownload = null;
      }
    });
    this.activeDownload = run;
    return run;
  }

  /**
   * Read verified WASM JS glue scripts and locate the verified `.wasm` binary with zero network calls.
   */
  async readWasmGlueTexts(): Promise<WasmGlueTexts> {
    const cacheDir = this.resolveCacheDir();
    await this.ensureVerificationIndexLoaded(cacheDir);
    const pathOps = selectPathOps(this.adapter);

    let dirty = false;
    const resolvedPaths = new Map<string, string>();
    for (const spec of this.wasmTarball.files) {
      const relPath = `wasm/${this.wasmTarball.id}/${spec.file}`;
      const res = await this.verifySingleLocalFile(cacheDir, relPath, spec.sha256, spec.bytes);
      if (res.updatedCache) {
        dirty = true;
      }
      if (!res.record) {
        throw new Error(
          `WASM runtime asset "${relPath}" is missing or failed SHA256 verification.`,
        );
      }
      resolvedPaths.set(spec.file, res.record.absolutePath);
    }
    if (dirty) {
      await this.persistVerificationIndex(cacheDir);
    }

    const getVerifiedPath = (fileName: string): string => {
      const found = resolvedPaths.get(fileName);
      if (found) {
        return found;
      }
      return pathOps.join(cacheDir, "wasm", this.wasmTarball.id, fileName);
    };

    const [wasmJs, asrJs, vadJs, ttsJs] = await Promise.all([
      this.adapter.fsPromises.readFile(getVerifiedPath("sherpa-onnx-wasm-nodejs.js"), "utf8"),
      this.adapter.fsPromises.readFile(getVerifiedPath("sherpa-onnx-asr.js"), "utf8"),
      this.adapter.fsPromises.readFile(getVerifiedPath("sherpa-onnx-vad.js"), "utf8"),
      this.adapter.fsPromises.readFile(getVerifiedPath("sherpa-onnx-tts.js"), "utf8"),
    ]);

    return {
      wasmBinaryPath: getVerifiedPath("sherpa-onnx-wasm-nodejs.wasm"),
      wasmJs,
      asrJs,
      vadJs,
      ttsJs,
    };
  }

  /**
   * Read verified model binaries into zero-copy standalone `ArrayBuffer` objects ready
   * for transferable `Worker.postMessage(req, transfer)` delivery.
   */
  async readTargetBinaries(
    target: LocalBinaryTarget,
    includeWasm = false,
  ): Promise<WorkerModelBinary[]> {
    const cacheDir = this.resolveCacheDir();
    await this.ensureVerificationIndexLoaded(cacheDir);

    const bundle = this.selectBundleForTarget(target);
    const binaries: WorkerModelBinary[] = [];
    let dirty = false;

    if (includeWasm) {
      const wasmSpec = this.wasmTarball.files.find(
        (entry) => entry.file === "sherpa-onnx-wasm-nodejs.wasm",
      );
      if (!wasmSpec) {
        throw new Error("Pinned WASM binary specification is missing.");
      }
      const wasmRel = `wasm/${this.wasmTarball.id}/${wasmSpec.file}`;
      const verifiedWasm = await this.verifySingleLocalFile(
        cacheDir,
        wasmRel,
        wasmSpec.sha256,
        wasmSpec.bytes,
      );
      if (verifiedWasm.updatedCache) {
        dirty = true;
      }
      if (!verifiedWasm.record) {
        throw new Error(
          `WASM binary "${wasmRel}" is missing or failed SHA256 verification.`,
        );
      }
      const wasmBuffer = await readFileAsArrayBuffer(verifiedWasm.record.absolutePath, this.adapter);
      binaries.push({
        name: wasmSpec.file,
        buffer: wasmBuffer,
      });
    }

    for (const fileSpec of bundle.files) {
      if (!isSafeModelRel(fileSpec.file)) {
        throw new Error(`Unsafe relative model file path "${fileSpec.file}".`);
      }
      const relPath = `${bundle.repo}/${fileSpec.file}`;
      const verified = await this.verifySingleLocalFile(
        cacheDir,
        relPath,
        fileSpec.sha256,
        fileSpec.bytes,
      );
      if (verified.updatedCache) {
        dirty = true;
      }
      if (!verified.record) {
        throw new Error(
          `Model file "${relPath}" is missing or failed SHA256 verification.`,
        );
      }
      const buffer = await readFileAsArrayBuffer(verified.record.absolutePath, this.adapter);
      binaries.push({
        name: fileSpec.file,
        buffer,
      });
    }

    if (dirty) {
      await this.persistVerificationIndex(cacheDir);
    }

    return binaries;
  }

  /**
   * Verify and load the complete local offline dictation stack with zero network calls.
   */
  async loadLocalAssets(): Promise<LoadedDictationAssets> {
    const glue = await this.readWasmGlueTexts();
    const [wasmBinary, vadBinaries, asrBinaries] = await Promise.all([
      readFileAsArrayBuffer(glue.wasmBinaryPath, this.adapter),
      this.readTargetBinaries("vad", false),
      this.readTargetBinaries("asr-offline", false),
    ]);
    return {
      glue,
      wasmBinary,
      vadBinaries,
      asrBinaries,
    };
  }

  /**
   * Safely delete managed model subdirectories inside the verified external cache directory
   * after enforcing `assertPathOutsideVault`.
   */
  async clearCachedModels(): Promise<void> {
    const cacheDir = this.resolveCacheDir();
    assertPathOutsideVault(cacheDir, this.vaultBasePath, this.adapter);
    const pathOps = selectPathOps(this.adapter);

    const subdirs = new Set<string>(MANAGED_MODEL_SUBDIRS);
    subdirs.add(this.vadBundle.repo);
    subdirs.add(this.senseVoiceBundle.repo);
    if (this.vitsBundle) {
      subdirs.add(this.vitsBundle.repo);
    }
    subdirs.add(`wasm/${this.wasmTarball.id}`);

    for (const relSubdir of subdirs) {
      if (!isSafeModelRel(relSubdir)) {
        throw new Error(`Refusing to remove unsafe managed subdirectory "${relSubdir}".`);
      }
      const absTarget = pathOps.join(cacheDir, ...relSubdir.split("/"));
      assertPathOutsideVault(absTarget, this.vaultBasePath, this.adapter);
      await this.adapter.fsPromises.rm(absTarget, { recursive: true, force: true });
    }

    const indexFile = pathOps.join(cacheDir, VERIFICATION_INDEX_FILENAME);
    await this.adapter.fsPromises.rm(indexFile, { force: true }).catch(() => undefined);
    this.verifiedCache.clear();
    this.indexLoadedForDir = null;
  }

  private selectBundleForTarget(target: LocalBinaryTarget): ModelDownloadBundleSpec {
    if (target === "vad") {
      return this.vadBundle;
    }
    if (target === "asr-offline") {
      return this.senseVoiceBundle;
    }
    if (this.vitsBundle) {
      return this.vitsBundle;
    }
    throw new Error("Local VITS speech model bundle is not configured.");
  }

  private buildBundleLocalEntries(
    bundle: ModelDownloadBundleSpec,
  ): Array<{ readonly relPath: string; readonly sha256: string; readonly bytes?: number }> {
    if (!isSafeModelRel(bundle.repo)) {
      throw new Error(`Unsafe model repository identifier "${bundle.repo}".`);
    }
    return bundle.files.map((spec) => {
      if (!isSafeModelRel(spec.file)) {
        throw new Error(`Unsafe model file path "${spec.file}".`);
      }
      return {
        relPath: `${bundle.repo}/${spec.file}`,
        sha256: spec.sha256,
        bytes: spec.bytes,
      };
    });
  }

  private buildWasmLocalEntries(
    wasm: WasmTarballSpec,
  ): Array<{ readonly relPath: string; readonly sha256: string; readonly bytes?: number }> {
    const dirRel = `wasm/${wasm.id}`;
    if (!isSafeModelRel(dirRel)) {
      throw new Error(`Unsafe WASM directory identifier "${dirRel}".`);
    }
    return wasm.files.map((spec) => {
      if (!isSafeModelRel(spec.file)) {
        throw new Error(`Unsafe WASM file path "${spec.file}".`);
      }
      return {
        relPath: `${dirRel}/${spec.file}`,
        sha256: spec.sha256,
        bytes: spec.bytes,
      };
    });
  }

  private getModelMirrorOrder(): string[] {
    if (this.preferredModelHost === MODEL_HOST_FALLBACK) {
      return [MODEL_HOST_FALLBACK, MODEL_HOST_PRIMARY];
    }
    const validated = validateModelHost(this.preferredModelHost);
    if (validated && validated !== MODEL_HOST_PRIMARY) {
      return [validated, MODEL_HOST_PRIMARY, MODEL_HOST_FALLBACK];
    }
    return [MODEL_HOST_PRIMARY, MODEL_HOST_FALLBACK];
  }

  private getWasmMirrorOrder(): string[] {
    const primary = this.wasmTarball.primaryHost;
    const fallback = this.wasmTarball.fallbackHost;
    if (this.preferredWasmHost) {
      if (this.preferredWasmHost === fallback) {
        return [fallback, primary];
      }
      if (this.preferredWasmHost === primary) {
        return [primary, fallback];
      }
      return [this.preferredWasmHost, primary, fallback];
    }
    if (this.preferredModelHost === MODEL_HOST_FALLBACK) {
      return [fallback, primary];
    }
    return [primary, fallback];
  }

  private async ensureVerificationIndexLoaded(cacheDir: string): Promise<void> {
    if (this.indexLoadedForDir === cacheDir) {
      return;
    }
    this.verifiedCache.clear();
    this.indexLoadedForDir = cacheDir;

    const pathOps = selectPathOps(this.adapter);
    const indexPath = pathOps.join(cacheDir, VERIFICATION_INDEX_FILENAME);
    try {
      const raw = await this.adapter.fsPromises.readFile(indexPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        const entries = (parsed as { entries?: unknown }).entries;
        if (typeof entries === "object" && entries !== null) {
          for (const [absPath, fingerprint] of Object.entries(entries)) {
            if (typeof fingerprint === "string") {
              this.verifiedCache.set(absPath, fingerprint);
            }
          }
        }
      }
    } catch {
      // Missing or unreadable index is harmless; files will be hashed on demand.
    }
  }

  private async persistVerificationIndex(cacheDir: string): Promise<void> {
    const pathOps = selectPathOps(this.adapter);
    const indexPath = pathOps.join(cacheDir, VERIFICATION_INDEX_FILENAME);
    const entriesObj: Record<string, string> = {};
    for (const [absPath, fingerprint] of this.verifiedCache.entries()) {
      entriesObj[absPath] = fingerprint;
    }
    try {
      await this.adapter.fsPromises.mkdir(cacheDir, { recursive: true });
      await this.adapter.fsPromises.writeFile(
        indexPath,
        JSON.stringify({ version: 1, entries: entriesObj }),
      );
    } catch {
      // Best-effort persistence; in-memory cache remains active.
    }
  }

  private async verifySingleLocalFile(
    cacheDir: string,
    relPath: string,
    expectedSha256: string,
    expectedBytes?: number,
  ): Promise<{ record: VerifiedAssetRecord | null; updatedCache: boolean }> {
    if (!isSafeModelRel(relPath)) {
      throw new Error(`Unsafe relative model path "${relPath}".`);
    }
    const pathOps = selectPathOps(this.adapter);
    const absPath = pathOps.join(cacheDir, ...relPath.split("/"));
    const normalizedExpected = expectedSha256.toLowerCase();

    let stat: DesktopFileStat;
    try {
      stat = await this.adapter.fsPromises.stat(absPath);
    } catch {
      this.verifiedCache.delete(absPath);
      return { record: null, updatedCache: false };
    }

    if (!stat.isFile()) {
      this.verifiedCache.delete(absPath);
      return { record: null, updatedCache: false };
    }
    if (typeof expectedBytes === "number" && stat.size !== expectedBytes) {
      this.verifiedCache.delete(absPath);
      return { record: null, updatedCache: false };
    }

    const expectedFingerprint = formatStatFingerprint(stat, normalizedExpected);
    if (this.verifiedCache.get(absPath) === expectedFingerprint) {
      return {
        record: {
          relativePath: relPath,
          absolutePath: absPath,
          bytes: stat.size,
          sha256: normalizedExpected,
        },
        updatedCache: false,
      };
    }

    try {
      const actualSha256 = await computeFileSha256(absPath, this.adapter);
      if (actualSha256 !== normalizedExpected) {
        this.verifiedCache.delete(absPath);
        return { record: null, updatedCache: false };
      }
      const postStat = await this.adapter.fsPromises.stat(absPath);
      const fingerprint = formatStatFingerprint(postStat, normalizedExpected);
      this.verifiedCache.set(absPath, fingerprint);
      return {
        record: {
          relativePath: relPath,
          absolutePath: absPath,
          bytes: postStat.size,
          sha256: normalizedExpected,
        },
        updatedCache: true,
      };
    } catch {
      this.verifiedCache.delete(absPath);
      return { record: null, updatedCache: false };
    }
  }

  private async executeDownloadDictationStack(
    options: DownloadDictationStackOptions,
  ): Promise<DictationStackStatus> {
    const { signal, onProgress } = options;
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }

    const cacheDir = this.resolveCacheDir();
    assertPathOutsideVault(cacheDir, this.vaultBasePath, this.adapter);
    await this.ensureVerificationIndexLoaded(cacheDir);
    const pathOps = selectPathOps(this.adapter);

    const wasmEstimatedBytes =
      this.wasmTarball.bytes ??
      this.wasmTarball.files.reduce((sum, item) => sum + (item.bytes ?? 0), 0);

    const bundlesToFetch: readonly ModelDownloadBundleSpec[] = [
      this.vadBundle,
      this.senseVoiceBundle,
    ];
    let overallTotalBytes = wasmEstimatedBytes;
    for (const bundle of bundlesToFetch) {
      for (const spec of bundle.files) {
        overallTotalBytes += spec.bytes ?? 0;
      }
    }

    let completedBytes = 0;
    const modelMirrors = this.getModelMirrorOrder();

    for (const bundle of bundlesToFetch) {
      if (!isSafeModelRel(bundle.repo)) {
        throw new Error(`Unsafe model repository identifier "${bundle.repo}".`);
      }
      for (const fileSpec of bundle.files) {
        if (signal?.aborted) {
          throw createAbortError(signal.reason);
        }
        if (!isSafeModelRel(fileSpec.file)) {
          throw new Error(`Unsafe model file "${fileSpec.file}".`);
        }

        const relPath = `${bundle.repo}/${fileSpec.file}`;
        const existing = await this.verifySingleLocalFile(
          cacheDir,
          relPath,
          fileSpec.sha256,
          fileSpec.bytes,
        );
        if (existing.record) {
          completedBytes += existing.record.bytes;
          onProgress?.({
            phase: "verifying",
            bundleId: bundle.id,
            file: fileSpec.file,
            downloadedBytes: existing.record.bytes,
            totalBytes: existing.record.bytes,
            overallDownloadedBytes: completedBytes,
            overallTotalBytes,
            host: "cache",
            percent:
              overallTotalBytes > 0
                ? Math.min(100, Math.round((completedBytes / overallTotalBytes) * 100))
                : 100,
          });
          continue;
        }

        const finalPath = pathOps.join(cacheDir, ...relPath.split("/"));
        const revision = fileSpec.revision ?? bundle.revision;
        const candidateUrls = modelMirrors.map(
          (host) => `${host}/${bundle.repo}/resolve/${encodeURIComponent(revision)}/${fileSpec.file}`,
        );

        const downloadedSize = await this.downloadVerifiedFileWithMirrors({
          bundleId: bundle.id,
          displayFile: fileSpec.file,
          finalPath,
          expectedSha256: fileSpec.sha256,
          expectedBytes: fileSpec.bytes,
          candidateUrls,
          isHostAllowed: (url) => redirectHostAllowed(url, false),
          completedBytesBefore: completedBytes,
          overallTotalBytes,
          signal,
          onProgress,
        });

        const stat = await this.adapter.fsPromises.stat(finalPath);
        this.verifiedCache.set(finalPath, formatStatFingerprint(stat, fileSpec.sha256));
        completedBytes += downloadedSize;
      }
    }

    const wasmEntries = this.buildWasmLocalEntries(this.wasmTarball);
    let wasmAlreadyReady = true;
    for (const entry of wasmEntries) {
      const check = await this.verifySingleLocalFile(
        cacheDir,
        entry.relPath,
        entry.sha256,
        entry.bytes,
      );
      if (!check.record) {
        wasmAlreadyReady = false;
        break;
      }
    }

    if (!wasmAlreadyReady) {
      await this.downloadAndExtractWasmTarball({
        cacheDir,
        completedBytesBefore: completedBytes,
        overallTotalBytes,
        wasmEstimatedBytes,
        signal,
        onProgress,
      });
    } else {
      completedBytes += wasmEstimatedBytes;
    }

    await this.persistVerificationIndex(cacheDir);
    const finalStatus = await this.checkStatus();
    if (!finalStatus.ready) {
      throw new Error(
        `Dictation stack verification failed after download (${finalStatus.missingOrCorruptFiles.join(", ")}).`,
      );
    }

    onProgress?.({
      phase: "complete",
      bundleId: "dictation-stack",
      file: "",
      downloadedBytes: finalStatus.totalVerifiedBytes,
      totalBytes: finalStatus.totalVerifiedBytes,
      overallDownloadedBytes: finalStatus.totalVerifiedBytes,
      overallTotalBytes: finalStatus.totalVerifiedBytes,
      host: "local",
      percent: 100,
    });

    return finalStatus;
  }

  private async downloadAndExtractWasmTarball(params: {
    readonly cacheDir: string;
    readonly completedBytesBefore: number;
    readonly overallTotalBytes: number;
    readonly wasmEstimatedBytes: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: ModelDownloadProgress) => void;
  }): Promise<void> {
    const {
      cacheDir,
      completedBytesBefore,
      overallTotalBytes,
      wasmEstimatedBytes,
      signal,
      onProgress,
    } = params;
    const pathOps = selectPathOps(this.adapter);
    const wasmDir = pathOps.join(cacheDir, "wasm", this.wasmTarball.id);
    assertPathOutsideVault(wasmDir, this.vaultBasePath, this.adapter);
    await this.adapter.fsPromises.mkdir(wasmDir, { recursive: true });

    const archiveFinalPath = pathOps.join(wasmDir, `${this.wasmTarball.id}.tgz`);
    const wasmMirrors = this.getWasmMirrorOrder();
    const candidateUrls = wasmMirrors.map((host) => `${host}${this.wasmTarball.tarballPath}`);

    await this.downloadVerifiedFileWithMirrors({
      bundleId: "wasm",
      displayFile: `${this.wasmTarball.id}.tgz`,
      finalPath: archiveFinalPath,
      expectedSha256: this.wasmTarball.sha256,
      expectedBytes: this.wasmTarball.bytes,
      candidateUrls,
      isHostAllowed: (url) => isWasmRedirectHostAllowed(url, this.wasmTarball.allowedHosts),
      completedBytesBefore,
      overallTotalBytes,
      signal,
      onProgress,
    });

    try {
      onProgress?.({
        phase: "extracting",
        bundleId: "wasm",
        file: `${this.wasmTarball.id}.tgz`,
        downloadedBytes: wasmEstimatedBytes,
        totalBytes: wasmEstimatedBytes,
        overallDownloadedBytes: completedBytesBefore + wasmEstimatedBytes,
        overallTotalBytes,
        host: "local",
        percent:
          overallTotalBytes > 0
            ? Math.min(
                99,
                Math.round(((completedBytesBefore + wasmEstimatedBytes) / overallTotalBytes) * 100),
              )
            : null,
      });

      const compressedAb = await readFileAsArrayBuffer(archiveFinalPath, this.adapter);
      const tarBytes = await gunzipBytes(new Uint8Array(compressedAb), this.adapter);
      const extractedFiles = extractPinnedTarEntries(tarBytes, this.wasmTarball.files);

      for (const spec of this.wasmTarball.files) {
        if (signal?.aborted) {
          throw createAbortError(signal.reason);
        }
        const fileBytes = extractedFiles.get(spec.file);
        if (!fileBytes) {
          throw new Error(`Missing extracted WASM file "${spec.file}".`);
        }
        if (typeof spec.bytes === "number" && fileBytes.byteLength !== spec.bytes) {
          throw new Error(
            `Size mismatch for extracted WASM file "${spec.file}" (expected ${spec.bytes}, got ${fileBytes.byteLength}).`,
          );
        }
        const actualSha256 = await computeBytesSha256(fileBytes, this.adapter);
        if (actualSha256 !== spec.sha256.toLowerCase()) {
          throw new Error(
            `SHA256 mismatch for extracted WASM file "${spec.file}" (expected ${spec.sha256}, got ${actualSha256}).`,
          );
        }

        const outPath = pathOps.join(wasmDir, spec.file);
        const outPartPath = `${outPath}.part`;
        await this.adapter.fsPromises.writeFile(outPartPath, fileBytes);
        await this.adapter.fsPromises.rename(outPartPath, outPath);
        const stat = await this.adapter.fsPromises.stat(outPath);
        this.verifiedCache.set(outPath, formatStatFingerprint(stat, spec.sha256));
      }
    } finally {
      await this.adapter.fsPromises.rm(archiveFinalPath, { force: true }).catch(() => undefined);
    }
  }

  private async downloadVerifiedFileWithMirrors(params: {
    readonly bundleId: string;
    readonly displayFile: string;
    readonly finalPath: string;
    readonly expectedSha256: string;
    readonly expectedBytes?: number;
    readonly candidateUrls: readonly string[];
    readonly isHostAllowed: (url: string) => boolean;
    readonly completedBytesBefore: number;
    readonly overallTotalBytes: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: ModelDownloadProgress) => void;
  }): Promise<number> {
    const pathOps = selectPathOps(this.adapter);
    const parentDir = pathOps.dirname(params.finalPath);
    assertPathOutsideVault(parentDir, this.vaultBasePath, this.adapter);
    await this.adapter.fsPromises.mkdir(parentDir, { recursive: true });

    const partPath = `${params.finalPath}.part`;
    const expectedLower = params.expectedSha256.toLowerCase();

    // If a previous download finished writing all bytes to `.part` right before a crash/cancel,
    // verify `.part` directly and promote with 0 network calls (or delete if corrupt so we never
    // send an out-of-bounds `Range: bytes=<expectedBytes>-` that triggers HTTP 416).
    const preExistingPartBytes = await this.getExistingPartSize(partPath);
    if (
      typeof params.expectedBytes === "number" &&
      preExistingPartBytes === params.expectedBytes
    ) {
      const partSha = await computeFileSha256(partPath, this.adapter).catch(() => "");
      if (partSha === expectedLower) {
        await this.adapter.fsPromises.rename(partPath, params.finalPath);
        return preExistingPartBytes;
      }
      await this.adapter.fsPromises.unlink(partPath).catch(() => undefined);
    }

    const errors: string[] = [];

    for (const initialUrl of params.candidateUrls) {
      const hostLabel = safeOriginLabel(initialUrl);
      let retriedFreshAfterCorruptPart = false;

      while (true) {
        if (params.signal?.aborted) {
          throw createAbortError(params.signal.reason);
        }

        const startedWithPart = (await this.getExistingPartSize(partPath)) > 0;
        try {
          const bytesWritten = await this.downloadToPartWithRedirects({
            initialUrl,
            partPath,
            isHostAllowed: params.isHostAllowed,
            bundleId: params.bundleId,
            displayFile: params.displayFile,
            expectedBytes: params.expectedBytes,
            completedBytesBefore: params.completedBytesBefore,
            overallTotalBytes: params.overallTotalBytes,
            hostLabel,
            signal: params.signal,
            onProgress: params.onProgress,
          });

          params.onProgress?.({
            phase: "verifying",
            bundleId: params.bundleId,
            file: params.displayFile,
            downloadedBytes: bytesWritten,
            totalBytes: params.expectedBytes ?? bytesWritten,
            overallDownloadedBytes: params.completedBytesBefore + bytesWritten,
            overallTotalBytes: params.overallTotalBytes,
            host: hostLabel,
            percent:
              params.overallTotalBytes > 0
                ? Math.min(
                    99,
                    Math.round(
                      ((params.completedBytesBefore + bytesWritten) / params.overallTotalBytes) * 100,
                    ),
                  )
                : null,
          });

          if (
            typeof params.expectedBytes === "number" &&
            bytesWritten !== params.expectedBytes
          ) {
            await this.adapter.fsPromises.unlink(partPath).catch(() => undefined);
            throw new Error(
              `Byte length mismatch for "${params.displayFile}" from ${hostLabel} (expected ${params.expectedBytes}, got ${bytesWritten}).`,
            );
          }

          const actualSha256 = await computeFileSha256(partPath, this.adapter);
          if (actualSha256 !== expectedLower) {
            await this.adapter.fsPromises.unlink(partPath).catch(() => undefined);
            throw new Error(
              `SHA256 mismatch for "${params.displayFile}" from ${hostLabel} (expected ${expectedLower}, got ${actualSha256}).`,
            );
          }

          await this.adapter.fsPromises.rename(partPath, params.finalPath);
          return bytesWritten;
        } catch (err) {
          if (isAbortError(err, params.signal) || err instanceof SecurityRedirectError) {
            throw err;
          }
          // If an attempt started from a stale/corrupt `.part` prefix that has now been unlinked,
          // retry the same mirror once cleanly from byte 0 before failing over to the next mirror.
          const remainingPart = await this.getExistingPartSize(partPath);
          if (startedWithPart && remainingPart === 0 && !retriedFreshAfterCorruptPart) {
            retriedFreshAfterCorruptPart = true;
            continue;
          }
          const safeMsg = redactSecrets(err instanceof Error ? err.message : String(err));
          errors.push(`${hostLabel}: ${safeMsg}`);
          break;
        }
      }
    }

    throw new Error(
      `Failed to download "${params.displayFile}" across all allowed mirrors (${errors.join("; ")}).`,
    );
  }

  private async downloadToPartWithRedirects(params: {
    readonly initialUrl: string;
    readonly partPath: string;
    readonly isHostAllowed: (url: string) => boolean;
    readonly bundleId: string;
    readonly displayFile: string;
    readonly expectedBytes?: number;
    readonly completedBytesBefore: number;
    readonly overallTotalBytes: number;
    readonly hostLabel: string;
    readonly signal?: AbortSignal;
    readonly onProgress?: (progress: ModelDownloadProgress) => void;
  }): Promise<number> {
    if (!params.isHostAllowed(params.initialUrl)) {
      throw new SecurityRedirectError(
        `Initial download URL "${safeOriginLabel(params.initialUrl)}" is not on the HTTPS host allowlist.`,
      );
    }

    let resumeFrom = await this.getExistingPartSize(params.partPath);
    if (
      typeof params.expectedBytes === "number" &&
      resumeFrom > params.expectedBytes
    ) {
      await this.adapter.fsPromises.unlink(params.partPath).catch(() => undefined);
      resumeFrom = 0;
    }

    let retriedRange416 = false;

    while (true) {
      let currentUrl = params.initialUrl;
      let redirectsFollowed = 0;
      let finalResponse: HttpStreamResponse | null = null;

      while (true) {
        if (params.signal?.aborted) {
          throw createAbortError(params.signal.reason);
        }

        const headers: Record<string, string> = {
          Accept: "application/octet-stream",
        };
        if (resumeFrom > 0) {
          headers.Range = `bytes=${resumeFrom}-`;
        }

        const res = await this.openHeadersWithTimeout(
          { url: currentUrl, headers, signal: params.signal },
          params.signal,
        );

        if (REDIRECT_STATUS_CODES.has(res.statusCode)) {
          const rawLocation = res.headers.location?.trim() ?? "";
          res.destroy?.();
          if (!rawLocation) {
            throw new Error(
              `HTTP ${res.statusCode} redirect from ${safeOriginLabel(currentUrl)} lacked a Location header.`,
            );
          }
          redirectsFollowed += 1;
          if (redirectsFollowed > this.maxRedirects) {
            throw new SecurityRedirectError(
              `Exceeded maximum redirect hops (${this.maxRedirects}) while fetching "${params.displayFile}".`,
            );
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(rawLocation, currentUrl).toString();
          } catch {
            throw new SecurityRedirectError(`Malformed redirect Location "${rawLocation}".`);
          }
          if (!params.isHostAllowed(nextUrl)) {
            throw new SecurityRedirectError(
              `Blocked redirect to disallowed host "${safeOriginLabel(nextUrl)}".`,
            );
          }
          currentUrl = nextUrl;
          continue;
        }

        finalResponse = res;
        break;
      }

      if (finalResponse.statusCode === 416 && resumeFrom > 0 && !retriedRange416) {
        finalResponse.destroy?.();
        await this.adapter.fsPromises.unlink(params.partPath).catch(() => undefined);
        resumeFrom = 0;
        retriedRange416 = true;
        continue;
      }

      if (finalResponse.statusCode !== 200 && finalResponse.statusCode !== 206) {
        const code = finalResponse.statusCode;
        finalResponse.destroy?.();
        throw new Error(`HTTP ${code} while downloading "${params.displayFile}".`);
      }

      if (finalResponse.statusCode === 206) {
        const rangeHeader = finalResponse.headers["content-range"]?.trim() ?? "";
        const rangeMatch = CONTENT_RANGE_START_RE.exec(rangeHeader);
        const rangeStart = rangeMatch?.[1] ? Number.parseInt(rangeMatch[1], 10) : -1;
        const expectedStart = resumeFrom > 0 ? resumeFrom : 0;
        if (rangeStart !== expectedStart) {
          finalResponse.destroy?.();
          await this.adapter.fsPromises.unlink(params.partPath).catch(() => undefined);
          throw new Error(
            `Invalid HTTP 206 Content-Range "${rangeHeader || "<missing>"}" (expected start byte ${expectedStart}) while downloading "${params.displayFile}".`,
          );
        }
      }

      const appendMode = finalResponse.statusCode === 206 && resumeFrom > 0;
      let writeOffset = appendMode ? resumeFrom : 0;
      const declaredTotal = resolveTotalBytes(
        finalResponse.headers,
        writeOffset,
        params.expectedBytes,
      );

      let fh: DesktopFileHandle | null = null;
      try {
        fh = await this.adapter.fsPromises.open(params.partPath, appendMode ? "r+" : "w");
        const iterator = finalResponse.body[Symbol.asyncIterator]();
        try {
          while (true) {
            const step = await this.nextChunkWithWatchdog(
              iterator,
              finalResponse,
              params.signal,
            );
            if (step.done) {
              break;
            }
            const chunk = step.value;
            if (chunk.byteLength === 0) {
              continue;
            }
            await this.writeAllBytes(fh, chunk, writeOffset);
            writeOffset += chunk.byteLength;

            const overallNow = params.completedBytesBefore + writeOffset;
            params.onProgress?.({
              phase: "downloading",
              bundleId: params.bundleId,
              file: params.displayFile,
              downloadedBytes: writeOffset,
              totalBytes: declaredTotal,
              overallDownloadedBytes: overallNow,
              overallTotalBytes: params.overallTotalBytes,
              host: params.hostLabel,
              percent:
                params.overallTotalBytes > 0
                  ? Math.min(99, Math.round((overallNow / params.overallTotalBytes) * 100))
                  : declaredTotal && declaredTotal > 0
                    ? Math.min(99, Math.round((writeOffset / declaredTotal) * 100))
                    : null,
            });
          }
        } finally {
          finalResponse.destroy?.();
          if (typeof iterator.return === "function") {
            void iterator.return(undefined).catch(() => undefined);
          }
        }
        return writeOffset;
      } finally {
        finalResponse.destroy?.();
        if (fh) {
          await fh.close().catch(() => undefined);
        }
      }
    }
  }

  private async getExistingPartSize(partPath: string): Promise<number> {
    try {
      const stat = await this.adapter.fsPromises.stat(partPath);
      return stat.isFile() && stat.size > 0 ? stat.size : 0;
    } catch {
      return 0;
    }
  }

  private async writeAllBytes(
    fh: DesktopFileHandle,
    chunk: Uint8Array,
    startPosition: number,
  ): Promise<void> {
    let localOffset = 0;
    while (localOffset < chunk.byteLength) {
      const { bytesWritten } = await fh.write(
        chunk,
        localOffset,
        chunk.byteLength - localOffset,
        startPosition + localOffset,
      );
      if (bytesWritten <= 0) {
        throw new Error("Disk write returned zero bytes while saving model part file.");
      }
      localOffset += bytesWritten;
    }
  }

  private async openHeadersWithTimeout(
    request: HttpStreamRequest,
    signal?: AbortSignal,
  ): Promise<HttpStreamResponse> {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }

    const headerAbort = new AbortController();
    let timerHandle: unknown = null;
    let timedOutOrAborted = false;
    let cleanupAbort: (() => void) | null = null;

    const guardPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        timedOutOrAborted = true;
        const abortErr = createAbortError(signal?.reason);
        headerAbort.abort(abortErr);
        reject(abortErr);
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }
      timerHandle = this.adapter.setTimeout(() => {
        timedOutOrAborted = true;
        const timeoutErr = new Error(
          `Connection timed out after ${this.headersTimeoutMs} ms waiting for response headers.`,
        );
        headerAbort.abort(timeoutErr);
        reject(timeoutErr);
      }, this.headersTimeoutMs);
    });

    const fetchPromise = this.httpStreamFetch({
      ...request,
      signal: headerAbort.signal,
    });
    fetchPromise
      .then((lateRes) => {
        if (timedOutOrAborted) {
          lateRes.destroy?.();
        }
      })
      .catch(() => undefined);

    try {
      return await Promise.race([fetchPromise, guardPromise]);
    } finally {
      if (timerHandle !== null) {
        this.adapter.clearTimeout(timerHandle);
      }
      if (cleanupAbort !== null) {
        (cleanupAbort as () => void)();
      }
    }
  }

  private async nextChunkWithWatchdog(
    iterator: AsyncIterator<Uint8Array>,
    response: HttpStreamResponse,
    signal?: AbortSignal,
  ): Promise<IteratorResult<Uint8Array>> {
    if (signal?.aborted) {
      const err = createAbortError(signal.reason);
      response.destroy?.(err);
      throw err;
    }

    let timerHandle: unknown = null;
    let cleanupAbort: (() => void) | null = null;

    const guardPromise = new Promise<never>((_, reject) => {
      const onAbort = (): void => {
        const err = createAbortError(signal?.reason);
        response.destroy?.(err);
        reject(err);
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        cleanupAbort = () => signal.removeEventListener("abort", onAbort);
      }
      timerHandle = this.adapter.setTimeout(() => {
        const err = new Error(
          `Model download stalled with no data received for ${this.chunkIdleTimeoutMs} ms.`,
        );
        response.destroy?.(err);
        reject(err);
      }, this.chunkIdleTimeoutMs);
    });

    try {
      return await Promise.race([iterator.next(), guardPromise]);
    } finally {
      if (timerHandle !== null) {
        this.adapter.clearTimeout(timerHandle);
      }
      if (cleanupAbort !== null) {
        (cleanupAbort as () => void)();
      }
    }
  }
}

function safeOriginLabel(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "unknown-host";
  }
}

function resolveTotalBytes(
  headers: Readonly<Record<string, string | undefined>>,
  startOffset: number,
  expectedBytes?: number,
): number | null {
  if (typeof expectedBytes === "number" && expectedBytes > 0) {
    return expectedBytes;
  }
  const contentRange = headers["content-range"];
  if (contentRange) {
    const slashIdx = contentRange.lastIndexOf("/");
    if (slashIdx >= 0) {
      const totalPart = Number.parseInt(contentRange.slice(slashIdx + 1), 10);
      if (Number.isFinite(totalPart) && totalPart > 0) {
        return totalPart;
      }
    }
  }
  const contentLength = headers["content-length"];
  if (contentLength) {
    const parsedLen = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsedLen) && parsedLen >= 0) {
      return startOffset + parsedLen;
    }
  }
  return null;
}
