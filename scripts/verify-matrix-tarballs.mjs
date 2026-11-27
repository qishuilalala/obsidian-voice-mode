import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const root = path.dirname(import.meta.dirname);
const { values, positionals } = parseArgs({
  options: { "require-all": { type: "boolean", default: false } },
  allowPositionals: true,
});
if (positionals.length > 1) {
  throw new Error("Usage: pnpm run verify:matrix [--require-all] [checkout-parent]");
}
const matrixRoot = path.resolve(positionals[0] ?? path.dirname(root));
const consumers = [
  { repo: "sillytavern-voice-mode", vendor: "vendor", packages: ["core", "browser"] },
  { repo: "voice-mode-daemon", vendor: "vendor", packages: ["core", "browser"] },
  { repo: "dsh-voice-mode", vendor: "plugin/dsh-voice-mode/vendor", packages: ["core"] },
];

// Explicit, auditable exemptions for consumers that are deliberately pinned to an
// older shared-core build. dsh-voice-mode is a released package; per decision
// D-0021 it stays frozen on the previous core until its next release rebuilds
// lib/ and the vendored archive together. Set VOICE_MODE_MATRIX_SKIP=dsh-voice-mode
// to acknowledge the known stale archive; the default stays strict.
const exemptRepo = (process.env.VOICE_MODE_MATRIX_SKIP ?? "").trim();
if (exemptRepo && exemptRepo !== "dsh-voice-mode") {
  throw new Error("D-0021 only permits VOICE_MODE_MATRIX_SKIP=dsh-voice-mode");
}

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Rebuild before packing so identical, outdated copies in every consumer cannot pass.
execFileSync(process.execPath, ["scripts/build-packages.mjs"], { cwd: root, stdio: "inherit" });
const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-mode-matrix-"));
try {
  const archives = new Map();
  for (const name of ["core", "browser"]) {
    const cwd = path.join(root, "packages", `voice-${name}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    if (manifest.sideEffects !== false || !fs.existsSync(path.join(cwd, "dist/index.js"))) {
      throw new Error(`Expected built dist and sideEffects: false for ${manifest.name}`);
    }

    // pnpm pack resolves workspace dependencies and includes the shared license.
    // Using a fixed command also supports pnpm.cmd on Windows and paths containing spaces.
    const destination = process.platform === "win32" ? '"%VOICE_MODE_PACK_DIR%"' : '"$VOICE_MODE_PACK_DIR"';
    execSync(`pnpm pack --silent --pack-destination ${destination}`, {
      cwd,
      env: { ...process.env, VOICE_MODE_PACK_DIR: packDir },
      stdio: "inherit",
    });
    const filename = `voice-mode-${name}-${manifest.version}.tgz`;
    const hash = sha256(path.join(packDir, filename));
    archives.set(name, { filename, hash });
    console.log(`[SOURCE] ${filename} ${hash}`);
  }

  for (const { repo, vendor, packages } of consumers) {
    if (repo === exemptRepo) {
      console.log(`[SKIP] ${repo} exempted via VOICE_MODE_MATRIX_SKIP (known stale core, see D-0021)`);
      continue;
    }
    const checkout = path.join(matrixRoot, repo);
    if (!fs.existsSync(checkout)) {
      if (values["require-all"]) throw new Error(`Required checkout absent: ${checkout}`);
      console.log(`[SKIP] ${repo} checkout absent`);
      continue;
    }
    for (const [name, { filename, hash }] of archives) {
      const file = path.join(checkout, vendor, filename);
      if (!packages.includes(name) && !fs.existsSync(file)) continue;
      const actual = sha256(file);
      if (actual !== hash) {
        throw new Error(`SHA-256 mismatch for ${file}: expected ${hash}, got ${actual}`);
      }
      console.log(`[OK] ${repo}/${vendor}/${filename}`);
    }
  }
} finally {
  fs.rmSync(packDir, { recursive: true, force: true });
}
