# Changelog

All notable changes to **Obsidian Voice Mode** (`voice-mode`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Git tags omit the leading `v` prefix (e.g. `0.1.0`) to comply with Obsidian Community Plugin Directory conventions.

## [Unreleased]

### Added (M3 BYOK Voice Q&A, 4-Guard Polish, Cloud ASR & Pre-Release Acoustic Gates — 2026-11-22)

- **BYOK Voice Q&A, 4-layer anti-hallucination polish & OpenAI-compatible ASR (`SecretStorage`)**:
  - `@voice-mode/core`: `OpenAiCompatAsrTransport` (`asr-engines.ts`: pure `Uint8Array` RFC 7578 `multipart/form-data` + 44-byte RIFF WAV encoder, Whisper locale normalization, `redirect: "error"`, `25 MiB` upload cap, pre-truncation `redactSecrets`) and `llm-router.ts` (`395 < 400` lines: loopback `http://` keyless override + non-SSE `application/json` `streamChat` fallback).
  - `@voice-mode/browser`: zero-WASM, zero-Worker `CloudDictationSession` (`cloud-dictation-session.ts`: `640 ms` pre-roll ring buffer, RMS endpointing, `60s` forced split, and `sessionEpoch` zero-leak cancellation across `toggle`, `single`, and `push-to-talk` modes).
  - `@voice-mode/obsidian-plugin` & `styles.css`: `VoiceQaModal` (`ask-ai-about-note`: active selection/note context up to `24,000` chars, streaming SSE reply, optional sentence read-aloud, single-utterance question dictation, and `Insert at cursor`), `enableLlmPolish` 4-guard post-dictation cleanup with zero-data-loss fallback, instant blocked-VITS Worker termination on dictation switch, and `settingsWriteEpoch` concurrency guard (`main.js` = `261.94 KB`, `147` unit tests).
- **Verified (M3 Security Redaction & Desktop Acoustic Gates `A-1`–`A-4`)**:
  - Verified zero plaintext secrets in `.obsidian/plugins/voice-mode/data.json`, zero secret leakage across Console/Notices/Modal on simulated `HTTP 401`/`500` responses, desktop real-device pass on `A-1` (`15.91:1` / `12.19:1` contrast, `< 100 ms` stop), `A-2` (`0` Markdown/5×5 table noise, `83–202 ms < 600 ms` voice barge-in), `A-3` (offline `53.1 s` 6-breath CJK+EN corpus `3/3` vocabulary replacements), and `A-4` (`120,005 ms` `manual` speaker read-aloud `0` self-interrupts + live Push-to-Talk insertion & clean mic release), plus `M-1`–`M-5` mobile emulation & 5-minute 5-note soak (`+1.70 MB` JS heap delta) in Obsidian `1.15.1` `app.emulateMobile(true)` and Apple `JavaScriptCore` (`check:release` 7/7 checks).

### Added (M2 Spoken Read-Aloud, Subtitle Controls, Multi-Engine TTS & Native AEC3 Barge-In — 2026-11-22)

- **Multi-engine TTS routing & zero-redirect CORS fallback**:
  - `@voice-mode/core`: `sniffAudioMime` (magic-byte detection rejecting HTML/JSON 200 responses), pure-JS `decodeBase64Strict`, `OpenAiCompatTtsEngine` (`TTS_OPENAI_PRESETS` + loopback self-hosted `/audio/speech`, `16 MiB` cap, `redirect: "error"`), and `MimoTtsEngine` (`api-key` header isolation, natural-language speed prompt, `24 MiB` JSON cap).
  - `@voice-mode/browser`: `VitsWasmTtsEngine` (`5` speakers, single-heavy-model mutual exclusion with `SenseVoice int8`), `PlaybackQueue` `pause()` / `resume()` / `skipCurrent()`, and `AecBargeInMonitor` (`autoGainControl: false`, automatic `manual` lock on `system` TTS or missing native AEC).
  - `@voice-mode/obsidian-plugin` & `styles.css`: `createObsidianFetchWithCorsFallback` (`fetch` -> desktop zero-redirect Node stream -> mobile `requestUrl`), optional `vits-zh-ll` external cache download/verify UI, dedicated lightweight `bargeInWorkerClient` (`180 s` continuous speaker playback with `0` self-interrupts, `66–370 ms` measured voice barge-in), per-preset TTS `SecretStorage` isolation, floating subtitle size/width presets (`15.91:1` light / `12.19:1` dark WCAG contrast), interactive `Pause`/`Resume`/`Next`/`Stop` buttons, and automatic stop on note switch (`main.js` = `213.11 KB`, `115` unit tests).

### Added (M1 Desktop Offline WASM Dictation — 2026-11-22)

- **Desktop 100% offline WASM dictation (`SenseVoice WASM`)**:
  - Isolated `MEMFS` Web Worker runtime and client (`@voice-mode/browser`: `sherpa-worker-runtime`, `sherpa-worker-client`, `dictation-session`) running `Silero VAD` + `SenseVoice int8` (`sherpa-onnx@2.0.2`) with zero-copy `ArrayBuffer` transfer, post-init `FS.unlink` heap reclamation, `640 ms` pre-roll ring buffering, `toggle` / `single` / `push-to-talk` dictation modes, `Dictate single utterance` command, and configurable idle Worker auto-unload (`main.js` = `159.36 KB`).
- **Explicit SHA256-verified external model manager**:
  - `@voice-mode/core` pinned model/WASM SHA256 manifest & pure-JS USTAR tar extractor (`model-manifest`) paired with `@voice-mode/obsidian-plugin` `DesktopModelManager` & `desktop-fs`: user-triggered downloads from allowlisted HTTPS hosts (`huggingface.co` / `hf-mirror.com` and `registry.npmjs.org` / `registry.npmmirror.com`), hop-by-hop redirect validation, `.part` HTTP 206 resume, streaming 1 MB SHA256 verification, canonical `realpath` Vault-isolation guard (`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`), and Settings UI controls (`Download or verify models`, `Cancel download`, `Open cache folder`, `Clear cached models`).
- **Personal vocabulary replacement UI & universal editor/sidebar injection**:
  - Visual multi-alias ASR replacement dictionary editor in Settings (`12 KB` UTF-8 budget, supporting proper nouns and `[[wikilinks]]`) and `editor-bridge` in-memory synthetic `ClipboardEvent("paste")` dispatch for Lexical/ProseMirror `contenteditable` sidebars (`Copilot 4.0.20`) without touching the OS clipboard.

### Verified (M0 Real-Device Spikes — 2026-11-22)

- **M0 6-item real-device gate completed** on macOS `27.2.1` (Apple M2 Max, 32 GB) inside Obsidian `1.15.1` (`Electron 43.8.9` / `Chromium 150.0.7871.250`), archived in `docs/qa/acceptance-checklist.md`:
  - **S0-1**: Pure MEMFS Web Worker (`sherpa-onnx@2.0.2`) cold-loaded `Silero VAD` in `30 ms` and `SenseVoice int8` in `485 ms`, sustained a 15-minute (60-utterance) session at average `RTF = 0.2148` with flat `512 MB` WASM linear memory (`+348.7 MB` steady renderer RSS delta), and reclaimed memory cleanly upon `worker.terminate()`.
  - **S0-2**: Verified `245.3 MB` out-of-vault model cache (`~/.cache/voice-mode/models/`) with pinned SHA256 checks, zero model files inside the Vault or `.obsidian/plugins/voice-mode/`, and `605.2 MB/s` read verification across full Obsidian process restarts.
  - **S0-3**: Verified `10/10` consecutive mixed CJK/English/multiline injections with intact Undo/Redo across CodeMirror 6, core Search, Shadow DOM `<textarea>`, and `Copilot 4.0.20` (Lexical `contenteditable` verified via M0 CDP prototype using synthetic `ClipboardEvent("paste")`, scheduled to land in `editor-bridge.ts` in M1).
  - **S0-4**: Built empirical `Origin: app://obsidian.md` CORS & loopback SSE matrix across 8 cloud endpoints + local loopback simulation (confirming CORS preflight/POST pass via `HTTP 401` on DeepSeek, DashScope Qwen, Kimi, SiliconFlow, OpenRouter, and Anthropic with direct-browser header; 3-chunk `fetch` SSE streaming and Ollama `Origin` block on local loopback server; and main-process `requestUrl` fallback for Volcengine Ark, OpenAI, and strict-Origin loopback).
  - **S0-5**: Confirmed `k2-fsa/sherpa-onnx#3960` (`kokoro-int8` WASM `NaN` silence) persists in `2.0.2` (disabling WASM Kokoro in M2) while `#1939` (`vits-zh-ll` variable-length memory growth) is resolved (`438 MB` steady RSS over 80 sentences, `RTF = 1.275`).
  - **S0-6**: Verified `48k->16k AudioWorklet` capture, measured `+8.99 dB` native Chromium AEC3 suppression on `HTMLAudioElement` (`autoGainControl: false`), identified missing Chromium render reference on OS `speechSynthesis` (locking `manual` barge-in for `system` TTS), and verified desktop `app.secretStorage` isolation (physical iOS/Android device verification tracked for M3).

### Planned (see `docs/plan/master-plan.md`)

- **M4**: Physical iOS/Android mobile device degradation verification (`M-1`–`M-5`) and official `obsidianmd/obsidian-releases` Community Plugin Directory submission.
- **M5–M6**: Wave 2 `sillytavern-voice-mode` and Wave 3 unified local `voice-daemon` + Chrome/Edge extension.

## [0.1.0] - 2026-11-21

> **Status**: `0.1.0` (Alpha architecture baseline). Offline WASM inference, Vault-external SHA256 model downloading, and BYOK voice Q&A UI are **not yet implemented**; the plugin skeleton currently exposes a zero-config system `speechSynthesis` read-aloud preview and a placeholder browser `SpeechRecognition` fallback (unavailable on desktop Electron builds without a Google Speech API key). See `docs/rules/STATE.md` for exact readiness boundaries.

### Added

- **Monorepo architecture**: Three-package pnpm workspace (`@voice-mode/core`, `@voice-mode/browser`, `@voice-mode/obsidian-plugin`) bundled into Obsidian-compatible `main.js` via `esbuild`.
- **Obsidian plugin skeleton & metadata**: `manifest.json` (`id: "voice-mode"`, `minAppVersion: "1.11.4"`, `isDesktopOnly: false`), `versions.json`, `styles.css`, registered commands (`Toggle voice dictation`, `Read selection or note aloud`, `Stop read-aloud`, `Check voice runtime status`), settings tab, subtitle overlay, and desktop/mobile runtime guards.
- **Governance & architecture docs**: `docs/plan/master-plan.md`, `CONTEXT.md`, `docs/rules/STATE.md`, ADRs `0001`–`0004`, `docs/qa/acceptance-checklist.md`, and `docs/distribution/launch-playbook.md`.
- **CI/CD & community hygiene**: Cross-OS CI matrix (Ubuntu / macOS / Windows, Node 22 + `pnpm@12.21.0`, `eslint-plugin-obsidianmd`, `pnpm audit`), Obsidian-compliant release workflow (no-`v` tag validation, 5 MB `main.js` budget check, 3-asset upload only), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (MIT), and Issue/PR templates.
