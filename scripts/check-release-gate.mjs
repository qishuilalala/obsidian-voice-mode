import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT_DIR = process.cwd();
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PLUGIN_ID_RE = /^[a-z0-9-]+$/;
const MIN_REQUIRED_APP_VERSION = [1, 11, 4];
const HARD_BUNDLE_LIMIT_BYTES = 5 * 1024 * 1024; // 5 MB Obsidian Sync limit
const WARN_BUNDLE_TARGET_BYTES = 1 * 1024 * 1024; // 1 MB target budget

const TEST_PLACEHOLDER_MARKER_RE =
  /test|fake|example|dummy|mock|placeholder|redacted|fixture|supersecret|leakedtoken|000000|123456|987654321/i;

const BARE_NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "dns",
  "events",
  "fs",
  "http",
  "https",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "timers",
  "url",
  "util",
  "worker_threads",
  "zlib",
]);

const errors = [];
const warnings = [];
const passes = [];

function toPosixPath(p) {
  return String(p).replace(/\\/g, "/");
}

function pass(label) {
  passes.push(label);
  console.log(`[PASS] ${label}`);
}

function warn(label) {
  warnings.push(label);
  console.warn(`[WARN] ${label}`);
}

function fail(label) {
  errors.push(label);
  console.error(`[FAIL] ${label}`);
}

function compareSemver(a, bTuple) {
  const parts = String(a)
    .split("-")[0]
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i += 1) {
    const av = parts[i] ?? 0;
    const bv = bTuple[i] ?? 0;
    if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
}

function readJsonFile(relPath) {
  const normalized = toPosixPath(relPath);
  const absPath = path.join(ROOT_DIR, ...normalized.split("/"));
  if (!fs.existsSync(absPath)) {
    fail(`Missing required file: ${normalized}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch (err) {
    fail(`Invalid JSON in ${normalized}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function walkFiles(dirRelPath, options = {}) {
  const { skipDirs = new Set(), skipFiles = new Set(), extensions = null } = options;
  const normalizedDir = toPosixPath(dirRelPath);
  const startAbs =
    normalizedDir === "." ? ROOT_DIR : path.join(ROOT_DIR, ...normalizedDir.split("/"));
  if (!fs.existsSync(startAbs)) {
    return [];
  }

  const results = [];
  const stack = [startAbs];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absEntry = path.join(current, entry.name);
      const relEntry = toPosixPath(path.relative(ROOT_DIR, absEntry));
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name) && !skipDirs.has(relEntry)) {
          stack.push(absEntry);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (skipFiles.has(entry.name) || skipFiles.has(relEntry)) {
        continue;
      }
      if (extensions && !extensions.has(path.extname(entry.name))) {
        continue;
      }
      results.push({ absPath: absEntry, relPath: relEntry });
    }
  }

  return results;
}

