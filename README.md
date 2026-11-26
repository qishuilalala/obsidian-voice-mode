# Voice Mode

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/qishuilalala/obsidian-voice-mode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qishuilalala/obsidian-voice-mode/actions/workflows/ci.yml)

> **Source build (`0.1.0`)** · The GitHub Release and Obsidian Community Plugin Directory submission are pending. Build the plugin locally to try it.
>
> **Features covered by the M0–M6 acceptance records**:
> - **Desktop 100% offline WASM dictation (`SenseVoice WASM`)**: Isolated MEMFS Web Worker running `Silero VAD` + `SenseVoice int8` (`sherpa-onnx@2.0.2`) across `toggle`, `single` (`Dictate single utterance`), and `push-to-talk` modes, with configurable idle Worker auto-unload.
> - **Explicit SHA256-verified Vault-external model manager**: User-triggered downloads for dictation (`245.3 MB`) and optional local `vits-zh-ll` speech (`116.1 MB`) with `.part` HTTP Range resume, mirror failover (`huggingface.co` / `hf-mirror.com` + `registry.npmjs.org` / `registry.npmmirror.com`), and strict Vault-isolation guard (`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`).
> - **Personal vocabulary replacement UI & universal focus injection**: Single-pass CJK/English alias replacement UI (`12 KB` budget) and `FocusTextInjector` cursor-accurate insertion into CodeMirror 6, core Search, Shadow DOM inputs, and Lexical/ProseMirror sidebars (`Copilot 4.0.20`).
> - **Spoken Markdown/table read-aloud, subtitle controls & native AEC3 barge-in**: System `speechSynthesis`, optional desktop offline `vits-wasm` (5 speakers), optional local `kokoro-daemon` (`Kokoro 103` voices with `< 1s` auto-fallback, verified at `3 ms`), and BYOK `openai-compat` / live `mimo` TTS (`SecretStorage` + zero-redirect CORS fallback), paired with size/width subtitle presets, interactive Pause/Resume/Next/Stop controls, automatic stop on note switch, and live native AEC3 hands-free voice barge-in (`180 s` continuous speaker playback with `0` self-interrupts, `66–370 ms < 600 ms` voice interrupt, automatically locking `manual` on `system` TTS).
> - **Optional BYOK voice Q&A, 4-guard transcript polish & cloud ASR (`SecretStorage`)**: Grounded `Ask AI about selection or note` streaming modal (with optional spoken reply and cursor insertion), optional post-dictation 4-layer anti-hallucination LLM polish (falling back cleanly to raw text on any error), and zero-WASM `openai-compat` `/audio/transcriptions` dictation for desktop & mobile (gated on mobile by `Allow cloud fallback on mobile`).
> - **Test coverage**: Android 15 AVD ran the Obsidian 1.15.1 APK. Xcode’s iOS 27 simulator ran a WKWebView harness. Physical phones have not been verified. The joint daemon test used Obsidian and Chrome MV3. See the [acceptance record](docs/qa/acceptance-checklist.md) for the individual checks.

---

## Try it on desktop

1. From the repository root, use Node.js `>= 22.18.0` and `pnpm@12.21.0` to run `pnpm install --frozen-lockfile` followed by `pnpm run build`.
2. Copy `main.js`, `manifest.json`, and `styles.css` into your vault’s `.obsidian/plugins/voice-mode/` folder. Reload Obsidian, open **Settings → Community plugins**, and enable **Voice Mode**.
3. Select a paragraph and run `Read selection or note aloud` from the command palette. For offline dictation, use `Download or verify models` in Voice Mode settings and confirm `SenseVoice WASM (desktop offline)` under `Recognition engine`. Place the cursor in a note and run `Dictate single utterance`.

## Why Voice Mode?

Most Obsidian voice plugins force an awkward trade-off: either require users to manually install and run an external local WebSocket server, upload private notes and audio to third-party cloud services, or read raw Markdown symbols (`| --- |`, code fences, URLs) aloud verbatim.

**Voice Mode** (`id: voice-mode`, `minAppVersion: 1.11.4`) is designed as an **offline-first, zero-external-server voice I/O layer** that works alongside your existing AI plugins (such as Copilot or Smart Connections) rather than replacing them:

