import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ROOT_DIR = process.cwd();

const PACKAGE_JSON_PATHS = [
  "package.json",
  "packages/obsidian-plugin/package.json",
  "packages/voice-core/package.json",
  "packages/voice-browser/package.json",
];

function readJson(relPath) {
  const absPath = path.join(ROOT_DIR, relPath);
  return JSON.parse(fs.readFileSync(absPath, "utf8"));
}

function writeJson(relPath, value, dryRun) {
  const absPath = path.join(ROOT_DIR, relPath);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) {
    console.log(`[version-bump] (dry-run) would update ${relPath}`);
    return;
  }
  fs.writeFileSync(absPath, serialized, "utf8");
  console.log(`[version-bump] updated ${relPath}`);
}

function parseArgs(argv) {
  let targetVersion = "";
  let minAppVersion = "";
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--min-app-version") {
      minAppVersion = argv[i + 1] ?? "";
      i += 1;
    } else if (!arg.startsWith("-") && !targetVersion) {
      targetVersion = arg;
    }
  }

  if (!targetVersion) {
    targetVersion = process.env.npm_package_version ?? "";
  }

  return { targetVersion, minAppVersion, dryRun };
}

function main() {
  const { targetVersion, minAppVersion: cliMinApp, dryRun } = parseArgs(process.argv.slice(2));

  if (!targetVersion) {
    console.error("Usage: node scripts/version-bump.mjs <semver> [--min-app-version <semver>] [--dry-run]");
    process.exit(1);
  }

  if (targetVersion.startsWith("v") || !SEMVER_RE.test(targetVersion)) {
    console.error(
      `[version-bump] Invalid version "${targetVersion}". Expected bare semver without a leading "v" (for example, 0.2.0).`,
    );
    process.exit(1);
  }

  const manifest = readJson("manifest.json");
  const resolvedMinAppVersion = cliMinApp || manifest.minAppVersion;

  if (!SEMVER_RE.test(resolvedMinAppVersion)) {
    console.error(`[version-bump] Invalid minAppVersion "${resolvedMinAppVersion}".`);
    process.exit(1);
  }

  manifest.version = targetVersion;
  manifest.minAppVersion = resolvedMinAppVersion;
  writeJson("manifest.json", manifest, dryRun);

  const versions = readJson("versions.json");
  versions[targetVersion] = resolvedMinAppVersion;
  writeJson("versions.json", versions, dryRun);

  for (const pkgRelPath of PACKAGE_JSON_PATHS) {
    const absPath = path.join(ROOT_DIR, pkgRelPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }
    const pkg = readJson(pkgRelPath);
    pkg.version = targetVersion;
    writeJson(pkgRelPath, pkg, dryRun);
  }

  console.log(
    `[version-bump] ${dryRun ? "Validated" : "Synchronized"} version ${targetVersion} (minAppVersion ${resolvedMinAppVersion}).`,
  );
}

main();
