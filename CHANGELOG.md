# Changelog

All notable changes to **Obsidian Voice Mode** (`voice-mode`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Git tags omit the leading `v` prefix (e.g. `0.1.0`) to comply with Obsidian Community Plugin Directory conventions.

## [Unreleased]

### Planned (see `docs/plan/master-plan.md`)

- **M0**: 6 pre-coding real-machine Spikes in Obsidian desktop (Installer 1.14.4 / Electron 43.7.5 & Installer 1.15.1 / Electron 43.8.9): Web Worker WASM RSS/RTF, Vault-external cache & Sync isolation, Copilot sidebar injection, domestic LLM CORS matrix, `sherpa-onnx` WASM `#3960`/`#1939` check, AEC3 & mobile probe.
- **M1**: Desktop offline WASM dictation (`Silero VAD` + `SenseVoice int8`), Vault-external SHA256-verified model manager, custom ASR replacement UI, and editor/sidebar text injection.
- **M2**: Spoken Markdown & pipe-table read-aloud, floating captions overlay, and AEC3 barge-in with `manual` fallback.
- **M3**: Optional BYOK voice Q&A / transcript polish via `SecretStorage`, mobile graceful degradation verification, and 4 mandatory real-machine acoustic acceptance gates.

## [0.1.0] - 2026-11-21

> **Status**: `0.1.0` (Alpha architecture baseline). Offline WASM inference, Vault-external SHA256 model downloading, and BYOK voice Q&A UI are **not yet implemented**; the plugin skeleton currently exposes a zero-config system `speechSynthesis` read-aloud preview and a placeholder browser `SpeechRecognition` fallback (unavailable on desktop Electron builds without a Google Speech API key). See `docs/rules/STATE.md` for exact readiness boundaries.

### Added

- **Monorepo architecture**: Three-package pnpm workspace (`@voice-mode/core`, `@voice-mode/browser`, `@voice-mode/obsidian-plugin`) bundled into Obsidian-compatible `main.js` via `esbuild`.
- **Obsidian plugin skeleton & metadata**: `manifest.json` (`id: "voice-mode"`, `minAppVersion: "1.11.4"`, `isDesktopOnly: false`), `versions.json`, `styles.css`, registered commands (`Toggle voice dictation`, `Read selection or note aloud`, `Stop read-aloud`, `Check voice runtime status`), settings tab, subtitle overlay, and desktop/mobile runtime guards.
- **Governance & architecture docs**: `docs/plan/master-plan.md`, `CONTEXT.md`, `docs/rules/STATE.md`, ADRs `0001`–`0004`, `docs/qa/acceptance-checklist.md`, and `docs/distribution/launch-playbook.md`.
- **CI/CD & community hygiene**: Cross-OS CI matrix (Ubuntu / macOS / Windows, Node 22 + `pnpm@12.21.0`, `eslint-plugin-obsidianmd`, `pnpm audit`), Obsidian-compliant release workflow (no-`v` tag validation, 5 MB `main.js` budget check, 3-asset upload only), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (MIT), and Issue/PR templates.