- **Zero external server by default (Implemented in M1)**: Desktop offline bilingual (Chinese/English) dictation running in a Web Worker via WASM (`Silero VAD` + `SenseVoice int8`), paired with a custom ASR replacement dictionary UI for domain terms, proper nouns, and `[[wikilinks]]`.
- **Editor & third-party sidebar injection (Implemented in M1)**: Dictate directly into the active Markdown editor or focused third-party sidebars (such as Copilot's Lexical input box) without tight coupling or OS clipboard pollution.
- **Markdown & pipe-table aware read-aloud (Implemented in M2)**: Strips YAML frontmatter, fenced code blocks (```` ``` ```` / `~~~`), math blocks (`$$...$$`), bare URLs, Obsidian callout markers, and Markdown pipe tables while cleaning inline code and Wikilink syntax into natural spoken text—paired with configurable floating captions (`small`/`medium`/`large` font, `narrow`/`medium`/`wide` width, Pause/Next/Stop controls), optional local `vits-wasm` / BYOK TTS, and native AEC3 hands-free barge-in (with automatic `manual` fallback).
- **Optional zero-dependency BYOK Q&A, 4-guard polish & cloud ASR (Implemented in M3)**: Supports OpenAI-compatible endpoints (DeepSeek, Qwen/DashScope, Doubao/Ark, Kimi, SiliconFlow, OpenRouter, OpenAI, Ollama) and Anthropic Messages using Obsidian's native `SecretStorage` (`>= 1.11.4`), plus OpenAI-compatible `/audio/transcriptions` dictation.
- **Optional shared local `voice-daemon` (Implemented in Wave 3 — [`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon))**: For desktop power users who want native `Kokoro 103` voices (`<whisper>` / `<break>` emotion synthesis) and single-instance model sharing (Obsidian and Chrome MV3 measured at `622.7 MB` RSS) without hitting Electron's V8 Memory Cage, with `< 1s` (`3 ms` measured) automatic fallback when offline. This is an advanced, developer-only option (run from source; no installer) and is **not required** by the plugin: desktop offline dictation and read-aloud work without it.

---

## Architecture & Packages

This repository is structured as a three-package pnpm monorepo so core speech logic stays cleanly separated from Obsidian APIs and can power our broader cross-platform Voice Mode series:

| Package | Role | Host Dependencies |
| --- | --- | --- |
| `packages/voice-core` (`@voice-mode/core`) | Zero-dependency pure TypeScript speech pipeline: Markdown/table TTS segmenter, ASR replacement dictionary, emotion tag DSL, pinned model/WASM SHA256 manifest & USTAR tar extractor, `OpenAiCompatAsrTransport`, `OpenAiCompatTtsEngine` / `MimoTtsEngine` + `sniffAudioMime`, secret redaction, and `< 400`-line dual-protocol BYOK LLM router | None (no `obsidian`, no `electron`, no `node:*`) |
| `packages/voice-browser` (`@voice-mode/browser`) | Web Audio / Electron contracts: 16 kHz `AudioWorklet` resampler, native AEC3 runtime probe & `AecBargeInMonitor`, pause/skip `PlaybackQueue`, MEMFS Sherpa Web Worker runtime/client, `VitsWasmTtsEngine`, offline dictation session, and zero-WASM `CloudDictationSession` (`640 ms` pre-roll + endpointing) | Web / Audio standards only (no `obsidian`) |
| `packages/obsidian-plugin` (`@voice-mode/obsidian-plugin`) | Thin Obsidian adapter bundled via `esbuild` into repo-root `main.js` (build limit below 5 MiB) | `obsidian` (`minAppVersion: 1.11.4`) |

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
| **Desktop** (macOS / Windows / Linux, Obsidian `>= 1.11.4`) | Primary (macOS M0–M6 verified, incl. live `voice-daemon` joint E2E) | Supports Web Worker offline WASM dictation (`SenseVoice WASM`), multi-engine read-aloud (`system`, optional local `vits-wasm` / `kokoro-daemon`, BYOK `openai-compat` / live `mimo`) + native AEC3 barge-in, and optional BYOK voice Q&A (`VoiceQaModal`), 4-guard transcript polish, & `openai-compat` / `daemon` ASR |
| **Mobile** (iOS / Android, Obsidian `>= 1.11.4`) | Graceful degradation (`isDesktopOnly: false`; verified on Android 15 AVD Emulator `Obsidian 1.15.1` APK & Xcode `iOS 27.0` Simulator `WKWebView` harness) | Heavy 200 MB+ local WASM models are disabled under `Platform.isMobile` to reduce memory pressure. The tested iOS simulator exposed native `speechSynthesis` (`68` voices), whereas Android System WebView (`124.0`) omits `window.speechSynthesis` (cleanly prompting BYOK TTS while exposing `webkitSpeechRecognition`), gated by `allowCloudFallbackOnMobile` (default `false`) |

> **Mobile dictation is conditional**: it works only when the mobile WebView exposes `SpeechRecognition` and the system speech provider is available; local WASM dictation models and the local `voice-daemon` are disabled on mobile by design. Physical-device verification is pending, so mobile dictation is not advertised as verified — use the desktop path for offline dictation.

### Expression capability disclosure

Capabilities come from `@voice-mode/core`'s expression contract; unsupported facets degrade visibly instead of being silently dropped.