function checkManifestAndVersions() {
  const manifest = readJsonFile("manifest.json");
  const versions = readJsonFile("versions.json");
  const rootPkg = readJsonFile("package.json");

  if (!manifest) {
    return;
  }

  const requiredStringFields = ["id", "name", "version", "minAppVersion", "description", "author"];
  for (const field of requiredStringFields) {
    if (typeof manifest[field] !== "string" || manifest[field].trim().length === 0) {
      fail(`manifest.json missing or empty string field "${field}".`);
    }
  }
  if (typeof manifest.isDesktopOnly !== "boolean") {
    fail('manifest.json field "isDesktopOnly" must be a boolean.');
  }

  if (typeof manifest.id === "string") {
    if (!PLUGIN_ID_RE.test(manifest.id)) {
      fail(`manifest.json id "${manifest.id}" must match ${PLUGIN_ID_RE.source}.`);
    }
    if (/obsidian/i.test(manifest.id)) {
      fail(`manifest.json id "${manifest.id}" must not contain "obsidian".`);
    }
  }

  if (typeof manifest.name === "string" && /(obsidian|obsi|sidian)/i.test(manifest.name)) {
    fail(`manifest.json name "${manifest.name}" must not contain "Obsidian" or fragments.`);
  }

  if (typeof manifest.version === "string") {
    if (manifest.version.startsWith("v") || !SEMVER_RE.test(manifest.version)) {
      fail(`manifest.json version "${manifest.version}" must be bare semver without leading "v".`);
    }
  }

  if (typeof manifest.minAppVersion === "string") {
    if (!SEMVER_RE.test(manifest.minAppVersion)) {
      fail(`manifest.json minAppVersion "${manifest.minAppVersion}" is not valid semver.`);
    } else if (compareSemver(manifest.minAppVersion, MIN_REQUIRED_APP_VERSION) < 0) {
      fail(
        `manifest.json minAppVersion "${manifest.minAppVersion}" must be >= ${MIN_REQUIRED_APP_VERSION.join(".")} for SecretStorage API.`,
      );
    }
  }

  if (typeof manifest.description === "string") {
    const desc = manifest.description.trim();
    if (desc.length < 10 || desc.length > 250) {
      fail(`manifest.json description length (${desc.length}) must be between 10 and 250 characters.`);
    }
    if (!/[.!?]$/.test(desc)) {
      fail("manifest.json description must end with terminal punctuation (e.g. a period).");
    }
    if (/obsidian/i.test(desc)) {
      fail('manifest.json description must not mention "Obsidian".');
    }
  }

  if (versions && typeof manifest.version === "string") {
    if (versions[manifest.version] !== manifest.minAppVersion) {
      fail(
        `versions.json["${manifest.version}"] (${String(versions[manifest.version])}) does not match manifest.minAppVersion (${manifest.minAppVersion}).`,
      );
    }
  }

  const pkgFiles = [
    ["package.json", rootPkg],
    ["packages/obsidian-plugin/package.json", readJsonFile("packages/obsidian-plugin/package.json")],
    ["packages/voice-core/package.json", readJsonFile("packages/voice-core/package.json")],
    ["packages/voice-browser/package.json", readJsonFile("packages/voice-browser/package.json")],
  ];

  for (const [relPath, pkg] of pkgFiles) {
    if (pkg && typeof manifest.version === "string" && pkg.version !== manifest.version) {
      fail(`${relPath} version "${pkg.version}" does not match manifest.json version "${manifest.version}".`);
    }
  }

  if (errors.length === 0) {
    pass(
      `manifest.json & versions.json valid (id=${manifest.id}, version=${manifest.version}, minAppVersion=${manifest.minAppVersion})`,
    );
  }
}

function checkBundleArtifacts() {
  const mainJsPath = path.join(ROOT_DIR, "main.js");
  if (!fs.existsSync(mainJsPath)) {
    fail("Root main.js is missing. Run `pnpm run build` before checking release gate.");
  } else {
    const bytes = fs.statSync(mainJsPath).size;
    const kb = (bytes / 1024).toFixed(2);
    if (bytes === 0) {
      fail("Root main.js is empty (0 bytes).");
    } else if (bytes >= HARD_BUNDLE_LIMIT_BYTES) {
      fail(`Root main.js is ${kb} KB (${bytes} bytes), exceeding the 5 MB Obsidian Sync limit.`);
    } else if (bytes >= WARN_BUNDLE_TARGET_BYTES) {
      warn(`Root main.js is ${kb} KB, above the 1 MB target budget (still under 5 MB hard limit).`);
      pass(`Root main.js exists and is under 5 MB (${kb} KB)`);
    } else {
      pass(`Root main.js exists and is within target budget (${kb} KB < 1024 KB)`);
    }
  }

  const stylesPath = path.join(ROOT_DIR, "styles.css");
  if (!fs.existsSync(stylesPath) || fs.statSync(stylesPath).size === 0) {
    fail("Root styles.css is missing or empty.");
  } else {
    pass("Root styles.css exists and is non-empty");
  }
}

function extractImportSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source)) !== null) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function isNodeSpecifier(spec) {
  return spec.startsWith("node:") || BARE_NODE_BUILTINS.has(spec);
}

function isElectronSpecifier(spec) {
  return spec === "electron" || spec.startsWith("electron/");
}

function isObsidianSpecifier(spec) {
  return spec === "obsidian" || spec.startsWith("obsidian/");
}

function isDeepSeekSdkSpecifier(spec) {
  return spec === "@deepseek-ai" || spec.startsWith("@deepseek-ai/");
}

function checkArchitectureBoundaries() {
  const codeExts = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
  const coreFiles = walkFiles("packages/voice-core/src", { extensions: codeExts });
  const browserFiles = walkFiles("packages/voice-browser/src", { extensions: codeExts });
  const pluginFiles = walkFiles("packages/obsidian-plugin/src", { extensions: codeExts });

  let boundaryViolations = 0;

  for (const file of [...coreFiles, ...browserFiles]) {
    const content = fs.readFileSync(file.absPath, "utf8");
    const specifiers = extractImportSpecifiers(content);
    const pkgKind = file.relPath.startsWith("packages/voice-core/") ? "voice-core" : "voice-browser";
    for (const spec of specifiers) {
      if (isObsidianSpecifier(spec) || isElectronSpecifier(spec) || isDeepSeekSdkSpecifier(spec)) {
        fail(`Architecture boundary violation in ${file.relPath}: forbidden import "${spec}".`);
        boundaryViolations += 1;
      }
      if (isNodeSpecifier(spec)) {
        fail(
          `Architecture boundary violation in ${file.relPath}: ${pkgKind} must not import Node module "${spec}".`,
        );
        boundaryViolations += 1;
      }
    }
  }

  for (const file of pluginFiles) {
    const content = fs.readFileSync(file.absPath, "utf8");
    const specifiers = extractImportSpecifiers(content);
    for (const spec of specifiers) {
      if (isElectronSpecifier(spec) || isNodeSpecifier(spec) || isDeepSeekSdkSpecifier(spec)) {
        fail(
          `Architecture boundary violation in ${file.relPath}: cross-platform plugin must not statically import "${spec}".`,
        );
        boundaryViolations += 1;
      }
    }
    if (/\b(innerHTML|outerHTML|document\.write)\b/.test(content)) {
      fail(`Unsafe DOM API detected in ${file.relPath}.`);
      boundaryViolations += 1;
    }
    if (/\b(eval\s*\(|new\s+Function\s*\()/.test(content)) {
      fail(`Dynamic code execution detected in ${file.relPath}.`);
      boundaryViolations += 1;
    }
  }

  if (coreFiles.length === 0 || browserFiles.length === 0) {
    warn(
      `Shared package sources incomplete (voice-core/src: ${coreFiles.length} files, voice-browser/src: ${browserFiles.length} files).`,
    );
  }

  if (boundaryViolations === 0) {
    pass(
      `Architecture boundary check passed (scanned ${coreFiles.length} core, ${browserFiles.length} browser, ${pluginFiles.length} plugin source files)`,
    );
  }
}

function getLineAtOffset(content, index) {
  const start = content.lastIndexOf("\n", index) + 1;
  const endIdx = content.indexOf("\n", index);
  return content.slice(start, endIdx === -1 ? content.length : endIdx);
}

function checkRepoHygiene() {
  const skipDirs = new Set(["node_modules", ".git", "dist", "coverage", ".scratch"]);
  const skipFiles = new Set(["pnpm-lock.yaml", "main.js", ".DS_Store"]);
  const textExts = new Set([
    ".ts",
    ".mts",
    ".cts",
    ".js",
    ".mjs",
    ".cjs",
    ".json",
    ".css",
    ".md",
    ".yml",
    ".yaml",
    ".txt",
  ]);

  const files = walkFiles(".", { skipDirs, skipFiles, extensions: textExts });

  // Build sensitive marker matchers dynamically so this gate script never contains raw trigger tokens.
  const secretPatterns = [
    {
      name: "OpenAI / Anthropic-style secret key",
      re: new RegExp("\\b" + "sk" + "-[A-Za-z0-9_-]{20,}\\b", "g"),
      allowTestPlaceholder: true,
    },
    {
      name: "Groq-style secret key",
      re: new RegExp("\\b" + "gsk_" + "[A-Za-z0-9]{20,}\\b", "g"),
      allowTestPlaceholder: true,
    },
    {
      name: "GitHub access token",
      re: new RegExp("\\b" + "gh[pousr]_" + "[A-Za-z0-9]{20,}\\b", "g"),
      allowTestPlaceholder: true,
    },
    {
      name: "Restricted provider API key",
      re: new RegExp("\\b" + "rk_(?:live|test)_" + "[A-Za-z0-9]{16,}\\b", "g"),
      allowTestPlaceholder: true,
    },
    {
      name: "Google API key",
      re: new RegExp("\\b" + "AIza" + "[0-9A-Za-z_-]{35}\\b", "g"),
      allowTestPlaceholder: true,
    },
    {
      name: "AWS access key ID",
      re: new RegExp("\\b" + "AKIA" + "[0-9A-Z]{16}\\b", "g"),
      allowTestPlaceholder: true,
    },
    {
      name: "PEM private key block",
      re: new RegExp("-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE " + "KEY-----", "g"),
      allowTestPlaceholder: false,
    },
  ];

  const attributionPatterns = [
    {
      name: "AI Co-Authored-By trailer",
      re: new RegExp(
        "Co-Authored-" + "By:\\s*.*(?:cla" + "ude|anthro" + "pic|openai|codex|antigravity|cursor)",
        "i",
      ),
    },
    {
      name: "Generated-with AI attribution marker",
      re: new RegExp("Generated\\s+with\\s+\\[?" + "(?:Cla" + "ude|Anthro" + "pic)", "i"),
    },
    {
      name: "Anthropic noreply address",
      re: new RegExp("noreply@" + "anthro" + "pic\\.com", "i"),
    },
    {
      name: "AI coding tool attribution",
      re: new RegExp("\\bCla" + "ude\\s+Code\\b", "i"),
    },
  ];

  let hygieneViolations = 0;

  for (const file of files) {
    const isTestFile = /(?:^|\/)test\//.test(file.relPath);
    const content = fs.readFileSync(file.absPath, "utf8");

    for (const pattern of attributionPatterns) {
      if (pattern.re.test(content)) {
        fail(`Attribution violation (${pattern.name}) in ${file.relPath}.`);
        hygieneViolations += 1;
      }
    }

    for (const pattern of secretPatterns) {
      pattern.re.lastIndex = 0;
      for (const match of content.matchAll(pattern.re)) {
        const matchedText = match[0];
        const matchIndex = match.index ?? 0;
        if (isTestFile && pattern.allowTestPlaceholder) {
          const line = getLineAtOffset(content, matchIndex);
          if (
            TEST_PLACEHOLDER_MARKER_RE.test(matchedText) ||
            TEST_PLACEHOLDER_MARKER_RE.test(line)
          ) {
            continue;
          }
        }
        fail(`Possible hardcoded secret (${pattern.name}) in ${file.relPath}.`);
        hygieneViolations += 1;
        break;
      }
    }
  }

  if (hygieneViolations === 0) {
    pass(
      `Security and hygiene check passed (zero hardcoded secrets or attribution markers across ${files.length} files)`,
    );
  }
}

checkManifestAndVersions();
checkBundleArtifacts();
checkArchitectureBoundaries();
checkRepoHygiene();

console.log(
  `\n[release-gate] Summary: ${passes.length} passed, ${warnings.length} warnings, ${errors.length} failed.`,
);

if (errors.length > 0) {
  process.exit(1);
}
