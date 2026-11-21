# Voice Mode for Obsidian

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Project Status (`0.1.0` (Alpha architecture baseline))**
>
> This repository is currently in its **initial architecture and shared-core foundation phase**. The three-package workspace (`@voice-mode/core`, `@voice-mode/browser`, `@voice-mode/obsidian-plugin`), pure text/speech pipeline modules, audio contracts, plugin skeleton, settings tab, subtitle overlay, and CI/release gates are in place.
>
> **What works in `0.1.0` today vs. what is not yet shipped**:
> - **Shipped preview commands in `0.1.0`**: `Read selection or note aloud` provides a zero-config preview using host system `speechSynthesis` with Markdown/table cleaning and subtitle overlay; `Toggle voice dictation` currently acts only as a placeholder fallback when the host browser/WebView exposes native `SpeechRecognition` (**unavailable on desktop Obsidian Electron builds without a Google Speech API key**, and sends audio to the browser/OS speech provider where supported).
> - **Not yet implemented (Planned M0–M3)**: Local offline WASM dictation (`Silero VAD` + `SenseVoice int8`), Vault-external SHA256 model downloading, AEC3 barge-in wiring, BYOK voice Q&A UI, and real-device desktop/mobile acoustic verification. Do **not** install `0.1.0` expecting working offline dictation yet—track progress in [docs/rules/STATE.md](docs/rules/STATE.md) and [docs/plan/master-plan.md](docs/plan/master-plan.md).

---

## Why Voice Mode?

Most Obsidian voice plugins force an awkward trade-off: either require users to manually install and run an external local WebSocket server, upload private notes and audio to third-party cloud services, or read raw Markdown symbols (`| --- |`, code fences, URLs) aloud verbatim.

**Voice Mode** (`id: voice-mode`, `minAppVersion: 1.11.4`) is designed as an **offline-first, zero-external-server voice I/O layer** that works alongside your existing AI plugins (such as Copilot or Smart Connections) rather than replacing them:

