import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

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
  "Anthropic",
  "DeepSeek",
  "Qwen",
  "Kimi",
  "SiliconFlow",
  "OpenRouter",
  "Volcengine",
  "Ollama",
  "SenseVoice",
  "Silero",
  "VITS",
  "Kokoro",
  "MiMo",
  "CosyVoice2",
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
  "CORS",
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

export default defineConfig([
  globalIgnores([
    "node_modules/**",
    "**/dist/**",
    "main.js",
    "coverage/**",
    ".scratch/**",
    "esbuild.config.mjs",
    "eslint.config.mjs",
    "scripts/**",
  ]),

  // Official Obsidian review ruleset (including type-aware @typescript-eslint,
  // promise safety, comment hygiene, lookbehind, and no-nodejs-modules) applied
  // across the entire workspace to mirror upstream `scanner-eslint`.
  ...obsidianmd.configs.recommended,

  {
    files: ["**/*.{ts,cts,mts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ["packages/obsidian-plugin/src/**/*.ts"],
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

  // Host-agnostic pure TypeScript core:
  // disable Obsidian UI sentence-case (core contains non-UI protocol/prompt strings),
  // forbid all DOM globals while allowing standard WinterCG `fetch`, and forbid Node/Electron/Obsidian imports.
  {
    files: ["packages/voice-core/src/**/*.ts"],
    rules: {
      "obsidianmd/ui/sentence-case": "off",
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

  // Browser / renderer audio & focus layer:
  // disable Obsidian-only UI sentence-case while keeping full type-aware & safety rules.
  {
    files: ["packages/voice-browser/src/**/*.ts"],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "obsidianmd/ui/sentence-case": "off",
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
