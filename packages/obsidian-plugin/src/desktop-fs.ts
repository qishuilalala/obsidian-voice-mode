/**
 * Desktop-only filesystem, canonical path, Vault-isolation, zero-copy ArrayBuffer read,
 * and streaming SHA256 helpers.
 *
 * Uses dynamic desktop module lookup via `window` so mobile WebViews never load Node
 * built-ins and cross-platform bundle checks remain clean.
 */

export const VAULT_ISOLATION_ERROR_MESSAGE =
  "Model cache directory must be located outside the Obsidian vault to protect Obsidian Sync.";

const MOD_FS = "fs";
const MOD_FS_PROMISES = "fs/promises";
const MOD_PATH = "path";
const MOD_OS = "os";
const MOD_PROCESS = "process";
const MOD_CRYPTO = "crypto";
const MOD_ZLIB = "zlib";
const MOD_HTTPS = "https";
const MOD_TIMERS = "timers";
const MOD_ELECTRON = "electron";

const HASH_STREAM_CHUNK_BYTES = 1024 * 1024; // 1 MB reusable scratch buffer

export interface DesktopRequireWindow {
  require?: (moduleId: string) => unknown;
}

export interface LoadDesktopModuleOptions {
  readonly isDesktop?: boolean;
  readonly win?: DesktopRequireWindow | null;
}

/**
 * Load a desktop Node built-in module at runtime when running on Obsidian Desktop.
 * Returns `null` on mobile WebViews or when the module is unavailable.
 */
export function loadDesktopModule<T>(
  moduleId: string,
  options?: LoadDesktopModuleOptions,
): T | null {
  if (options?.isDesktop === false) {
    return null;
  }
  const targetWin: DesktopRequireWindow | null =
    options?.win !== undefined
      ? options.win
      : typeof window !== "undefined"
        ? window
        : null;
  if (!targetWin || typeof targetWin.require !== "function") {
    return null;
  }
  try {
    return targetWin.require(moduleId) as T;
  } catch {
    return null;
  }
}