| Engine | Voices | Rate | Pause | Whisper | Emotion |
| --- | --- | --- | --- | --- | --- |
| `system` | host-provided | Yes | Simulated by segment splitting | Stripped | Stripped |
| `vits-wasm` | 5 | Yes | Simulated by segment splitting | — | — |
| `kokoro-daemon` | 103 | Yes | Native `<break Nms>` (≤5000 ms) | Native (×0.5 gain) | — |
| `openai-compat` | provider-dependent | Yes | provider-dependent | provider-dependent | Instructions (provider-dependent) |
| `mimo` | 9 | Yes | provider-dependent | provider-dependent | Instructions |

`<slow>` and `<fast>` scopes map to a per-segment rate multiplier on `system` speech (×0.85 / ×1.15); other scopes degrade as listed above.

---

## Privacy, Network Access & External Model Disclosure

In compliance with Obsidian Developer Policies, all network behavior, model downloads, and credential boundaries are disclosed up front (full details in [SECURITY.md](SECURITY.md)):

1. **Zero telemetry & zero startup calls**: The plugin never phones home, collects analytics, or downloads files silently on load.
2. **Available dictation, read-aloud & voice Q&A commands**:
   - `Toggle voice dictation` / `Dictate single utterance` on desktop with `SenseVoice WASM` runs 100% locally in an isolated Web Worker with zero network calls. When `OpenAI-compatible` (`openai-compat`) is explicitly selected, 16 kHz utterance WAV audio is uploaded to your configured `/audio/transcriptions` endpoint. When left on `System speech recognition`, it falls back to host `SpeechRecognition` only if the host provides it (unavailable on desktop Electron without a Google Speech API key; on supporting browsers/WebViews, audio is transmitted by the host runtime to that browser/OS speech provider).
   - `Read selection or note aloud` defaults to host `window.speechSynthesis`, and supports optional local desktop `VITS WASM` (`100%` offline) or user-configured BYOK `OpenAI-compatible` / `MiMo` TTS endpoints.
   - Long notes are queued to the playback engine with bounded batches and backpressure, so the tail is never dropped; `Pause or resume read-aloud`, `Skip current read-aloud sentence` and `Stop read-aloud` stay responsive.
   - `Check voice runtime status` prints a structured runtime snapshot (engine, platform, model state, barge-in policy) as a notice, and `Copy voice runtime status` copies the same snapshot to the clipboard for issue reports. `Export read-aloud as WAV` renders the selection or note through a WAV-capable engine (local `VITS WASM` or `kokoro-daemon`) into a single file inside the vault; system speech is reported as non-exportable. `Resume read-aloud` continues from the last position of the same note.
   - `Ask AI about selection or note` and `Post-dictation LLM polish` are **disabled by default** (`enableVoiceQa: false`, `enableLlmPolish: false`). Only when enabled do they send the active selection (or bounded active note up to `24,000` chars) and question, or a single dictated utterance for 4-guard cleanup, to your configured LLM endpoint.
