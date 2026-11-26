import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import zlib from "node:zlib";

import { insertIntoFocusedInput } from "../src/editor-bridge.ts";
import {
  VAULT_ISOLATION_ERROR_MESSAGE,
  assertPathOutsideVault,
  computeBytesSha256,
  computeFileSha256,
  createDesktopFsAdapter,
  getVaultBasePath,
  loadDesktopModule,
  readFileAsArrayBuffer,
  resolveExternalModelCacheDir,
} from "../src/desktop-fs.ts";
import {
  DesktopModelManager,
  SENSEVOICE_MODEL_BUNDLE,
  SHERPA_WASM_TARBALL,
  VAD_MODEL_BUNDLE,
  WASM_ALLOWED_HOSTNAMES,
  extractPinnedTarEntries,
  isWasmRedirectHostAllowed,
} from "../src/model-manager.ts";

const nodeRequire = createRequire(import.meta.url);
const TEXT_ENCODER = new TextEncoder();

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeTestAdapter(overrides = {}) {
  return createDesktopFsAdapter({
    isDesktop: true,
    win: { require: nodeRequire },
    ...overrides,
  });
}

function writeTarString(buf, offset, maxLen, text) {
  const encoded = TEXT_ENCODER.encode(text);
  const count = Math.min(encoded.byteLength, maxLen);
  buf.set(encoded.subarray(0, count), offset);
}

/**
 * Construct a minimal standards-compliant USTAR tar archive in memory for unit tests.
 */
function buildUstarArchive(entries) {
  const blocks = [];

  for (const entry of entries) {
    const data =
      entry.data instanceof Uint8Array
        ? entry.data
        : TEXT_ENCODER.encode(entry.data ?? "");
    const header = new Uint8Array(512);
    const typeFlag = entry.typeFlag ?? "0";
    const sizeBytes = typeFlag === "2" || typeFlag === "5" ? 0 : data.byteLength;

    writeTarString(header, 0, 100, entry.name);
    writeTarString(header, 100, 8, "0000644\0");
    writeTarString(header, 108, 8, "0000000\0");
    writeTarString(header, 116, 8, "0000000\0");
    writeTarString(header, 124, 12, `${sizeBytes.toString(8).padStart(11, "0")}\0`);
    writeTarString(header, 136, 12, "00000000000\0");
    // Fill checksum field with spaces (0x20) while computing header checksum.
    header.fill(0x20, 148, 156);
    header[156] = typeFlag.charCodeAt(0);
    if (entry.linkName) {
      writeTarString(header, 157, 100, entry.linkName);
    }
    writeTarString(header, 257, 6, "ustar\0");
    writeTarString(header, 263, 2, "00");

    let checksum = 0;
    for (let i = 0; i < 512; i += 1) {
      checksum += header[i];
    }
    writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header);

    if (sizeBytes > 0) {
      const paddedLen = Math.ceil(sizeBytes / 512) * 512;
      const payloadBlock = new Uint8Array(paddedLen);
      payloadBlock.set(data.subarray(0, sizeBytes), 0);
      blocks.push(payloadBlock);
    }
  }

  // End-of-archive marker: two 512-byte zero blocks.
  blocks.push(new Uint8Array(1024));

  const total = blocks.reduce((sum, b) => sum + b.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const block of blocks) {
    out.set(block, pos);
    pos += block.byteLength;
  }
  return out;
}

function buildSmallFixtureManifest() {
  const vadBytes = TEXT_ENCODER.encode("fixture-silero-vad-onnx-payload-v1");
  const senseModelBytes = new Uint8Array(4096);
  for (let i = 0; i < senseModelBytes.byteLength; i += 1) {
    senseModelBytes[i] = (i * 31 + 7) & 0xff;
  }
  const tokensBytes = TEXT_ENCODER.encode("<blk> 0\nhello 1\nworld 2\n");

  const wasmFilesMap = new Map([
    ["sherpa-onnx-wasm-nodejs.wasm", new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])],
    ["sherpa-onnx-wasm-nodejs.js", TEXT_ENCODER.encode("// wasm glue fixture\n")],
    ["sherpa-onnx-asr.js", TEXT_ENCODER.encode("// asr glue fixture\n")],
    ["sherpa-onnx-vad.js", TEXT_ENCODER.encode("// vad glue fixture\n")],
    ["sherpa-onnx-tts.js", TEXT_ENCODER.encode("// tts glue fixture\n")],
  ]);

  const tarRaw = buildUstarArchive([
    { name: "package/package.json", data: '{"name":"sherpa-onnx","version":"2.0.2"}' },
    ...Array.from(wasmFilesMap.entries()).map(([name, data]) => ({
      name: `package/${name}`,
      data,
    })),
  ]);
  const tgzBytes = new Uint8Array(zlib.gzipSync(tarRaw));

  const vadBundle = {
    id: "vad",
    label: "Fixture VAD",
    repo: "csukuangfj/vad",
    revision: "rev-vad-1",
    license: "MIT",
    files: [
      {
        revision: "rev-vad-1",
        file: "silero_vad.onnx",
        sha256: sha256Hex(vadBytes),
        bytes: vadBytes.byteLength,
      },
    ],
  };

  const senseVoiceBundle = {
    id: "sensevoice",
    label: "Fixture SenseVoice",
    repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    revision: "rev-sv-1",
    license: "FunAudioLLM",
    files: [
      {
        revision: "rev-sv-1",
        file: "model.int8.onnx",
        sha256: sha256Hex(senseModelBytes),
        bytes: senseModelBytes.byteLength,
      },
      {
        revision: "rev-sv-1",
        file: "tokens.txt",
        sha256: sha256Hex(tokensBytes),
        bytes: tokensBytes.byteLength,
      },
    ],
  };

  const wasmTarball = {
    id: "sherpa-onnx-2.0.2",
    version: "2.0.2",
    tarballPath: "/sherpa-onnx/-/sherpa-onnx-2.0.2.tgz",
    sha256: sha256Hex(tgzBytes),
    bytes: tgzBytes.byteLength,
    primaryHost: "https://registry.npmjs.org",
    fallbackHost: "https://registry.npmmirror.com",
    allowedHosts: WASM_ALLOWED_HOSTNAMES,
    license: "Apache-2.0",
    files: Array.from(wasmFilesMap.entries()).map(([file, bytes]) => ({
      file,
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
    })),
  };

  return {
    vadBytes,
    senseModelBytes,
    tokensBytes,
    wasmFilesMap,
    tgzBytes,
    vadBundle,
    senseVoiceBundle,
    wasmTarball,
  };
}

