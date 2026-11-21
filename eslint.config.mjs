import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import tseslint from "typescript-eslint";

const OBSIDIAN_PLUGIN_SCOPE = "packages/obsidian-plugin/**";

const SENTENCE_CASE_BRANDS = [
  "Obsidian",
  "Obsidian Sync",
  "Markdown",
  "GitHub",
  "macOS",
  "iOS",
  "iPadOS",
  "Android",
  "Windows",
  "Linux",
  "OpenAI",
  "DeepSeek",
  "Ollama",
  "SenseVoice",
  "Silero",
  "VITS",
  "Whisper",
  "Copilot",
  "Voice Mode",
];

const SENTENCE_CASE_ACRONYMS = [
  "AI",
  "API",
  "ASR",
  "TTS",
  "VAD",
  "BYOK",
  "LLM",
  "WASM",
  "SHA256",
  "URL",
  "URI",
  "HTTP",
  "HTTPS",
  "JSON",
  "DOM",
  "ID",
  "KB",
  "MB",
  "RAM",
  "CPU",
  "GPU",
  "OOM",
  "UI",
  "OK",
  "Q&A",
  "AEC",
  "OS",
  "UTF-8",
];

const NODE_BUILTIN_NAMES = [
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
];

const CORE_DOM_FORBIDDEN_GLOBALS = [
  { name: "window", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "document", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "activeWindow", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "activeDocument", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "HTMLElement", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "Element", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "Node", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "navigator", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "localStorage", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "sessionStorage", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "location", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
  { name: "history", message: "@voice-mode/core must remain DOM-free and host-agnostic." },
];

function buildNodeBuiltinImportPaths(packageLabel) {
  return NODE_BUILTIN_NAMES.map((name) => ({
    name,
    message: `${packageLabel} must not statically import Node.js built-in module "${name}".`,
  }));
}

function isRootMetadataBlock(block) {
  return (
    Array.isArray(block.files) &&
    block.files.some(
      (pattern) =>
        typeof pattern === "string" &&
        /^(manifest\.json|package\.json|LICENSE(\.md|\.txt)?)$/.test(pattern),
    )
  );
}

function scopePattern(pattern, scope) {
  if (Array.isArray(pattern)) {
    return [scope, ...pattern];
  }
  return [scope, pattern];
}

const scopedObsidianRecommended = obsidianmd.configs.recommended.map((block) => {
  if (isRootMetadataBlock(block)) {
    return block;
  }
  if (Array.isArray(block.files)) {
    return {
      ...block,
      files: block.files.map((pattern) => scopePattern(pattern, OBSIDIAN_PLUGIN_SCOPE)),
    };
  }
  if (block.languageOptions?.globals) {
    return {
      ...block,
      files: [OBSIDIAN_PLUGIN_SCOPE],
    };
  }
  return block;
});

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "dist/**",
    "main.js",
    "coverage/**",
    ".scratch/**",
    "esbuild.config.mjs",
    "eslint.config.mjs",
    "scripts/**",
  ]),

  // Official Obsidian plugin review ruleset scoped to packages/obsidian-plugin/**
  // plus root manifest.json / package.json / LICENSE checks.
  ...scopedObsidianRecommended,

  {
    files: ["packages/obsidian-plugin/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "error",
        {
          enforceCamelCaseLower: true,
          brands: SENTENCE_CASE_BRANDS,
          acronyms: SENTENCE_CASE_ACRONYMS,
        },
      ],
      "obsidianmd/no-nodejs-modules": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "electron",
              message:
                "Cross-platform Obsidian plugins (isDesktopOnly: false) must not statically import electron.",
            },
            ...buildNodeBuiltinImportPaths("@voice-mode/obsidian-plugin"),
          ],
          patterns: [
            {
              group: ["node:*"],
              message:
                "Cross-platform Obsidian plugins (isDesktopOnly: false) must not statically import node:* modules.",
            },
            {
              group: ["electron/*"],
              message:
                "Cross-platform Obsidian plugins (isDesktopOnly: false) must not statically import electron/* modules.",
            },
            {
              group: ["@deepseek-ai/*"],
              message: "@voice-mode/obsidian-plugin must not import @deepseek-ai/* packages.",
            },
          ],
        },
      ],
      "import/no-extraneous-dependencies": [
        "warn",
        {
          packageDir: [".", "./packages/obsidian-plugin"],
        },
      ],
    },
  },

  // Host-agnostic pure TypeScript core (bundled into main.js):
  // enforce Obsidian runtime safety rules, DOM-free globals, and zero Node/Electron/Obsidian imports.
  {
    files: ["packages/voice-core/src/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    plugins: {
      obsidianmd,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/no-nodejs-modules": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-globals": ["error", ...CORE_DOM_FORBIDDEN_GLOBALS],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "obsidian",
              message: "@voice-mode/core must not depend on Obsidian APIs.",
            },
            {
              name: "electron",
              message: "@voice-mode/core must not depend on Electron APIs.",
            },
            ...buildNodeBuiltinImportPaths("@voice-mode/core"),
          ],
          patterns: [
            {
              group: ["node:*"],
              message: "@voice-mode/core must not import node:* modules.",
            },
            {
              group: ["@deepseek-ai/*"],
              message: "@voice-mode/core must not import @deepseek-ai/* packages.",
            },
            {
              group: ["obsidian/*", "electron/*"],
              message: "@voice-mode/core must remain host-agnostic.",
            },
          ],
        },
      ],
    },
  },

  // Browser / renderer audio layer (bundled into main.js):
  // enforce Obsidian runtime safety rules and forbid Obsidian, Electron, Node, and @deepseek-ai/* imports.
  {
    files: ["packages/voice-browser/src/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    plugins: {
      obsidianmd,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "obsidianmd/regex-lookbehind": "error",
      "obsidianmd/no-nodejs-modules": "error",
      "no-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "obsidian",
              message: "@voice-mode/browser must not depend on Obsidian APIs.",
            },
            {
              name: "electron",
              message: "@voice-mode/browser must not depend on Electron APIs.",
            },
            ...buildNodeBuiltinImportPaths("@voice-mode/browser"),
          ],
          patterns: [
            {
              group: ["node:*"],
              message: "@voice-mode/browser must not import node:* modules.",
            },
            {
              group: ["@deepseek-ai/*"],
              message: "@voice-mode/browser must not import @deepseek-ai/* packages.",
            },
            {
              group: ["obsidian/*", "electron/*"],
              message: "@voice-mode/browser must remain host-agnostic.",
            },
          ],
        },
      ],
    },
  },

  // Node test runner files for shared workspace packages.
  {
    files: [
      "packages/voice-core/test/**/*.mjs",
      "packages/voice-browser/test/**/*.mjs",
      "packages/obsidian-plugin/test/**/*.mjs",
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node,
    },
  },
]);
