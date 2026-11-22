import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT_DIR = process.cwd();
const PACKAGES = ["packages/voice-core", "packages/voice-browser"];
const TSC_BIN = path.join(
  ROOT_DIR,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

const RELATIVE_TS_SPECIFIER_RE =
  /((?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*)['"])(\.\.?\/[^'"]+?)\.ts(['"])/g;

function walkDistFiles(dirAbs) {
  const out = [];
  const stack = [dirAbs];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) {
        out.push(full);
      }
    }
  }
  return out;
}

for (const pkgRel of PACKAGES) {
  const pkgAbs = path.join(ROOT_DIR, ...pkgRel.split("/"));
  const distAbs = path.join(pkgAbs, "dist");
  fs.rmSync(distAbs, { recursive: true, force: true });

  execFileSync(TSC_BIN, ["-p", "tsconfig.build.json"], {
    cwd: pkgAbs,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const distFiles = walkDistFiles(distAbs);
  for (const fileAbs of distFiles) {
    const original = fs.readFileSync(fileAbs, "utf8");
    const rewritten = original.replace(RELATIVE_TS_SPECIFIER_RE, "$1$2.js$3");
    if (rewritten !== original) {
      fs.writeFileSync(fileAbs, rewritten, "utf8");
    }
    if (fileAbs.endsWith(".d.ts")) {
      if (/(?:\bfrom\s+|\bimport\s*\(\s*)['"]\.\.?\/[^'"]+\.ts['"]/.test(rewritten)) {
        throw new Error(`Unrewritten relative .ts specifier in ${path.relative(ROOT_DIR, fileAbs)}`);
      }
      if (/\/\/\/\s*<reference\s+types=["']node["']/.test(rewritten)) {
        throw new Error(`Unexpected @types/node reference leaked into ${path.relative(ROOT_DIR, fileAbs)}`);
      }
    }
  }
  console.log(`[build:packages] Built and verified ${pkgRel}/dist (${distFiles.length} files)`);
}