function streamChunks(bytes, chunkSize = 512) {
  return {
    async *[Symbol.asyncIterator]() {
      for (let off = 0; off < bytes.byteLength; off += chunkSize) {
        yield bytes.subarray(off, Math.min(bytes.byteLength, off + chunkSize));
      }
    },
  };
}

describe("editor-bridge M1 synthetic ClipboardEvent('paste') for Lexical / ProseMirror vs plain contenteditable", () => {
  class MockDataTransfer {
    constructor() {
      this._store = new Map();
    }
    setData(format, value) {
      this._store.set(format, String(value));
    }
    getData(format) {
      return this._store.get(format) ?? "";
    }
  }

  class MockClipboardEvent extends Event {
    constructor(type, init = {}) {
      super(type, { bubbles: Boolean(init.bubbles), cancelable: Boolean(init.cancelable) });
      this.clipboardData = init.clipboardData ?? null;
    }
  }

  it("dispatches in-memory ClipboardEvent('paste') into Lexical/ProseMirror contenteditable without Range fallback", () => {
    const lexicalBuffer = [];
    const undoStack = [];
    let getSelectionCalled = 0;
    let appendChildCalled = 0;

    const mockWindow = {
      DataTransfer: MockDataTransfer,
      ClipboardEvent: MockClipboardEvent,
      Event,
      getSelection: () => {
        getSelectionCalled += 1;
        return null;
      },
    };

    const lexicalEditable = new EventTarget();
    lexicalEditable.tagName = "DIV";
    lexicalEditable.isContentEditable = true;
    lexicalEditable.appendChild = () => {
      appendChildCalled += 1;
    };
    lexicalEditable.addEventListener("paste", (evt) => {
      const text = evt.clipboardData?.getData("text/plain") ?? "";
      if (text) {
        evt.preventDefault();
        undoStack.push([...lexicalBuffer]);
        lexicalBuffer.push(text);
      }
    });

    const doc = {
      activeElement: lexicalEditable,
      defaultView: mockWindow,
      createTextNode: (t) => ({ nodeType: 3, textContent: t }),
    };
    lexicalEditable.ownerDocument = doc;

    assert.equal(insertIntoFocusedInput(doc, "  Hello Copilot  "), true);
    assert.equal(insertIntoFocusedInput(doc, "Line one\nLine two"), true);

    assert.deepEqual(lexicalBuffer, ["Hello Copilot", "Line one\nLine two"]);
    assert.equal(undoStack.length, 2);
    assert.equal(getSelectionCalled, 0);
    assert.equal(appendChildCalled, 0);
  });

  it("falls back to Selection/Range.insertNode + InputEvent when contenteditable does not preventDefault on paste", () => {
    const dispatchedTypes = [];
    const insertedNodes = [];
    let rangeCollapsed = false;

    const mockWindow = {
      DataTransfer: MockDataTransfer,
      ClipboardEvent: MockClipboardEvent,
      Event,
      getSelection: () => ({
        rangeCount: 1,
        getRangeAt: () => mockRange,
        removeAllRanges: () => {},
        addRange: () => {},
      }),
    };

    const plainEditable = new EventTarget();
    plainEditable.tagName = "DIV";
    plainEditable.isContentEditable = true;
    plainEditable.contains = (node) => node === plainEditable;
    plainEditable.addEventListener("paste", (evt) => {
      dispatchedTypes.push(`paste:defaultPrevented=${evt.defaultPrevented}`);
      // Plain unmanaged contenteditable does not call evt.preventDefault().
    });
    plainEditable.addEventListener("input", () => {
      dispatchedTypes.push("input");
    });

    const mockRange = {
      commonAncestorContainer: plainEditable,
      deleteContents: () => {},
      insertNode: (node) => insertedNodes.push(node),
      setStartAfter: () => {},
      collapse: (toStart) => {
        rangeCollapsed = toStart;
      },
    };

    const doc = {
      activeElement: plainEditable,
      defaultView: mockWindow,
      createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    };
    plainEditable.ownerDocument = doc;

    assert.equal(insertIntoFocusedInput(doc, "plain text fallback"), true);
    assert.deepEqual(dispatchedTypes, ["paste:defaultPrevented=false", "input"]);
    assert.deepEqual(insertedNodes, [{ nodeType: 3, textContent: "plain text fallback" }]);
    assert.equal(rangeCollapsed, true);
  });
});