- **Zero external server by default (Planned M1)**: Desktop offline bilingual (Chinese/English) dictation running in a Web Worker via WASM (`Silero VAD` + `SenseVoice int8`), paired with a custom ASR replacement dictionary for domain terms and proper nouns.
- **Editor & third-party sidebar injection (Planned M1)**: Dictate directly into the active Markdown editor or focused third-party sidebars (such as Copilot's input box) without tight coupling.
- **Markdown & pipe-table aware read-aloud (`speechSynthesis` preview in `0.1.0`; full pipeline planned M2)**: Strips YAML frontmatter, fenced code blocks (```` ``` ```` / `~~~`), math blocks (`$$...$$`), bare URLs, Obsidian callout markers, and Markdown pipe tables while cleaning inline code and Wikilink syntax into natural spoken text—paired with floating captions and planned AEC3 barge-in (with `manual` push-to-interrupt fallback).
- **Optional zero-dependency BYOK Q&A & polish (Planned M3)**: Supports OpenAI-compatible endpoints (DeepSeek, Qwen/DashScope, Doubao/Ark, Kimi, SiliconFlow, OpenRouter, OpenAI, Ollama) and Anthropic Messages using Obsidian's native `SecretStorage` (`>= 1.11.4`).
- **Optional shared local `voice-daemon` (Planned Wave 3)**: For desktop power users who want Kokoro 103 voices or multi-app model sharing across Obsidian, SillyTavern, and browser extensions without hitting Electron's V8 Memory Cage.

---

## Architecture & Packages

This repository is structured as a three-package pnpm monorepo so core speech logic stays cleanly separated from Obsidian APIs and can power our broader cross-platform Voice Mode series:

| Package | Role | Host Dependencies |
| --- | --- | --- |
| `packages/voice-core` (`@voice-mode/core`) | Zero-dependency pure TypeScript speech pipeline: Markdown/table TTS segmenter, ASR replacement dictionary, emotion tag DSL, secret redaction, and dual-protocol BYOK LLM router | None (no `obsidian`, no `electron`, no `node:*`) |
| `packages/voice-browser` (`@voice-mode/browser`) | Web Audio / Electron contracts: 16 kHz `AudioWorklet` resampler, native AEC3 runtime probe, playback queue, and worker protocol | Web / Audio standards only (no `obsidian`) |
| `packages/obsidian-plugin` (`@voice-mode/obsidian-plugin`) | Thin Obsidian adapter bundled via `esbuild` into repo-root `main.js` (`< 5 MB` Obsidian Sync budget) | `obsidian` (`minAppVersion: 1.11.4`) |

### Verified In-Obsidian Web Worker WASM Benchmarks (M0 Gate Passed · 2026-11-22)

Measured inside real **Obsidian `1.15.1` (`Electron 43.8.9` / `Chromium 150.0.7871.250`) on Apple M2 Max macOS `27.2.1` (32 GB RAM)** using `sherpa-onnx@2.0.2` WASM in an isolated MEMFS Web Worker over a 15-minute (60-utterance) continuous session (full report in [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md); M1 plugin integration in progress):

| Engine / Model (WASM) | Cold Load | RTF | Resident RSS Delta | Role |
| --- | ---: | ---: | ---: | --- |
| `Silero VAD` | `30 ms` | — | Included below | Always-on endpoint / barge-in VAD |
| `SenseVoice int8` | `485 ms` | `0.215` (15m avg) | `+348.7 MB` steady (`+527.5 MB` peak, `512 MB` flat WASM heap) | Default desktop single-model offline dictation (M1) |
| `Zipformer2` | `1,939 ms` (Node ref) | `0.259` | `463 MB` (Node ref) | Optional streaming / Wave 3 `voice-daemon` |
| `VITS` (`vits-zh-ll`) | `391 ms` | `1.268` | `438 MB` (80-sentence steady) | Optional desktop offline TTS (M2; `#3960` keeps Kokoro on Wave 3 `voice-daemon`) |

---

## Platform Support & Mobile Degradation

| Platform | Target Support | Runtime Behavior |
| --- | --- | --- |
| **Desktop** (macOS / Windows / Linux, Obsidian `>= 1.11.4`) | Primary (pending M0–M3 verification) | `0.1.0` system `speechSynthesis` read-aloud preview; planned local Web Worker WASM dictation + optional local/BYOK TTS + Wave 3 optional `voice-daemon` |
| **Mobile** (iOS / Android, Obsidian `>= 1.11.4`) | Graceful degradation (`isDesktopOnly: false`, pending M3 verification) | Heavy 200 MB+ local WASM models are strictly disabled under `Platform.isMobile` to respect iOS WKWebView (~500 MB Jetsam) limits; uses BYOK API + system speech |

---

## Privacy, Network Access & External Model Disclosure

In compliance with Obsidian Developer Policies, all network behavior, model downloads, and credential boundaries are disclosed up front (full details in [SECURITY.md](SECURITY.md)):

1. **Zero telemetry & zero startup calls**: The plugin never phones home, collects analytics, or downloads files silently on load.
2. **Current `0.1.0` preview commands**:
   - `Read selection or note aloud` uses host `window.speechSynthesis`.
   - `Toggle voice dictation` falls back to host `SpeechRecognition` only if the host provides it (unavailable on desktop Electron without a Google Speech API key; on supporting browsers/WebViews, audio is transmitted by the host runtime to that browser/OS speech provider).
3. **Explicit user-triggered model downloads (Planned M1/M2 — not yet shipped)**:
   - Desktop offline models will be downloaded **only after explicit user action** from disclosed HTTPS hosts (`https://huggingface.co` or optional user-selected mirror `https://hf-mirror.com`), verified against pinned **SHA256** checksums.
   - Downloaded models will be stored **outside your Vault** (`~/.cache/voice-mode/models/` on macOS/Linux, `%LOCALAPPDATA%\voice-mode\models\` on Windows) so 200+ MB files never sync through Obsidian Sync, iCloud, or Git.
4. **Optional BYOK endpoints (Planned M3 — not yet shipped)**:
   - Outbound LLM/TTS/STT requests occur only when you configure an endpoint and invoke a BYOK command. Requests go directly from Obsidian to your chosen provider—no intermediate proxy operated by this project.
   - API keys are stored exclusively in Obsidian's built-in `app.secretStorage` (`>= 1.11.4`) and are **never written to `data.json`**. Authenticated requests enforce `redirect: 'error'` and redact secrets before truncating errors.
5. **Permissions**: Microphone access is requested only when you actively trigger voice dictation or barge-in listening.
6. **License isolation**: Source code in this repository is MIT-licensed. No third-party model weights or GPL-3.0 `espeak-ng-data` phoneme archives are bundled in git or GitHub Releases; any runtime-downloaded model files retain their respective upstream licenses (`SenseVoice`: FunAudioLLM; `sherpa-onnx` / Kokoro: Apache-2.0; `espeak-ng-data`: GPL-3.0).

---

## Local Development & Verification

Requires **Node.js `>= 22.18.0`** (workspace tests import `.ts` directly via Node native type-stripping; CI runs Node 22) and **`pnpm@12.21.0`**:

```bash
pnpm install --frozen-lockfile
pnpm run check:all
```

`pnpm run check:all` executes `typecheck`, `lint` (including `eslint-plugin-obsidianmd`), `test`, `build`, and `check:release`. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CONTEXT.md](CONTEXT.md) for package boundaries and testing rules.

---

## Roadmap & Open-Source Voice Mode Matrix

- **M0 (Completed · 2026-11-22)**: 6 real-machine Spikes passed in Obsidian `1.15.1` (`Electron 43.8.9`) — Worker WASM 15-min RSS/RTF, Vault-external cache, Copilot `4.0.20` Lexical sidebar injection, API CORS & loopback SSE matrix, `sherpa-onnx@2.0.2` `#3960`/`#1939` verification, and native AEC3 / `SecretStorage` probes.
- **M1 (In Progress)**: Offline WASM dictation (`Silero VAD` + `SenseVoice int8`), custom dictionary, editor/sidebar injection.
- **M2**: Markdown/table-aware spoken read-aloud, captions overlay, AEC3 barge-in & `manual` fallback.
- **M3**: BYOK voice Q&A & polish via `SecretStorage`, mobile degradation verification, 4 mandatory real-machine acoustic gates.
- **M4**: Official `obsidianmd/obsidian-releases` Community Plugin Directory submission.
- **Wave 2 (M5)** & **Wave 3 (M6)**: Reusing `@voice-mode/core` and `@voice-mode/browser` across [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode), upcoming `sillytavern-voice-mode` (full-duplex emotional voice calls), and a unified local `voice-daemon` + Chrome/Edge extension.

See [docs/plan/master-plan.md](docs/plan/master-plan.md) and [docs/adr/README.md](docs/adr/README.md) for full details.

## License

[MIT](LICENSE) © 2026 qishuilalala
