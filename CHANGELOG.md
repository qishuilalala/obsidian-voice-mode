# Changelog

All notable changes to **Voice Mode** (`voice-mode`) will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Git tags omit the leading `v` prefix (e.g. `0.1.0`) to comply with Obsidian Community Plugin Directory conventions.

## [0.1.0] - 2026-11-22

### Fixed

- Read-aloud now starts promptly when a streamed reply begins with a Markdown horizontal rule. A later rule no longer causes intervening prose to disappear. Leading Obsidian properties are handled consistently for full notes, selections and streamed text.

### Added

- Browser hosts can use the shared Web Speech engine and HTML audio sink for playback, timed breaks and prosody.
- Shared packages expose individual modules for bundlers. `pnpm run verify:matrix` rebuilds and compares the packaged bytes with the archives used by each available companion repository.
- The mobile CDP probe can discover local debugging targets and reconnect to the selected vault after a desktop mobile-emulation reload. Run `node scripts/mobile-cdp-probe.mjs --selftest` for its offline checks.

- **Desktop 100% offline WASM dictation (`SenseVoice WASM`)**:
  - Isolated `MEMFS` Web Worker runtime and client (`@voice-mode/browser`: `sherpa-worker-runtime`, `sherpa-worker-client`, `dictation-session`) running `Silero VAD` + `SenseVoice int8` (`sherpa-onnx@2.0.2`) with zero-copy `ArrayBuffer` transfer, post-init `FS.unlink` heap reclamation, `640 ms` pre-roll ring buffering, `toggle` / `single` / `push-to-talk` dictation modes, `Dictate single utterance` command, and configurable idle Worker auto-unload.
- **Explicit SHA256-verified out-of-vault model manager**:
  - `@voice-mode/core` pinned model/WASM SHA256 manifest & pure-JS USTAR tar extractor (`model-manifest`) paired with `@voice-mode/obsidian-plugin` `DesktopModelManager` & `desktop-fs`: user-triggered downloads (`245.3 MB` dictation stack; optional `116.1 MB` `vits-zh-ll` Mandarin speech stack) from allowlisted HTTPS hosts (`huggingface.co` / `hf-mirror.com` and `registry.npmjs.org` / `registry.npmmirror.com`), hop-by-hop redirect validation, `.part` HTTP 206 resume, streaming 1 MB SHA256 verification, canonical `realpath` Vault-isolation guard (`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`), and Settings UI controls.
- **Personal vocabulary replacement dictionary & universal focus injection**:
  - Visual multi-alias ASR replacement dictionary editor in Settings (`12 KB` UTF-8 budget, supporting proper nouns and `[[wikilinks]]`) and `@voice-mode/browser` `FocusTextInjector` (`focus-injector.ts`) supporting CodeMirror 6, core Search, Shadow DOM `<textarea>`, and Lexical/ProseMirror `contenteditable` sidebars (`Copilot 4.0.20`) via in-memory synthetic `ClipboardEvent("paste")` without OS clipboard pollution.
- **Markdown/table-aware spoken read-aloud, subtitle controls & native AEC3 barge-in**:
  - `@voice-mode/core` `SentenceSegmenter` (stripping YAML frontmatter, fenced code, math blocks, bare URLs, callouts, and pipe tables), emotion tag DSL & prompt compiler (`emotion.ts`), `sniffAudioMime`, pure-JS `decodeBase64Strict`, `OpenAiCompatTtsEngine`, `MimoTtsEngine` (`api-key` header isolation, natural-language speed prompt), and `< 1s` fast-fallback loopback `DaemonClient` (`daemon-client.ts`, supporting desktop `daemon` ASR and `kokoro-daemon` TTS).
  - `@voice-mode/browser` `VitsWasmTtsEngine` (5 speakers, single-heavy-model mutual exclusion with `SenseVoice int8`), `PlaybackQueue` `pause()` / `resume()` / `skipCurrent()`, and `AecBargeInMonitor` (`autoGainControl: false`, automatic `manual` lock on `system` TTS or missing native AEC).
  - `@voice-mode/obsidian-plugin` & `styles.css`: `createObsidianFetchWithCorsFallback` (`fetch` -> desktop zero-redirect Node stream -> mobile `requestUrl`), dedicated `bargeInWorkerClient`, per-preset TTS `SecretStorage` isolation, floating subtitle size/width presets, interactive `Pause`/`Resume`/`Next`/`Stop` buttons, and automatic stop on note switch.