describe("desktop-fs external cache resolution, hard Vault-isolation guard, and zero-copy I/O", () => {
  it("resolves OS-specific default cache directories and expands leading ~/ on customDir", () => {
    const macAdapter = makeTestAdapter({
      platform: "darwin",
      homedir: "/Users/alice",
      env: {},
    });
    assert.equal(
      resolveExternalModelCacheDir({ adapter: macAdapter }),
      "/Users/alice/.cache/voice-mode/models",
    );
    assert.equal(
      resolveExternalModelCacheDir({
        customDir: "~/Library/Caches/custom-voice-models/",
        adapter: macAdapter,
      }),
      "/Users/alice/Library/Caches/custom-voice-models",
    );

    const linuxWithXdg = makeTestAdapter({
      platform: "linux",
      homedir: "/home/alice",
      env: { XDG_CACHE_HOME: "/run/user/1000/xdg-cache" },
    });
    assert.equal(
      resolveExternalModelCacheDir({ adapter: linuxWithXdg }),
      "/run/user/1000/xdg-cache/voice-mode/models",
    );

    // Relative $XDG_CACHE_HOME must be ignored per XDG Base Directory spec.
    const linuxRelativeXdg = makeTestAdapter({
      platform: "linux",
      homedir: "/home/alice",
      env: { XDG_CACHE_HOME: "relative/cache" },
    });
    assert.equal(
      resolveExternalModelCacheDir({ adapter: linuxRelativeXdg }),
      "/home/alice/.cache/voice-mode/models",
    );

    const winWithLocalAppData = makeTestAdapter({
      platform: "win32",
      homedir: "C:\\Users\\Alice",
      env: { LOCALAPPDATA: "D:\\LocalCache" },
    });
    assert.equal(
      resolveExternalModelCacheDir({ adapter: winWithLocalAppData }),
      "D:\\LocalCache\\voice-mode\\models",
    );

    const winFallback = makeTestAdapter({
      platform: "win32",
      homedir: "C:\\Users\\Alice",
      env: {},
    });
    assert.equal(
      resolveExternalModelCacheDir({ adapter: winFallback }),
      "C:\\Users\\Alice\\AppData\\Local\\voice-mode\\models",
    );
  });

  it("rejects cache paths equal to or nested inside the Vault (including symlinks and Windows case differences)", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-vault-guard-"));
    try {
      const realVault = path.join(tmpRoot, "MyVault");
      const symlinkVault = path.join(tmpRoot, "MyVaultLink");
      const siblingCache = path.join(tmpRoot, "MyVault-ExternalModels");
      await fsp.mkdir(realVault, { recursive: true });
      await fsp.symlink(realVault, symlinkVault);

      const adapter = makeTestAdapter();

      // Exact match and trailing-slash match must throw.
      assert.throws(
        () => assertPathOutsideVault(realVault, realVault, adapter),
        { message: VAULT_ISOLATION_ERROR_MESSAGE },
      );
      assert.throws(
        () => assertPathOutsideVault(`${realVault}/`, realVault, adapter),
        { message: VAULT_ISOLATION_ERROR_MESSAGE },
      );

      // Non-existent nested path inside symlinked Vault must still be caught via ancestor realpath.
      assert.throws(
        () =>
          resolveExternalModelCacheDir({
            customDir: path.join(symlinkVault, "nested", "models"),
            vaultBasePath: realVault,
            adapter,
          }),
        { message: VAULT_ISOLATION_ERROR_MESSAGE },
      );
      assert.throws(
        () =>
          resolveExternalModelCacheDir({
            customDir: path.join(realVault, "models"),
            vaultBasePath: symlinkVault,
            adapter,
          }),
        { message: VAULT_ISOLATION_ERROR_MESSAGE },
      );

      // Sibling directory sharing a prefix ("MyVault-ExternalModels") must be allowed.
      const allowedSibling = resolveExternalModelCacheDir({
        customDir: siblingCache,
        vaultBasePath: realVault,
        adapter,
      });
      assert.ok(allowedSibling.endsWith("MyVault-ExternalModels"));

      // Windows case-insensitive comparison must reject nested path regardless of letter casing.
      const winAdapter = makeTestAdapter({
        platform: "win32",
        homedir: "C:\\Users\\Alice",
      });
      assert.throws(
        () =>
          assertPathOutsideVault(
            "c:\\users\\alice\\documents\\vault\\models",
            "C:\\Users\\Alice\\Documents\\Vault",
            winAdapter,
          ),
        { message: VAULT_ISOLATION_ERROR_MESSAGE },
      );

      // Mobile / non-desktop guard on loadDesktopModule and getVaultBasePath helper.
      assert.equal(loadDesktopModule("fs", { isDesktop: false, win: { require: nodeRequire } }), null);
      assert.equal(loadDesktopModule("fs", { isDesktop: true, win: {} }), null);
      assert.equal(getVaultBasePath({ getBasePath: () => `  ${realVault}  ` }), realVault);
      assert.equal(getVaultBasePath({}), null);
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reads files into standalone zero-copy ArrayBuffers and streams SHA256 accurately", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-ab-sha-"));
    try {
      const adapter = makeTestAdapter();
      const payload = crypto.randomBytes(1500 * 1024); // 1.5 MB (> 1 MB hash stream chunk size)
      const expectedSha = sha256Hex(payload);
      const filePath = path.join(tmpDir, "weights.onnx");
      await fsp.writeFile(filePath, payload);

      const ab = await readFileAsArrayBuffer(filePath, adapter);
      assert.equal(ab instanceof ArrayBuffer, true);
      assert.equal(ab.byteLength, payload.byteLength);
      assert.equal(Buffer.compare(Buffer.from(ab), payload), 0);

      const streamedSha = await computeFileSha256(filePath, adapter);
      const bytesSha = await computeBytesSha256(new Uint8Array(ab), adapter);
      assert.equal(streamedSha, expectedSha);
      assert.equal(bytesSha, expectedSha);
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("DesktopModelManager offline verification, redirect security, resume, mirror failover, and .tgz extraction", () => {
  it("exposes exact pinned SHA256 digests and upstream revisions for VAD, SenseVoice, and sherpa-onnx@2.0.2 WASM", () => {
    assert.equal(VAD_MODEL_BUNDLE.repo, "csukuangfj/vad");
    assert.equal(VAD_MODEL_BUNDLE.revision, "fba88cd2e921609e7675c3aaf51e0b9b295da4bc");
    assert.equal(
      VAD_MODEL_BUNDLE.files[0].sha256,
      "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28",
    );

    assert.equal(
      SENSEVOICE_MODEL_BUNDLE.repo,
      "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    );
    assert.equal(
      SENSEVOICE_MODEL_BUNDLE.revision,
      "2365baeacb507f821a0c8120fcee3d484dba7a07",
    );
    assert.equal(
      SENSEVOICE_MODEL_BUNDLE.files[0].sha256,
      "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51",
    );
    assert.equal(
      SENSEVOICE_MODEL_BUNDLE.files[1].sha256,
      "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc",
    );

    assert.equal(
      SHERPA_WASM_TARBALL.sha256,
      "76dbb43b7f10bbed58c187543b6827d4f24d5f174750899913866a2d1c9c5d30",
    );
    assert.equal(SHERPA_WASM_TARBALL.files.length, 5);
    assert.equal(isWasmRedirectHostAllowed("https://cdn.npmmirror.com/packages/sherpa.tgz"), true);
    assert.equal(isWasmRedirectHostAllowed("http://registry.npmjs.org/sherpa.tgz"), false);
    assert.equal(isWasmRedirectHostAllowed("https://evil.example.com/sherpa.tgz"), false);
  });

  it("verifies pre-existing cached models and loads Worker binaries with 0 network calls", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-offline-cache-"));
    try {
      const cacheDir = path.join(tmpRoot, "cache");
      const vaultDir = path.join(tmpRoot, "vault");
      await fsp.mkdir(vaultDir, { recursive: true });

      const fx = buildSmallFixtureManifest();
      await fsp.mkdir(path.join(cacheDir, fx.vadBundle.repo), { recursive: true });
      await fsp.writeFile(
        path.join(cacheDir, fx.vadBundle.repo, "silero_vad.onnx"),
        fx.vadBytes,
      );

      await fsp.mkdir(path.join(cacheDir, fx.senseVoiceBundle.repo), { recursive: true });
      await fsp.writeFile(
        path.join(cacheDir, fx.senseVoiceBundle.repo, "model.int8.onnx"),
        fx.senseModelBytes,
      );
      await fsp.writeFile(
        path.join(cacheDir, fx.senseVoiceBundle.repo, "tokens.txt"),
        fx.tokensBytes,
      );

      const wasmDir = path.join(cacheDir, "wasm", fx.wasmTarball.id);
      await fsp.mkdir(wasmDir, { recursive: true });
      for (const [name, bytes] of fx.wasmFilesMap.entries()) {
        await fsp.writeFile(path.join(wasmDir, name), bytes);
      }

      let networkCalls = 0;
      const manager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vaultBasePath: vaultDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter: makeTestAdapter(),
        httpStreamFetch: async () => {
          networkCalls += 1;
          throw new Error("Network must never be called during offline checkStatus/loadLocalAssets.");
        },
      });

      const coldStatus = await manager.checkStatus();
      assert.equal(networkCalls, 0);
      assert.equal(coldStatus.ready, true);
      assert.equal(coldStatus.vadReady, true);
      assert.equal(coldStatus.senseVoiceReady, true);
      assert.equal(coldStatus.wasmReady, true);
      assert.equal(coldStatus.verifiedFiles.length, 8);
      assert.deepEqual(coldStatus.missingOrCorruptFiles, []);

      // Warm check uses ${size}:${ino}:${ctimeMs}:${sha256} fingerprint cache.
      const warmStatus = await manager.checkStatus();
      assert.equal(warmStatus.ready, true);
      assert.ok(warmStatus.elapsedMs < 50);

      const asrWithWasm = await manager.readTargetBinaries("asr-offline", true);
      assert.equal(asrWithWasm.length, 3);
      assert.deepEqual(
        asrWithWasm.map((b) => b.name),
        ["sherpa-onnx-wasm-nodejs.wasm", "model.int8.onnx", "tokens.txt"],
      );

      const loaded = await manager.loadLocalAssets();
      assert.equal(networkCalls, 0);
      assert.ok(loaded.glue.wasmJs.includes("wasm glue fixture"));
      assert.equal(loaded.vadBinaries.length, 1);
      assert.equal(loaded.asrBinaries.length, 2);

      // Corrupting a single byte must invalidate the stat/sha256 verification and flag the file.
      const tamperedTokens = new Uint8Array(fx.tokensBytes);
      tamperedTokens[0] ^= 0xff;
      await fsp.writeFile(
        path.join(cacheDir, fx.senseVoiceBundle.repo, "tokens.txt"),
        tamperedTokens,
      );
      const afterTamper = await manager.checkStatus();
      assert.equal(afterTamper.ready, false);
      assert.equal(afterTamper.senseVoiceReady, false);
      assert.deepEqual(afterTamper.missingOrCorruptFiles, [
        `${fx.senseVoiceBundle.repo}/tokens.txt`,
      ]);
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("enforces hop-by-hop redirect host allowlist and blocks rogue redirect targets before following", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-redirect-guard-"));
    try {
      const cacheDir = path.join(tmpRoot, "cache");
      const fx = buildSmallFixtureManifest();
      const requestedUrls = [];

      const rogueManager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter: makeTestAdapter(),
        httpStreamFetch: async (req) => {
          requestedUrls.push(req.url);
          assert.equal("authorization" in req.headers, false);
          assert.equal("cookie" in req.headers, false);
          return {
            statusCode: 302,
            headers: { location: "https://evil-attacker.example.com/silero_vad.onnx" },
            body: streamChunks(new Uint8Array(0)),
          };
        },
      });

      await assert.rejects(
        () => rogueManager.downloadDictationStack(),
        /Blocked redirect to disallowed host/,
      );
      assert.equal(requestedUrls.length, 1);
      assert.equal(
        requestedUrls.some((u) => u.includes("evil-attacker.example.com")),
        false,
      );

      // Also block downgrade to plaintext HTTP on an otherwise allowlisted hostname.
      const downgradeManager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter: makeTestAdapter(),
        httpStreamFetch: async () => ({
          statusCode: 301,
          headers: { location: "http://huggingface.co/csukuangfj/vad/silero_vad.onnx" },
          body: streamChunks(new Uint8Array(0)),
        }),
      });
      await assert.rejects(
        () => downgradeManager.downloadDictationStack(),
        /Blocked redirect to disallowed host/,
      );
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("supports .part HTTP 206 resume vs HTTP 200 overwrite, SHA256 mismatch deletion + mirror fallback, and clearCachedModels()", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-resume-mirror-"));
    try {
      const cacheDir = path.join(tmpRoot, "cache");
      const vaultDir = path.join(tmpRoot, "vault");
      await fsp.mkdir(vaultDir, { recursive: true });
      const fx = buildSmallFixtureManifest();

      // Pre-seed partial .part files to verify:
      // 1) model.int8.onnx: interrupted at 1500 bytes -> resumed via 302 CDN redirect + HTTP 206 Range append
      // 2) tokens.txt: stale .part of 10 bytes -> server ignores Range and replies HTTP 200 full body (must overwrite from 0)
      // 3) silero_vad.onnx: primary mirror returns corrupted bytes (SHA256 mismatch) -> .part deleted -> hf-mirror.com succeeds!
      const svDir = path.join(cacheDir, fx.senseVoiceBundle.repo);
      await fsp.mkdir(svDir, { recursive: true });
      await fsp.writeFile(
        path.join(svDir, "model.int8.onnx.part"),
        fx.senseModelBytes.subarray(0, 1500),
      );
      await fsp.writeFile(
        path.join(svDir, "tokens.txt.part"),
        TEXT_ENCODER.encode("STALE_PART"),
      );

      const seenRequests = [];
      const progressEvents = [];

      const manager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vaultBasePath: vaultDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter: makeTestAdapter(),
        httpStreamFetch: async (req) => {
          seenRequests.push({ url: req.url, headers: { ...req.headers } });

          // 1. VAD: primary returns tampered payload -> triggers SHA256 mismatch & fallback to hf-mirror.com
          if (req.url.includes("huggingface.co/csukuangfj/vad/")) {
            const bad = new Uint8Array(fx.vadBytes);
            bad[bad.length - 1] ^= 0xff;
            return {
              statusCode: 200,
              headers: { "content-length": String(bad.byteLength) },
              body: streamChunks(bad, 10),
            };
          }
          if (req.url.includes("hf-mirror.com/csukuangfj/vad/")) {
            return {
              statusCode: 200,
              headers: { "content-length": String(fx.vadBytes.byteLength) },
              body: streamChunks(fx.vadBytes, 10),
            };
          }

          // 2. SenseVoice model.int8.onnx: 302 redirect to allowlisted subdomain cdn-lfs.huggingface.co + 206 resume
          if (req.url.startsWith("https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice")) {
            if (req.url.endsWith("/model.int8.onnx")) {
              return {
                statusCode: 302,
                headers: {
                  location: "https://cdn-lfs.huggingface.co/repos/sensevoice/model.int8.onnx",
                },
                body: streamChunks(new Uint8Array(0)),
              };
            }
            if (req.url.endsWith("/tokens.txt")) {
              // Server ignores Range header and returns 200 with full file.
              assert.equal(req.headers.Range, "bytes=10-");
              return {
                statusCode: 200,
                headers: { "content-length": String(fx.tokensBytes.byteLength) },
                body: streamChunks(fx.tokensBytes),
              };
            }
          }

          if (req.url === "https://cdn-lfs.huggingface.co/repos/sensevoice/model.int8.onnx") {
            assert.equal(req.headers.Range, "bytes=1500-");
            const remaining = fx.senseModelBytes.subarray(1500);
            return {
              statusCode: 206,
              headers: {
                "content-range": `bytes 1500-${fx.senseModelBytes.byteLength - 1}/${fx.senseModelBytes.byteLength}`,
                "content-length": String(remaining.byteLength),
              },
              body: streamChunks(remaining, 600),
            };
          }

          // 3. WASM tarball: primary registry 503 -> fallback registry.npmmirror.com 302 -> cdn.npmmirror.com 200
          if (req.url.startsWith("https://registry.npmjs.org/")) {
            return {
              statusCode: 503,
              headers: {},
              body: streamChunks(new Uint8Array(0)),
            };
          }
          if (req.url.startsWith("https://registry.npmmirror.com/")) {
            return {
              statusCode: 302,
              headers: {
                location: "https://cdn.npmmirror.com/packages/sherpa-onnx/2.0.2/sherpa-onnx-2.0.2.tgz",
              },
              body: streamChunks(new Uint8Array(0)),
            };
          }
          if (req.url.startsWith("https://cdn.npmmirror.com/")) {
            return {
              statusCode: 200,
              headers: { "content-length": String(fx.tgzBytes.byteLength) },
              body: streamChunks(fx.tgzBytes, 256),
            };
          }

          throw new Error(`Unexpected test URL: ${req.url}`);
        },
      });

      const status = await manager.downloadDictationStack({
        onProgress: (p) => progressEvents.push(p),
      });

      assert.equal(status.ready, true);
      assert.equal(status.verifiedFiles.length, 8);
      assert.ok(progressEvents.some((p) => p.phase === "downloading"));
      assert.ok(progressEvents.some((p) => p.phase === "extracting"));
      assert.equal(progressEvents.at(-1)?.phase, "complete");

      // Ensure no leftover .part files or temporary .tgz archive remain on disk.
      assert.equal(
        fs.existsSync(path.join(cacheDir, fx.vadBundle.repo, "silero_vad.onnx.part")),
        false,
      );
      assert.equal(fs.existsSync(path.join(svDir, "model.int8.onnx.part")), false);
      assert.equal(
        fs.existsSync(path.join(cacheDir, "wasm", fx.wasmTarball.id, `${fx.wasmTarball.id}.tgz`)),
        false,
      );

      // Verify primary + mirror failover both occurred for VAD and WASM.
      assert.equal(
        seenRequests.some((r) => r.url.includes("huggingface.co/csukuangfj/vad/")),
        true,
      );
      assert.equal(
        seenRequests.some((r) => r.url.includes("hf-mirror.com/csukuangfj/vad/")),
        true,
      );
      assert.equal(
        seenRequests.some((r) => r.url.includes("cdn.npmmirror.com/")),
        true,
      );

      // Place an unrelated user note/folder in cacheDir to ensure clearCachedModels() only removes managed subdirs.
      const unrelatedDir = path.join(cacheDir, "keep-custom-notes");
      await fsp.mkdir(unrelatedDir, { recursive: true });
      await manager.clearCachedModels();

      const afterClear = await manager.checkStatus();
      assert.equal(afterClear.ready, false);
      assert.equal(afterClear.verifiedFiles.length, 0);
      assert.equal(fs.existsSync(unrelatedDir), true);
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("preserves .part file on mid-stream network interruption and rejects tar traversal or symlinks", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-part-tar-sec-"));
    try {
      const cacheDir = path.join(tmpRoot, "cache");
      const fx = buildSmallFixtureManifest();

      // 1. Mid-stream network error preserves .part file for future resume.
      const interruptedManager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter: makeTestAdapter(),
        httpStreamFetch: async () => ({
          statusCode: 200,
          headers: { "content-length": String(fx.vadBytes.byteLength) },
          body: {
            async *[Symbol.asyncIterator]() {
              yield fx.vadBytes.subarray(0, 12);
              throw new Error("Simulated socket hang up");
            },
          },
        }),
      });

      await assert.rejects(
        () => interruptedManager.downloadDictationStack(),
        /Simulated socket hang up/,
      );
      const preservedPart = path.join(cacheDir, fx.vadBundle.repo, "silero_vad.onnx.part");
      assert.equal(fs.existsSync(preservedPart), true);
      assert.equal((await fsp.stat(preservedPart)).size, 12);

      // 2. Tar path traversal (`..`) and symlink (`typeFlag = "2"`) must be rejected immediately.
      const traversalTar = buildUstarArchive([
        { name: "package/../escape.js", data: "malicious" },
      ]);
      assert.throws(
        () => extractPinnedTarEntries(traversalTar, fx.wasmTarball.files),
        /traversal/i,
      );

      const symlinkTar = buildUstarArchive([
        {
          name: "package/sherpa-onnx-wasm-nodejs.js",
          typeFlag: "2",
          linkName: "/etc/passwd",
        },
      ]);
      assert.throws(
        () => extractPinnedTarEntries(symlinkTar, fx.wasmTarball.files),
        /symbolic or hard link/i,
      );

      // 3. Chunk idle watchdog and AbortSignal cancellation preserve .part and abort cleanly.
      const stalledManager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter: makeTestAdapter(),
        chunkIdleTimeoutMs: 25,
        httpStreamFetch: async () => ({
          statusCode: 200,
          headers: { "content-length": String(fx.vadBytes.byteLength) },
          body: {
            async *[Symbol.asyncIterator]() {
              yield fx.vadBytes.subarray(0, 8);
              await new Promise(() => {});
            },
          },
        }),
      });
      await assert.rejects(() => stalledManager.downloadDictationStack(), /stalled/i);

      const abortController = new AbortController();
      const abortableManager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter: makeTestAdapter(),
        httpStreamFetch: async () => ({
          statusCode: 200,
          headers: { "content-length": String(fx.vadBytes.byteLength) },
          body: {
            async *[Symbol.asyncIterator]() {
              yield fx.vadBytes.subarray(0, 6);
              abortController.abort();
              await new Promise(() => {});
            },
          },
        }),
      });
      await assert.rejects(
        () => abortableManager.downloadDictationStack({ signal: abortController.signal }),
        { name: "AbortError" },
      );
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("settings normalization & sequential replacement persistence without detached references", () => {
  it("preserves sequential multi-rule additions when saveSettings normalizes in place or replaces settings", async () => {
    const { createDefaultSettings, normalizeSettings, stripSecretsFromSettings } = await import(
      "../src/settings.ts"
    );
    const savedSnapshots = [];
    const host = {
      settings: createDefaultSettings(),
      async saveSettings() {
        const normalized = normalizeSettings(stripSecretsFromSettings(this.settings));
        Object.assign(this.settings, normalized);
        savedSnapshots.push(structuredClone(this.settings));
      },
    };

    const heldRef = host.settings;
    const ruleBatch = [
      { from: ["box点", "光4点", "黑曜石"], to: "Obsidian" },
      { from: ["深层一次", "深son一次"], to: "SenseVoice" },
      { from: ["刷练术语", "双链笔记"], to: "[[双链笔记]]" },
    ];
    for (const rule of ruleBatch) {
      host.settings.asrReplacements = [...host.settings.asrReplacements, rule];
      await host.saveSettings();
    }

    assert.equal(heldRef, host.settings);
    assert.equal(host.settings.asrReplacements.length, 3);
    assert.equal(savedSnapshots.at(-1).asrReplacements.length, 3);
    assert.deepEqual(host.settings.asrReplacements[2].to, "[[双链笔记]]");
  });

  it("handles deep >64-segment Vault symlink guard, complete .part 0-network promotion, corrupt .part same-mirror retry, invalid 206 Content-Range, and headersTimeout socket abort", async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vm-rt-hardening-"));
    try {
      const realVault = path.join(tmpRoot, "Vault");
      const symlinkVault = path.join(tmpRoot, "VaultLink");
      await fsp.mkdir(realVault, { recursive: true });
      await fsp.symlink(realVault, symlinkVault);

      const adapter = makeTestAdapter();
      // Deep 80-segment path under symlinkVault must STILL resolve canonical Vault ancestor and throw!
      const deepSegments = Array.from({ length: 80 }, (_, idx) => `d${idx}`);
      assert.throws(
        () =>
          resolveExternalModelCacheDir({
            customDir: path.join(symlinkVault, ...deepSegments),
            vaultBasePath: realVault,
            adapter,
          }),
        { message: VAULT_ISOLATION_ERROR_MESSAGE },
      );

      const cacheDir = path.join(tmpRoot, "cache");
      const fx = buildSmallFixtureManifest();

      // 1) Pre-seed COMPLETE valid `.part` for VAD (size === expectedBytes) -> must promote with 0 HTTP calls for VAD!
      await fsp.mkdir(path.join(cacheDir, fx.vadBundle.repo), { recursive: true });
      await fsp.writeFile(
        path.join(cacheDir, fx.vadBundle.repo, "silero_vad.onnx.part"),
        fx.vadBytes,
      );

      // 2) Pre-seed CORRUPT `.part` prefix for SenseVoice model.int8.onnx -> Mirror 1 should append (206),
      //    detect SHA256 mismatch, unlink `.part`, and retry Mirror 1 cleanly from byte 0 (even when Mirror 2 is unreachable!).
      const svDir = path.join(cacheDir, fx.senseVoiceBundle.repo);
      await fsp.mkdir(svDir, { recursive: true });
      const corruptPrefix = new Uint8Array(500).fill(0xee);
      await fsp.writeFile(path.join(svDir, "model.int8.onnx.part"), corruptPrefix);

      // 3) Pre-seed `.part` for tokens.txt -> Mirror 1 returns broken HTTP 206 with mismatched Content-Range `bytes 0-...` ->
      //    must reject invalid 206, unlink `.part`, and retry Mirror 1 cleanly with HTTP 200!
      await fsp.writeFile(path.join(svDir, "tokens.txt.part"), fx.tokensBytes.subarray(0, 5));

      let vadHttpCalls = 0;
      let svModelCallsOnPrimary = 0;
      let tokensCallsOnPrimary = 0;
      let headersTimeoutSignalAborted = false;

      const manager = new DesktopModelManager({
        customCacheDir: cacheDir,
        vadBundle: fx.vadBundle,
        senseVoiceBundle: fx.senseVoiceBundle,
        wasmTarball: fx.wasmTarball,
        adapter,
        headersTimeoutMs: 30,
        httpStreamFetch: async (req) => {
          if (req.url.includes("/csukuangfj/vad/")) {
            vadHttpCalls += 1;
            throw new Error("VAD should have promoted complete .part with 0 network calls!");
          }
          if (req.url.includes("hf-mirror.com")) {
            throw new Error("Secondary mirror unreachable in this test");
          }
          if (req.url.endsWith("/model.int8.onnx")) {
            svModelCallsOnPrimary += 1;
            if (req.headers.Range === "bytes=500-") {
              const tail = fx.senseModelBytes.subarray(500);
              return {
                statusCode: 206,
                headers: {
                  "content-range": `bytes 500-${fx.senseModelBytes.byteLength - 1}/${fx.senseModelBytes.byteLength}`,
                  "content-length": String(tail.byteLength),
                },
                body: streamChunks(tail),
              };
            }
            return {
              statusCode: 200,
              headers: { "content-length": String(fx.senseModelBytes.byteLength) },
              body: streamChunks(fx.senseModelBytes),
            };
          }
          if (req.url.endsWith("/tokens.txt")) {
            tokensCallsOnPrimary += 1;
            if (req.headers.Range) {
              // Broken proxy returns 206 starting at byte 0 instead of requested byte 5!
              return {
                statusCode: 206,
                headers: {
                  "content-range": `bytes 0-${fx.tokensBytes.byteLength - 1}/${fx.tokensBytes.byteLength}`,
                },
                body: streamChunks(fx.tokensBytes),
              };
            }
            return {
              statusCode: 200,
              headers: { "content-length": String(fx.tokensBytes.byteLength) },
              body: streamChunks(fx.tokensBytes),
            };
          }
          if (req.url.startsWith("https://registry.npmjs.org/")) {
            // Simulate blackholed primary host hanging headers -> must abort req.signal on timeout!
            req.signal?.addEventListener("abort", () => {
              headersTimeoutSignalAborted = true;
            });
            return new Promise(() => {});
          }
          if (req.url.startsWith("https://registry.npmmirror.com/")) {
            return {
              statusCode: 200,
              headers: { "content-length": String(fx.tgzBytes.byteLength) },
              body: streamChunks(fx.tgzBytes),
            };
          }
          throw new Error(`Unexpected URL: ${req.url}`);
        },
      });

      const status = await manager.downloadDictationStack();
      assert.equal(status.ready, true);
      assert.equal(vadHttpCalls, 0);
      assert.equal(svModelCallsOnPrimary, 2);
      assert.equal(tokensCallsOnPrimary, 2);
      assert.equal(headersTimeoutSignalAborted, true);
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

it("settings: readAloudResume normalizes safely (P4 resume)", async () => {
  const { normalizeSettings } = await import("../src/settings.ts");
  assert.deepEqual(
    normalizeSettings({ readAloudResume: { path: "notes/a.md", sentenceIndex: 3 } }).readAloudResume,
    { path: "notes/a.md", sentenceIndex: 3 },
  );
  assert.equal(
    normalizeSettings({ readAloudResume: { path: "", sentenceIndex: 3 } }).readAloudResume,
    null,
  );
  assert.equal(
    normalizeSettings({ readAloudResume: { path: "a.md", sentenceIndex: -1 } }).readAloudResume,
    null,
  );
  assert.equal(
    normalizeSettings({ readAloudResume: { path: "a.md", sentenceIndex: 1.5 } }).readAloudResume,
    null,
  );
  assert.equal(normalizeSettings({ readAloudResume: "bad" }).readAloudResume, null);
});
