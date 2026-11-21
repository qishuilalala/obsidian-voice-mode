# Contributing to Obsidian Voice Mode / 贡献指南

Thank you for your interest in contributing! By participating in issues, discussions, or pull requests, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

欢迎参与缺陷报告、文档完善与代码贡献。参与社区协作即表示同意遵守[社区行为准则](CODE_OF_CONDUCT.md)。

## Development Environment / 开发环境

- **Node.js**: `>= 22.18.0`（单测依赖 Node 22.18+ 默认启用的原生 TypeScript type-stripping 直接导入 `.ts`；CI 固定 Node 22）
- **Package manager**: `pnpm@12.21.0` (`pnpm install --frozen-lockfile`)
- **Workspace structure**:
  - `packages/voice-core` (`@voice-mode/core`): Zero runtime dependencies; host-agnostic pure TypeScript (Markdown/table TTS segmenter, ASR replacement dictionary, emotion DSL, secret redaction, dual-protocol BYOK LLM router). **Must not import `obsidian`, DOM, or Node-only APIs.**
  - `packages/voice-browser` (`@voice-mode/browser`): Browser/Electron Web Audio, 16 kHz `AudioWorklet`, AEC3 probe, and playback queue contracts. **Must not import `obsidian`.**
  - `packages/obsidian-plugin` (`@voice-mode/obsidian-plugin`): Thin Obsidian adapter bundling into repo-root `main.js`.

## Verification Commands / 本地验证命令

Before opening a pull request, run the full workspace gate:

```bash
pnpm install --frozen-lockfile
pnpm run check:all
```

`pnpm run check:all` runs:

1. `pnpm run typecheck` — TypeScript strict check across all three packages
2. `pnpm run lint` — ESLint including `eslint-plugin-obsidianmd`
3. `pnpm run test` — Node built-in test runner across all three packages
4. `pnpm run build` — Production `esbuild` bundle to `main.js`
5. `pnpm run check:release` — Manifest, version alignment, and release artifact checks

## Engineering & Review Standards / 工程与评审纪律

- **Honest status & evidence**: Do not claim a capability is working or verified in `README.md`, `README.zh-CN.md`, or `docs/rules/STATE.md` unless it has passed the corresponding real-machine checks in [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md).
- **Real audio & model regressions**: Unit tests with mocks do **not** prove acoustic quality or WASM/ONNX decoding equivalence. Runtime upgrades (e.g., `sherpa-onnx`, `onnxruntime-web`, or audio pipeline changes) require documented real-device verification.
- **Obsidian policy hygiene**:
  - Never use `innerHTML` or unescaped HTML injection; use Obsidian DOM helpers (`createEl`, `createDiv`, `setText`).
  - Always clean up listeners and timers via `registerEvent`, `registerDomEvent`, and `registerInterval`.
  - Store secrets exclusively in Obsidian `SecretStorage`, never in `data.json`.
  - Keep `main.js` well under the 5 MB Obsidian Sync budget and never commit `main.js`, model binaries, recordings, or credentials to git.
- **Focused PRs**: One logical change per PR with targeted tests that reproduce bugs before fixing them.

## Releases / 发布说明

Releases are cut by maintainers using semver tags **without a leading `v`** (e.g., `0.1.0`, `1.0.0`) as required by `obsidianmd/obsidian-releases`. Published tags are immutable; regressions are addressed via subsequent patch releases.