- **Optional BYOK voice Q&A, 4-guard transcript polish & cloud ASR (`SecretStorage`)**:
  - `@voice-mode/core`: `OpenAiCompatAsrTransport` (pure `Uint8Array` RFC 7578 `multipart/form-data` + 44-byte RIFF WAV encoder, Whisper locale normalization, `redirect: "error"`, pre-truncation `redactSecrets`) and `llm-router.ts` (`396 < 400` lines: OpenAI-compatible + Anthropic Messages SSE streaming, loopback `http://` keyless override, and 4-layer anti-hallucination `applyCorrectionGuards`).
  - `@voice-mode/browser`: zero-WASM, zero-Worker `CloudDictationSession` (`640 ms` pre-roll ring buffer, RMS endpointing, `60s` forced split, and `sessionEpoch` zero-leak cancellation).
  - `@voice-mode/obsidian-plugin`: `VoiceQaModal` (`ask-ai-about-note`: selection/note context up to `24,000` chars, streaming reply, optional sentence read-aloud, single-utterance question dictation, and `Insert at cursor`), `enableLlmPolish` with zero-data-loss fallback, and `allowCloudFallbackOnMobile` (`default: false`) mobile privacy guard.
- **Workspace governance, compiled package artifacts & CI/Release gates**:
  - Three-package pnpm monorepo (`@voice-mode/core`, `@voice-mode/browser`, `@voice-mode/obsidian-plugin`; `build:packages` emitting verified `dist/*.js` + `.d.ts`; `main.js` = `284.13 KB < 5 MB`; `166` unit tests), `GLOSSARY.md`, `CODING_STANDARDS.md`, ADRs `0001`–`0005`, `SECURITY.md`, cross-OS CI matrix (`eslint-plugin-obsidianmd@0.6.0`), and 3-asset no-`v` tag GitHub Release workflow.

### Verified

- **Desktop real-device M0–M3 & live cloud gates** on macOS `27.2.1` (Apple M2 Max, 32 GB) in Obsidian `1.15.1` (`Electron 43.8.9` / `Chromium 150.0.7871.250`):
  - **M0–M2 WASM & AEC3**: `Silero VAD` cold load `30 ms`, `SenseVoice int8` cold load `485 ms`, 15-min 60-utterance average `RTF = 0.2148`, flat `512 MB` WASM heap, `Copilot 4.0.20` `10/10` Lexical injections, `+8.99 dB` native AEC3 suppression, `180 s` speaker soak with `0` self-interrupts, and `66–370 ms` voice barge-in.
  - **M3/M4 acoustic, Fresh Vault/BRAT & live `MiMo` TTS**: Passed `A-1` (`15.91:1` light / `12.19:1` dark contrast, `< 100 ms` stop), `A-2`, `A-3` (offline `53.1 s` CJK+EN corpus `3/3` vocabulary hits), `A-4` (`120 s` `manual` speaker soak), Fresh Empty Vault 3-file cold load (`5.8 ms`, `0` symlinks, `0` startup network calls, `0` errors) alongside `BRAT 2.2.0`, and live `MiMo` cloud TTS (`https://api.xiaomimimo.com/v1/chat/completions`, `res.ok` HTTP 2xx + magic-byte `199.7 KB` WAV, `6.72 s` playback, `1.3 ms` stop, `0` secrets in `data.json`).
- **Mobile runtime verification (`M-1`–`M-5`)**:
  - **Android 15 AVD Emulator (`Obsidian 1.15.1` APK, System WebView `124.0`)**: Verified `0` Node errors & status bar unmounted (`M-1`), WASM disabled & desktop-synced `sensevoice-wasm`/`vits-wasm` degraded to `system` while documenting missing `window.speechSynthesis` vs present `webkitSpeechRecognition` (`M-2`), privacy gate + `SecretStorage` BYOK dictation & streaming Q&A with `0` secrets in `data.json` (`M-3`), `307.3 s` continuous read-aloud + `25` 5-note switches with flat `24.80 MB` JS heap & `0` WebView crashes (`M-4`), and OS `RECORD_AUDIO` revocation `NotAllowedError` Notice + `idle` recovery (`M-5`).
  - **Xcode `iOS 27.0` Simulator `WKWebView` harness (`iPhone 18 Pro`, `AppleWebKit/605.1.15`)**: Verified `68` native `speechSynthesis` voices (`2` `zh-*`, `25` `en-*`), `PlaybackQueue` pause/resume/cancel, `FocusTextInjector` `<textarea>`/`contenteditable` injection, `CloudDictationSession` WAV upload & `abort()` lifecycle, and `main.js` mobile load with `0` errors (optional physical pocket iPhone/Android phone check noted in `docs/qa/acceptance-checklist.md`).