export interface DesktopFileStat {
  readonly size: number;
  readonly ino: number;
  readonly ctimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface DesktopFileReadResult {
  readonly bytesRead: number;
}

export interface DesktopFileWriteResult {
  readonly bytesWritten: number;
}

export interface DesktopFileHandle {
  stat(): Promise<DesktopFileStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<DesktopFileReadResult>;
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<DesktopFileWriteResult>;
  close(): Promise<void>;
}

export interface DesktopFsPromisesModule {
  open(filePath: string, flags: string): Promise<DesktopFileHandle>;
  stat(filePath: string): Promise<DesktopFileStat>;
  mkdir(dirPath: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  rename(oldPath: string, newPath: string): Promise<void>;
  rm(targetPath: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  unlink(filePath: string): Promise<void>;
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  writeFile(filePath: string, data: Uint8Array | string): Promise<void>;
}

export interface DesktopFsSyncModule {
  existsSync(targetPath: string): boolean;
  realpathSync(targetPath: string): string;
}

export interface DesktopPathOps {
  resolve(...segments: string[]): string;
  normalize(targetPath: string): string;
  join(...segments: string[]): string;
  dirname(targetPath: string): string;
  basename(targetPath: string): string;
  relative(from: string, to: string): string;
  isAbsolute(targetPath: string): boolean;
  readonly sep: string;
}

export interface DesktopPathModule extends DesktopPathOps {
  readonly posix?: DesktopPathOps;
  readonly win32?: DesktopPathOps;
}

export interface DesktopOsModule {
  platform(): string;
  homedir(): string;
}

export interface DesktopProcessModule {
  readonly env: Readonly<Record<string, string | undefined>>;
}

export interface DesktopHash {
  update(data: Uint8Array): DesktopHash;
  digest(encoding: "hex"): string;
}

export interface DesktopCryptoModule {
  createHash(algorithm: "sha256"): DesktopHash;
}

export interface DesktopZlibModule {
  gunzipSync(input: Uint8Array): Uint8Array;
}

export interface DesktopIncomingMessage extends AsyncIterable<Uint8Array> {
  readonly statusCode?: number;
  readonly statusMessage?: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  resume(): void;
  destroy(error?: Error): void;
}

export interface DesktopClientRequest {
  on(event: "error", listener: (err: Error) => void): this;
  destroy(error?: Error): void;
  end(): void;
}

export interface DesktopHttpsModule {
  get(
    url: string,
    options: { headers?: Readonly<Record<string, string>> },
    callback: (res: DesktopIncomingMessage) => void,
  ): DesktopClientRequest;
}

export type DesktopTimerHandle = unknown;

interface DesktopTimersModule {
  setTimeout(callback: () => void, delayMs: number): DesktopTimerHandle;
  clearTimeout(handle: DesktopTimerHandle): void;
}

export interface DesktopFsAdapter {
  readonly platform: string;
  readonly homedir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly path: DesktopPathModule;
  readonly fsSync: DesktopFsSyncModule;
  readonly fsPromises: DesktopFsPromisesModule;
  readonly crypto: DesktopCryptoModule | null;
  readonly zlib: DesktopZlibModule | null;
  readonly https: DesktopHttpsModule | null;
  setTimeout(callback: () => void, delayMs: number): DesktopTimerHandle;
  clearTimeout(handle: DesktopTimerHandle): void;
  now(): number;
}

export interface CreateDesktopFsAdapterOptions extends LoadDesktopModuleOptions {
  readonly platform?: string;
  readonly homedir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fsSync?: Partial<DesktopFsSyncModule>;
  readonly fsPromises?: Partial<DesktopFsPromisesModule>;
  readonly crypto?: DesktopCryptoModule | null;
  readonly zlib?: DesktopZlibModule | null;
  readonly https?: DesktopHttpsModule | null;
  readonly now?: () => number;
}

/**
 * Create a typed `DesktopFsAdapter` from the runtime's desktop module loader
 * (with optional overrides for unit testing across macOS, Linux, and Windows).
 */
export function createDesktopFsAdapter(
  options?: CreateDesktopFsAdapterOptions,
): DesktopFsAdapter {
  const fsSyncMod = loadDesktopModule<DesktopFsSyncModule>(MOD_FS, options);
  const fsPromisesMod = loadDesktopModule<DesktopFsPromisesModule>(MOD_FS_PROMISES, options);
  const pathMod = loadDesktopModule<DesktopPathModule>(MOD_PATH, options);
  const osMod = loadDesktopModule<DesktopOsModule>(MOD_OS, options);
  const processMod = loadDesktopModule<DesktopProcessModule>(MOD_PROCESS, options);
  const cryptoMod =
    options?.crypto !== undefined
      ? options.crypto
      : loadDesktopModule<DesktopCryptoModule>(MOD_CRYPTO, options);
  const zlibMod =
    options?.zlib !== undefined
      ? options.zlib
      : loadDesktopModule<DesktopZlibModule>(MOD_ZLIB, options);
  const httpsMod =
    options?.https !== undefined
      ? options.https
      : loadDesktopModule<DesktopHttpsModule>(MOD_HTTPS, options);
  const timersMod =
    typeof window === "undefined"
      ? loadDesktopModule<DesktopTimersModule>(MOD_TIMERS, options)
      : null;

  if (!fsSyncMod || !fsPromisesMod || !pathMod || !osMod) {
    throw new Error("Desktop filesystem modules are unavailable in this runtime.");
  }

  const mergedFsSync: DesktopFsSyncModule = options?.fsSync
    ? {
        existsSync: options.fsSync.existsSync ?? fsSyncMod.existsSync.bind(fsSyncMod),
        realpathSync: options.fsSync.realpathSync ?? fsSyncMod.realpathSync.bind(fsSyncMod),
      }
    : fsSyncMod;

  const mergedFsPromises: DesktopFsPromisesModule = options?.fsPromises
    ? {
        open: options.fsPromises.open ?? fsPromisesMod.open.bind(fsPromisesMod),
        stat: options.fsPromises.stat ?? fsPromisesMod.stat.bind(fsPromisesMod),
        mkdir: options.fsPromises.mkdir ?? fsPromisesMod.mkdir.bind(fsPromisesMod),
        rename: options.fsPromises.rename ?? fsPromisesMod.rename.bind(fsPromisesMod),
        rm: options.fsPromises.rm ?? fsPromisesMod.rm.bind(fsPromisesMod),
        unlink: options.fsPromises.unlink ?? fsPromisesMod.unlink.bind(fsPromisesMod),
        readFile: options.fsPromises.readFile ?? fsPromisesMod.readFile.bind(fsPromisesMod),
        writeFile: options.fsPromises.writeFile ?? fsPromisesMod.writeFile.bind(fsPromisesMod),
      }
    : fsPromisesMod;

  return {
    platform: options?.platform ?? osMod.platform(),
    homedir: options?.homedir ?? osMod.homedir(),
    env: options?.env ?? processMod?.env ?? {},
    path: pathMod,
    fsSync: mergedFsSync,
    fsPromises: mergedFsPromises,
    crypto: cryptoMod,
    zlib: zlibMod,
    https: httpsMod,
    setTimeout: (callback: () => void, delayMs: number): DesktopTimerHandle => {
      if (typeof window !== "undefined") {
        return window.setTimeout(callback, delayMs);
      }
      if (timersMod) {
        return timersMod.setTimeout(callback, delayMs);
      }
      throw new Error("Timer API is unavailable in this runtime.");
    },
    clearTimeout: (handle: DesktopTimerHandle): void => {
      if (typeof window !== "undefined") {
        if (typeof handle === "number") {
          window.clearTimeout(handle);
        }
        return;
      }
      if (timersMod) {
        timersMod.clearTimeout(handle);
      }
    },
    now: options?.now ?? (() => Date.now()),
  };
}

export function selectPathOps(adapter: DesktopFsAdapter): DesktopPathOps {
  if (adapter.platform === "win32" && adapter.path.win32) {
    return adapter.path.win32;
  }
  if (adapter.platform !== "win32" && adapter.path.posix) {
    return adapter.path.posix;
  }
  return adapter.path;
}

function isRootPath(normalized: string, isWin: boolean): boolean {
  if (isWin) {
    return /^[A-Za-z]:\\?$/.test(normalized) || normalized === "\\";
  }
  return normalized === "/";
}

function stripTrailingSeparators(normalized: string, isWin: boolean): string {
  if (isRootPath(normalized, isWin)) {
    return normalized;
  }
  return isWin ? normalized.replace(/[\\/]+$/, "") : normalized.replace(/\/+$/, "");
}

function expandLeadingHome(rawDir: string, homedir: string, pathOps: DesktopPathOps): string {
  if (rawDir === "~") {
    return homedir;
  }
  if (rawDir.startsWith("~/") || rawDir.startsWith("~\\")) {
    return pathOps.join(homedir, rawDir.slice(2));
  }
  return rawDir;
}

/**
 * Resolve symlinks on the deepest existing ancestor so non-existent child directories
 * inside symlinked roots (such as macOS `/var` -> `/private/var`) still canonicalize accurately.
 */
export function resolveCanonicalPath(
  rawPath: string,
  adapter: DesktopFsAdapter,
): string {
  const isWin = adapter.platform === "win32";
  const pathOps = selectPathOps(adapter);
  const normalized = stripTrailingSeparators(pathOps.normalize(rawPath), isWin);

  const trailingSegments: string[] = [];
  let current = normalized;
  const MAX_CANONICAL_WALK_DEPTH = 1024;

  for (let depth = 0; depth < MAX_CANONICAL_WALK_DEPTH; depth += 1) {
    try {
      if (adapter.fsSync.existsSync(current)) {
        const realBase = adapter.fsSync.realpathSync(current);
        if (trailingSegments.length === 0) {
          return stripTrailingSeparators(pathOps.normalize(realBase), isWin);
        }
        const rebuilt = pathOps.join(realBase, ...[...trailingSegments].reverse());
        return stripTrailingSeparators(pathOps.normalize(rebuilt), isWin);
      }
    } catch {
      // Walk up to parent directory if intermediate lookup fails.
    }

    const parent = pathOps.dirname(current);
    if (!parent || parent === current) {
      return normalized;
    }
    const leaf = pathOps.basename(current);
    if (leaf) {
      trailingSegments.push(leaf);
    }
    current = parent;
  }

  throw new Error("Model cache path exceeds maximum directory nesting depth (1024).");
}

/**
 * Extract the filesystem base path from an Obsidian `DataAdapter` when running on desktop.
 */
export function getVaultBasePath(
  vaultAdapter: { getBasePath?: () => string } | null | undefined,
): string | null {
  if (!vaultAdapter || typeof vaultAdapter.getBasePath !== "function") {
    return null;
  }
  try {
    const base = vaultAdapter.getBasePath().trim();
    return base.length > 0 ? base : null;
  } catch {
    return null;
  }
}

/**
 * Enforce that `targetDir` is neither equal to `vaultBasePath` nor nested anywhere inside it.
 * Protects Obsidian Sync, iCloud, and Vault Git repositories from 200+ MB speech model binaries.
 */
export function assertPathOutsideVault(
  targetDir: string,
  vaultBasePath: string | null | undefined,
  adapter?: DesktopFsAdapter,
): void {
  if (!vaultBasePath || vaultBasePath.trim().length === 0) {
    return;
  }
  const fsAdapter = adapter ?? createDesktopFsAdapter();
  const isWin = fsAdapter.platform === "win32";
  const pathOps = selectPathOps(fsAdapter);

  const expandedTarget = expandLeadingHome(targetDir.trim(), fsAdapter.homedir, pathOps);
  const expandedVault = expandLeadingHome(vaultBasePath.trim(), fsAdapter.homedir, pathOps);

  if (!pathOps.isAbsolute(expandedTarget)) {
    throw new Error(VAULT_ISOLATION_ERROR_MESSAGE);
  }

  const canonicalTarget = resolveCanonicalPath(expandedTarget, fsAdapter);
  const canonicalVault = resolveCanonicalPath(expandedVault, fsAdapter);

  const targetComparable = isWin ? canonicalTarget.toLowerCase() : canonicalTarget;
  const vaultComparable = isWin ? canonicalVault.toLowerCase() : canonicalVault;

  if (targetComparable === vaultComparable) {
    throw new Error(VAULT_ISOLATION_ERROR_MESSAGE);
  }

  const rel = pathOps.relative(vaultComparable, targetComparable);
  if (
    rel === "" ||
    (!rel.startsWith(`..${pathOps.sep}`) && rel !== ".." && !pathOps.isAbsolute(rel))
  ) {
    throw new Error(VAULT_ISOLATION_ERROR_MESSAGE);
  }
}

export interface ResolveExternalModelCacheDirOptions {
  readonly customDir?: string;
  readonly vaultBasePath?: string | null;
  readonly adapter?: DesktopFsAdapter;
}

/**
 * Resolve the external (out-of-Vault) speech model cache directory for the current desktop OS:
 * - Windows: `%LOCALAPPDATA%\voice-mode\models` (fallback `~/AppData/Local/voice-mode/models`)
 * - Linux: `$XDG_CACHE_HOME/voice-mode/models` when `$XDG_CACHE_HOME` is absolute, else `~/.cache/voice-mode/models`
 * - macOS: `~/.cache/voice-mode/models`
 */
export function resolveExternalModelCacheDir(
  options?: ResolveExternalModelCacheDirOptions,
): string {
  const fsAdapter = options?.adapter ?? createDesktopFsAdapter();
  const isWin = fsAdapter.platform === "win32";
  const pathOps = selectPathOps(fsAdapter);
  const homedir = fsAdapter.homedir.trim();
  if (!homedir) {
    throw new Error("Could not determine user home directory for external model cache.");
  }

  let candidate: string;
  const rawCustom = options?.customDir?.trim() ?? "";

  if (rawCustom.length > 0) {
    const expanded = expandLeadingHome(rawCustom, homedir, pathOps);
    if (!pathOps.isAbsolute(expanded)) {
      throw new Error("Custom model cache directory must be an absolute path or start with ~/.");
    }
    candidate = expanded;
  } else if (isWin) {
    const localAppData = fsAdapter.env.LOCALAPPDATA?.trim() ?? "";
    candidate =
      localAppData.length > 0 && pathOps.isAbsolute(localAppData)
        ? pathOps.join(localAppData, "voice-mode", "models")
        : pathOps.join(homedir, "AppData", "Local", "voice-mode", "models");
  } else if (fsAdapter.platform === "linux") {
    const xdgCacheHome = fsAdapter.env.XDG_CACHE_HOME?.trim() ?? "";
    candidate =
      xdgCacheHome.length > 0 && pathOps.isAbsolute(xdgCacheHome)
        ? pathOps.join(xdgCacheHome, "voice-mode", "models")
        : pathOps.join(homedir, ".cache", "voice-mode", "models");
  } else {
    candidate = pathOps.join(homedir, ".cache", "voice-mode", "models");
  }

  const normalized = stripTrailingSeparators(pathOps.normalize(candidate), isWin);
  assertPathOutsideVault(normalized, options?.vaultBasePath, fsAdapter);
  return normalized;
}

/**
 * Read an entire file directly into a single standalone `ArrayBuffer` via positional
 * `FileHandle.read`, avoiding Node `Buffer` slab retention on the renderer main thread.
 */
export async function readFileAsArrayBuffer(
  filePath: string,
  adapter?: DesktopFsAdapter,
): Promise<ArrayBuffer> {
  const fsAdapter = adapter ?? createDesktopFsAdapter();
  const fh = await fsAdapter.fsPromises.open(filePath, "r");
  try {
    const stat = await fh.stat();
    const totalBytes = stat.size;
    const buffer = new ArrayBuffer(totalBytes);
    if (totalBytes === 0) {
      return buffer;
    }

    const view = new Uint8Array(buffer);
    let offset = 0;
    while (offset < totalBytes) {
      const { bytesRead } = await fh.read(view, offset, totalBytes - offset, offset);
      if (bytesRead <= 0) {
        throw new Error(
          `Unexpected end of file while reading "${filePath}" (${offset}/${totalBytes} bytes).`,
        );
      }
      offset += bytesRead;
    }
    return buffer;
  } finally {
    await fh.close();
  }
}

function bytesToLowerHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    const b = bytes[i] ?? 0;
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Compute lowercase hex SHA256 digest of an in-memory `Uint8Array`.
 */
export async function computeBytesSha256(
  data: Uint8Array,
  adapter?: DesktopFsAdapter,
): Promise<string> {
  const cryptoMod = adapter?.crypto ?? loadDesktopModule<DesktopCryptoModule>(MOD_CRYPTO);
  if (cryptoMod) {
    return cryptoMod.createHash("sha256").update(data).digest("hex").toLowerCase();
  }
  if (typeof window !== "undefined" && window.crypto?.subtle) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    const digest = await window.crypto.subtle.digest("SHA-256", copy.buffer);
    return bytesToLowerHex(new Uint8Array(digest));
  }
  throw new Error("SHA256 hashing is unavailable in this runtime.");
}

/**
 * Stream a file in bounded <= 1 MB chunks through SHA256 so verifying a 239 MB `.onnx`
 * model never allocates a second full-file copy in memory.
 */
export async function computeFileSha256(
  filePath: string,
  adapter?: DesktopFsAdapter,
): Promise<string> {
  const fsAdapter = adapter ?? createDesktopFsAdapter();
  if (fsAdapter.crypto) {
    const fh = await fsAdapter.fsPromises.open(filePath, "r");
    try {
      const stat = await fh.stat();
      const hash = fsAdapter.crypto.createHash("sha256");
      if (stat.size === 0) {
        return hash.digest("hex").toLowerCase();
      }
      const chunkLen = Math.min(stat.size, HASH_STREAM_CHUNK_BYTES);
      const scratch = new Uint8Array(chunkLen);
      let offset = 0;
      while (offset < stat.size) {
        const toRead = Math.min(scratch.byteLength, stat.size - offset);
        const { bytesRead } = await fh.read(scratch, 0, toRead, offset);
        if (bytesRead <= 0) {
          throw new Error(
            `Unexpected end of file while hashing "${filePath}" (${offset}/${stat.size} bytes).`,
          );
        }
        hash.update(scratch.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return hash.digest("hex").toLowerCase();
    } finally {
      await fh.close();
    }
  }

  const ab = await readFileAsArrayBuffer(filePath, fsAdapter);
  return computeBytesSha256(new Uint8Array(ab), fsAdapter);
}

interface DesktopElectronModule {
  readonly shell?: {
    openPath?: (fullPath: string) => Promise<string>;
  };
}

/**
 * Create (if missing) and open the external model cache folder in the desktop OS file manager.
 */
export async function openExternalDirectory(
  dirPath: string,
  options?: LoadDesktopModuleOptions & { readonly adapter?: DesktopFsAdapter },
): Promise<void> {
  const fsAdapter = options?.adapter ?? createDesktopFsAdapter(options);
  await fsAdapter.fsPromises.mkdir(dirPath, { recursive: true });
  const electronMod = loadDesktopModule<DesktopElectronModule>(MOD_ELECTRON, options);
  const openPath = electronMod?.shell?.openPath;
  if (typeof openPath !== "function") {
    throw new Error("Desktop shell integration is unavailable in this environment.");
  }
  const errMessage = await openPath(dirPath);
  if (errMessage) {
    throw new Error(errMessage);
  }
}