3. **Explicit user-triggered model downloads (Desktop, Implemented in M1/M2)**:
   - Desktop offline models are downloaded **only after explicit user action** in Settings from disclosed HTTPS hosts: model weights (`Silero VAD`, `SenseVoice int8`, optional `VITS`) from `https://huggingface.co` or optional mirror `https://hf-mirror.com`, and the `sherpa-onnx@2.0.2` WASM runtime (`Apache-2.0`) from `https://registry.npmjs.org` or `https://registry.npmmirror.com` (`cdn.npmmirror.com`), all verified against pinned **SHA256** checksums and hop-by-hop redirect allowlists.
   - Downloaded models (`245.3 MB` dictation stack; optional `116.1 MB` VITS stack) are stored **outside your Vault** (`~/.cache/voice-mode/models/` on macOS/Linux, `%LOCALAPPDATA%\voice-mode\models\` on Windows, or a validated external path) so large files never sync through Obsidian Sync, iCloud, or Git.
4. **Optional BYOK endpoints (BYOK TTS, LLM Q&A, 4-guard polish & STT implemented in M2/M3 — all opt-in)**:
   - Outbound TTS/LLM/STT requests occur only when you configure an endpoint and invoke or enable a BYOK feature (`/audio/speech`, `/audio/transcriptions`, `/chat/completions`, `/messages`, local loopback HTTP servers such as Ollama / LM Studio, or Xiaomi `MiMo` `https://api.xiaomimimo.com/v1/chat/completions`). On mobile, non-loopback cloud requests are blocked unless `Allow cloud fallback on mobile` (`default: false`) is enabled. Requests go directly from Obsidian to your chosen provider—no intermediate proxy operated by this project.

   - **Voice Q&A / transcript-polish preset providers** (both features **disabled by default**): `DeepSeek` (`api.deepseek.com`), `DashScope Qwen` (`dashscope.aliyuncs.com`), `Volcengine Ark Doubao` (`ark.cn-beijing.volces.com`), `Moonshot Kimi` (`api.moonshot.cn`), `SiliconFlow` (`api.siliconflow.cn`), `OpenRouter` (`openrouter.ai`), `OpenAI` (`api.openai.com`), `Anthropic` (`api.anthropic.com`), plus local `Ollama` (`127.0.0.1:11434`) / `LM Studio` (`127.0.0.1:1234`) and a custom base URL. Requests go directly to the selected provider, only after you enable the feature and save its key.
   - API keys are stored exclusively in Obsidian's built-in `app.secretStorage` (`>= 1.11.4`) and are **never written to `data.json`**. Authenticated requests enforce `redirect: 'error'` and redact secrets before truncating errors.
5. **Permissions**: Microphone access is requested only when you actively trigger voice dictation or barge-in listening.
6. **License isolation**: Source code in this repository is MIT-licensed. No third-party model weights or GPL-3.0 `espeak-ng-data` phoneme archives are bundled in git or GitHub Releases; any runtime-downloaded model files retain their respective upstream licenses (`SenseVoice`: FunAudioLLM; `sherpa-onnx` / Kokoro: Apache-2.0; `espeak-ng-data`: GPL-3.0).

   - **Note on the optional Chinese VITS model (`vits-zh-ll`)**: the Hugging Face model card (`csukuangfj/vits-zh-ll`) does not declare a license. The sherpa-onnx ecosystem treats these converted models as Apache-2.0 in practice, but this has not been confirmed in writing upstream — if you need a clearly-licensed engine, use `system`, `kokoro-daemon`, or a BYOK provider instead.

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
- **M2 (Completed · 2026-11-22)**: Markdown/table-aware spoken read-aloud, captions size/width presets & Pause/Next/Stop controls, optional `vits-wasm` / BYOK TTS (`openai-compat`, `mimo`), and live native AEC3 barge-in (`180 s` zero-self-interrupt soak, `66–370 ms` voice interrupt) & `manual` fallback.
- **M3 & M4 (Completed · 2026-11-22)**: BYOK voice Q&A (`VoiceQaModal`), 4-guard transcript polish (`enableLlmPolish`), `openai-compat` `/audio/transcriptions` dictation (`CloudDictationSession`), `< 1s` `DaemonClient` seam, 401/500 secret redaction audit, desktop acoustic gates (`A-1`–`A-4`), live `MiMo` TTS verification, Fresh Empty Vault / `BRAT 2.2.0` smoke, and mobile `M-1`–`M-5` verification on Android 15 AVD Emulator (`Obsidian 1.15.1` APK, System WebView `124.0`) + Xcode `iOS 27.0` Simulator `WKWebView` harness (`main.js` `284.13 KB`, `166` unit tests; ready for `community.obsidian.md` submission, with physical phones outside the recorded test coverage).
- **Wave 2 (`M5` · Completed · 2026-11-22)**: [`sillytavern-voice-mode`](https://github.com/qishuilalala/sillytavern-voice-mode) (`0.1.0`, commit `b792551`) — SillyTavern `1.19.1` UI extension reusing `75.05%` of `@voice-mode/{core,browser}@0.1.0` (`firstSentenceLeadMs = 341 ms`, `20/20` native AEC3 `detect` barge-in + `stopGeneration()` at avg `205 ms < 600 ms`, character `voiceMap` drawer, cross-sentence `<whisper>` emotion DSL, and optional SSRF-hardened server plugin).
- **Wave 3 (`M6` · Completed · 2026-11-22)**: [`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon) (`0.1.0`, commit `29ca1f9`) — `@voice-mode/daemon` (`127.0.0.1:18790`, `sk-vmd-` 192-bit `0o600` Bearer auth + `Host`/`Origin` allowlist, native `sherpa-onnx-node` unlocking `Kokoro 103` voices + `Zipformer2` + `SenseVoice`) + zero-`<all_urls>` Chrome/Edge MV3 `@voice-mode/browser-extension` (joint E2E verified across real Obsidian `1.15.1` + Chrome `159` sharing `modelInstanceCount = 1` at `622.7 MB` RSS, `<whisper>` + `<break 250ms>` `24 kHz` WAV synthesis, `631 ms` `daemon` ASR, and `3 ms < 1,000 ms` automatic fallback on daemon stop), plus [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) core unification (`-725` net duplicated lines across 8 modules, `110/110` test files green).

See [docs/plan/master-plan.md](docs/plan/master-plan.md) and [docs/adr/README.md](docs/adr/README.md) for full details.

## License

[MIT](LICENSE) © 2026 qishuilalala
