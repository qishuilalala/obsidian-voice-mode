# Voice Mode for Obsidian

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **Project Status (`0.1.0` Alpha · M0, M1 & M2 Completed on `main`)**
>
> **What works on `main` today vs. what is still in progress**:
> - **Shipped on `main` (M0 + M1 + M2)**:
>   - **Desktop 100% offline WASM dictation (`SenseVoice WASM`)**: Isolated MEMFS Web Worker running `Silero VAD` + `SenseVoice int8` (`sherpa-onnx@2.0.2`) across `toggle`, `single` (`Dictate single utterance`), and `push-to-talk` modes, with configurable idle Worker auto-unload (`main.js` = `213.1 KB`).
>   - **Explicit SHA256-verified Vault-external model manager**: User-triggered downloads for dictation (`245.3 MB`) and optional local `vits-zh-ll` speech (`116.1 MB`) with `.part` HTTP Range resume, mirror failover (`huggingface.co` / `hf-mirror.com` + `registry.npmjs.org` / `registry.npmmirror.com`), and strict Vault-isolation guard (`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`).
>   - **Personal vocabulary replacement UI & universal focus injection**: Single-pass CJK/English alias replacement UI (`12 KB` budget) and cursor-accurate insertion into CodeMirror 6, core Search, Shadow DOM inputs, and Lexical/ProseMirror sidebars (`Copilot 4.0.20`).
>   - **Spoken Markdown/table read-aloud, subtitle controls & native AEC3 barge-in**: System `speechSynthesis`, optional desktop offline `vits-wasm` (5 speakers), and BYOK `openai-compat` / `mimo` TTS (`SecretStorage` + zero-redirect CORS fallback), paired with size/width subtitle presets, interactive Pause/Resume/Next/Stop controls, automatic stop on note switch, and live native AEC3 hands-free voice barge-in (`180 s` continuous speaker playback with `0` self-interrupts, `66–370 ms < 600 ms` voice interrupt, automatically locking `manual` on `system` TTS).
> - **Not yet implemented (Planned M3)**: BYOK `llm-router` voice Q&A & 4-guard transcript polish UI (`SecretStorage`), mobile physical device verification (`M-1`–`M-5`), and the 4 pre-release acoustic sign-off gates (`A-1`–`A-4`). Track progress in [docs/rules/STATE.md](docs/rules/STATE.md) and [docs/plan/master-plan.md](docs/plan/master-plan.md).

---

## Why Voice Mode?

Most Obsidian voice plugins force an awkward trade-off: either require users to manually install and run an external local WebSocket server, upload private notes and audio to third-party cloud services, or read raw Markdown symbols (`| --- |`, code fences, URLs) aloud verbatim.

**Voice Mode** (`id: voice-mode`, `minAppVersion: 1.11.4`) is designed as an **offline-first, zero-external-server voice I/O layer** that works alongside your existing AI plugins (such as Copilot or Smart Connections) rather than replacing them:

- **Zero external server by default (Shipped in M1)**: Desktop offline bilingual (Chinese/English) dictation running in a Web Worker via WASM (`Silero VAD` + `SenseVoice int8`), paired with a custom ASR replacement dictionary UI for domain terms, proper nouns, and `[[wikilinks]]`.
- **Editor & third-party sidebar injection (Shipped in M1)**: Dictate directly into the active Markdown editor or focused third-party sidebars (such as Copilot's Lexical input box) without tight coupling or OS clipboard pollution.
- **Markdown & pipe-table aware read-aloud (Shipped in M2)**: Strips YAML frontmatter, fenced code blocks (```` ``` ```` / `~~~`), math blocks (`$$...$$`), bare URLs, Obsidian callout markers, and Markdown pipe tables while cleaning inline code and Wikilink syntax into natural spoken text—paired with configurable floating captions (`small`/`medium`/`large` font, `narrow`/`medium`/`wide` width, Pause/Next/Stop controls), optional local `vits-wasm` / BYOK TTS, and native AEC3 hands-free barge-in (with automatic `manual` fallback).
- **Optional zero-dependency BYOK Q&A & polish (Planned M3)**: Supports OpenAI-compatible endpoints (DeepSeek, Qwen/DashScope, Doubao/Ark, Kimi, SiliconFlow, OpenRouter, OpenAI, Ollama) and Anthropic Messages using Obsidian's native `SecretStorage` (`>= 1.11.4`).
- **Optional shared local `voice-daemon` (Planned Wave 3)**: For desktop power users who want Kokoro 103 voices or multi-app model sharing across Obsidian, SillyTavern, and browser extensions without hitting Electron's V8 Memory Cage.

---

## Architecture & Packages

This repository is structured as a three-package pnpm monorepo so core speech logic stays cleanly separated from Obsidian APIs and can power our broader cross-platform Voice Mode series:

| Package | Role | Host Dependencies |
| --- | --- | --- |
| `packages/voice-core` (`@voice-mode/core`) | Zero-dependency pure TypeScript speech pipeline: Markdown/table TTS segmenter, ASR replacement dictionary, emotion tag DSL, pinned model/WASM SHA256 manifest & USTAR tar extractor, `OpenAiCompatTtsEngine` / `MimoTtsEngine` + `sniffAudioMime`, secret redaction, and dual-protocol BYOK LLM router | None (no `obsidian`, no `electron`, no `node:*`) |
| `packages/voice-browser` (`@voice-mode/browser`) | Web Audio / Electron contracts: 16 kHz `AudioWorklet` resampler, native AEC3 runtime probe & `AecBargeInMonitor`, pause/skip `PlaybackQueue`, MEMFS Sherpa Web Worker runtime/client, `VitsWasmTtsEngine`, and offline dictation session (`640 ms` pre-roll + VAD endpointing) | Web / Audio standards only (no `obsidian`) |
| `packages/obsidian-plugin` (`@voice-mode/obsidian-plugin`) | Thin Obsidian adapter bundled via `esbuild` into repo-root `main.js` (`213.1 KB`, well under the `< 5 MB` Obsidian Sync budget) | `obsidian` (`minAppVersion: 1.11.4`) |

### Verified In-Obsidian Web Worker WASM Benchmarks (M0, M1 & M2 Gates Passed · 2026-11-22)

Measured inside real **Obsidian `1.15.1` (`Electron 43.8.9` / `Chromium 150.0.7871.250`) on Apple M2 Max macOS `27.2.1` (32 GB RAM)** using `sherpa-onnx@2.0.2` WASM in an isolated MEMFS Web Worker over a 15-minute (60-utterance) continuous session and M1 end-to-end plugin dictation (full report in [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md)):

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
| **Desktop** (macOS / Windows / Linux, Obsidian `>= 1.11.4`) | Primary (macOS M0–M2 verified; M3 in progress) | Shipped Web Worker offline WASM dictation (`SenseVoice WASM`) + multi-engine read-aloud (`system`, optional local `vits-wasm`, BYOK `openai-compat`/`mimo`) + native AEC3 barge-in; planned M3 BYOK Q&A + Wave 3 optional `voice-daemon` |
| **Mobile** (iOS / Android, Obsidian `>= 1.11.4`) | Graceful degradation (`isDesktopOnly: false`, pending M3 verification) | Heavy 200 MB+ local WASM models are strictly disabled under `Platform.isMobile` to respect iOS WKWebView (~500 MB Jetsam) limits; uses BYOK API + system speech |

---

## Privacy, Network Access & External Model Disclosure

In compliance with Obsidian Developer Policies, all network behavior, model downloads, and credential boundaries are disclosed up front (full details in [SECURITY.md](SECURITY.md)):

1. **Zero telemetry & zero startup calls**: The plugin never phones home, collects analytics, or downloads files silently on load.
2. **Shipped dictation & read-aloud commands**:
   - `Toggle voice dictation` / `Dictate single utterance` on desktop with `SenseVoice WASM` runs 100% locally in an isolated Web Worker with zero network calls. When left on `System speech recognition`, it falls back to host `SpeechRecognition` only if the host provides it (unavailable on desktop Electron without a Google Speech API key; on supporting browsers/WebViews, audio is transmitted by the host runtime to that browser/OS speech provider).
   - `Read selection or note aloud` defaults to zero-network host `window.speechSynthesis`, and supports optional local desktop `VITS WASM` (`100%` offline) or user-configured BYOK `OpenAI-compatible` / `MiMo` TTS endpoints.
3. **Explicit user-triggered model downloads (Desktop, Shipped in M1/M2)**:
   - Desktop offline models are downloaded **only after explicit user action** in Settings from disclosed HTTPS hosts: model weights (`Silero VAD`, `SenseVoice int8`, optional `VITS`) from `https://huggingface.co` or optional mirror `https://hf-mirror.com`, and the `sherpa-onnx@2.0.2` WASM runtime (`Apache-2.0`) from `https://registry.npmjs.org` or `https://registry.npmmirror.com` (`cdn.npmmirror.com`), all verified against pinned **SHA256** checksums and hop-by-hop redirect allowlists.
   - Downloaded models (`245.3 MB` dictation stack; optional `116.1 MB` VITS stack) are stored **outside your Vault** (`~/.cache/voice-mode/models/` on macOS/Linux, `%LOCALAPPDATA%\voice-mode\models\` on Windows, or a validated external path) so large files never sync through Obsidian Sync, iCloud, or Git.
4. **Optional BYOK endpoints (BYOK TTS shipped in M2; BYOK LLM Q&A & STT planned M3)**:
   - Outbound TTS/LLM/STT requests occur only when you configure an endpoint and invoke a BYOK command (e.g. `OpenAI-compatible` `/audio/speech` presets such as SiliconFlow, OpenRouter, OpenAI, Groq, or self-hosted loopback, or Xiaomi `MiMo` `https://api.xiaomimimo.com/v1/chat/completions`). Requests go directly from Obsidian to your chosen provider—no intermediate proxy operated by this project.
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
- **M1 (Completed · 2026-11-22)**: Desktop offline WASM dictation (`Silero VAD` + `SenseVoice int8`), SHA256 Vault-external model manager, personal vocabulary replacement UI, and CM6 / Copilot Lexical injection.
- **M2 (Completed · 2026-11-22)**: Markdown/table-aware spoken read-aloud, captions size/width presets & Pause/Next/Stop controls, optional `vits-wasm` / BYOK TTS (`openai-compat`, `mimo`), and live native AEC3 barge-in (`180 s` zero-self-interrupt soak, `66–370 ms` voice interrupt) & `manual` fallback (`main.js` `213.1 KB`).
- **M3 (Next)**: BYOK voice Q&A & polish via `SecretStorage`, mobile degradation verification, 4 mandatory real-machine acoustic gates.
- **M4**: Official `obsidianmd/obsidian-releases` Community Plugin Directory submission.
- **Wave 2 (M5)** & **Wave 3 (M6)**: Reusing `@voice-mode/core` and `@voice-mode/browser` across [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode), upcoming `sillytavern-voice-mode` (full-duplex emotional voice calls), and a unified local `voice-daemon` + Chrome/Edge extension.

See [docs/plan/master-plan.md](docs/plan/master-plan.md) and [docs/adr/README.md](docs/adr/README.md) for full details.

## License

[MIT](LICENSE) © 2026 qishuilalala
