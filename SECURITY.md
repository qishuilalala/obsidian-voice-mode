# Security Policy / 安全策略

## Supported Versions / 支持的版本

Only the latest release receives security fixes. The repository is currently at **`0.1.0` (Alpha · M0, M1, M2 & M3 shipped on `main`)**; breaking security or storage adjustments may occur prior to `1.0.0`.

仅最新版本接收安全修复。当前仓库处于 **`0.1.0`（Alpha · `main` 已落地 M0、M1、M2 与 M3）**，在 `1.0.0` 正式版前可能发生安全边界或配置结构调整。

## Reporting a Vulnerability / 报告漏洞

Please **do not** disclose security vulnerabilities in public GitHub issues, pull requests, or discussions. Use GitHub's private vulnerability reporting channel (**Security → Report a vulnerability** on `qishuilalala/obsidian-voice-mode`). We will acknowledge receipt, assess severity, and coordinate disclosure once a fix is released.

请**不要**在公开 Issue、PR 或讨论区披露安全漏洞细节。请使用本仓库的私密漏洞报告入口（**Security → Report a vulnerability**）。我们会尽快确认并在发布修复后于 `CHANGELOG.md` 同步说明。

---

## Privacy & Data Flow Boundaries / 隐私与数据流边界

### 1. Zero Telemetry / 零遥测承诺

- This plugin sends **zero telemetry, zero analytics, zero crash reports, and zero usage tracking**.
- No network requests are made on plugin startup.

本插件**零遥测、零埋点、零崩溃上报**，启动时不会发起任何静默外联请求。

### 2. Shipped Commands & Data Flows (`main` / M3 Baseline) / 当前已上线命令的数据流

- **Toggle voice dictation / Dictate single utterance** (`toggle-dictation`, `dictate-single-utterance`):
  - **Desktop offline mode (`SenseVoice WASM`, shipped in M1)**: Runs **100% locally** inside an isolated Web Worker (`Silero VAD` + `SenseVoice int8` via `sherpa-onnx@2.0.2` WASM). Raw microphone audio and transcripts **never leave your device** (unless you explicitly enable `Post-dictation LLM polish`), and zero outbound network calls occur during dictation.
  - **Optional desktop local voice daemon (`daemon`, desktop only)**: When explicitly selected on desktop, 16 kHz utterance WAV audio is sent strictly to your local loopback `voice-daemon` (`127.0.0.1`, `localhost`, or `[::1]` — non-loopback hosts and embedded URL credentials are rejected, zero remote calls occur) via native browser `fetch` (preserving `Origin: app://obsidian.md` allowlist checks) with an optional bearer token stored in `app.secretStorage` (`daemonTokenSecretId`). If the local daemon is offline or unauthorized, dictation degrades within `< 1 s` to cached `SenseVoice WASM` or configured `openai-compat`.
  - **Optional BYOK OpenAI-compatible transcription (`openai-compat`, shipped in M3)**: Only when explicitly selected by the user (and on mobile only when `Allow cloud fallback on mobile` is enabled, or when targeting a local loopback server), 16 kHz utterance WAV audio is uploaded via HTTPS (or loopback HTTP) to your configured `/audio/transcriptions` endpoint using your `SecretStorage` API key.
  - **Host browser fallback (`system`)**: When recognition engine is left on `System speech recognition`, the command uses the host runtime's native `SpeechRecognition` / `webkitSpeechRecognition` API **only if exposed by the host**. On standard desktop Obsidian Electron builds without a bundled Google Speech API key, browser recognition is unavailable (the plugin prompts you to switch to `SenseVoice WASM`); on browsers or mobile WebViews that do provide native `SpeechRecognition`, microphone audio is sent by the host runtime to that browser or OS speech service provider.
- **Ask AI about selection or note & Post-dictation LLM polish** (`ask-ai-about-note`, `enableLlmPolish`, shipped in M3):
  - **Disabled by default (`enableVoiceQa: false`, `enableLlmPolish: false`)**: Zero text leaves your device unless you explicitly turn these toggles on.
  - When enabled, only the active selection (or bounded active note up to `24,000` chars) and your question—or the single dictated utterance for 4-guard polish—are sent directly to your configured OpenAI-compatible (`/chat/completions`) or Anthropic (`/messages`) endpoint (or local loopback server such as Ollama / LM Studio). On mobile, non-loopback cloud requests are blocked unless `Allow cloud fallback on mobile` is enabled.
- **Read selection or note aloud** (`read-aloud`, `pause-resume-read-aloud`, `skip-read-aloud-sentence`, `stop-read-aloud`):
  - **System speech (`system`, default)**: Uses the host's native `window.speechSynthesis` API (zero plugin network calls; uses local OS voices or whatever voice provider your OS/browser is configured with). Hands-free barge-in is locked to `manual` because OS speech synthesis bypasses Chromium's echo canceller.
  - **Desktop local offline VITS (`vits-wasm`, shipped in M2)**: Synthesizes speech **100% locally** in an isolated Web Worker (`csukuangfj/sherpa-onnx-vits-zh-ll`) with zero outbound network calls; when `bargeInMode` is `detect` or `auto` and native AEC3 is active, local `Silero VAD` monitors microphone audio locally (`autoGainControl: false`) to stop playback on voice interruption without uploading audio anywhere.
  - **Desktop local Kokoro daemon (`kokoro-daemon`, desktop only)**: Sends cleaned sentence text strictly to your local loopback `voice-daemon` (`127.0.0.1`, `localhost`, or `[::1]`, zero remote calls) via native browser `fetch` (enforcing `Origin: app://obsidian.md` allowlisting) and optional `app.secretStorage` bearer token (`daemonTokenSecretId`), falling back within `< 1 s` to local `vits-wasm` (if cached) or `system` speech when offline.
  - **Optional BYOK cloud TTS (`openai-compat`, `mimo`, shipped in M2)**: Only when explicitly selected by the user (and gated on mobile by `Allow cloud fallback on mobile`), cleaned sentence text is sent over HTTPS (or loopback HTTP for self-hosted servers) to your configured `/audio/speech` endpoint or Xiaomi MiMo (`https://api.xiaomimimo.com/v1/chat/completions`).

当前已上线命令的数据流说明：

- **切换听写 / 单句听写**（`toggle-dictation`、`dictate-single-utterance`）：桌面 `SenseVoice WASM` 模式 **100% 本地运行**、零网络外联；桌面可选 `daemon` 严格仅访问本机回环 `voice-daemon`（`127.0.0.1` / `localhost` / `[::1]`，零远程外联，走原生浏览器 `fetch` 保留 `Origin: app://obsidian.md` 白名单校验，可选令牌引用 `daemonTokenSecretId` 存于 `app.secretStorage`，离线时 `< 1 s` 自动降级）；选用 `openai-compat` 时仅将切分后的 16 kHz WAV 直连上传至用户配置的 `/audio/transcriptions` 端点（移动端额外受 `Allow cloud fallback on mobile` 开关约束）；保持 `system` 时仅在宿主暴露原生 `SpeechRecognition` 时调用。
- **选区/笔记语音问答与听写后润色**（`ask-ai-about-note`、`enableLlmPolish`，默认关闭）：仅在用户显式开启后，才会将当前选区（或上限 `24,000` 字符的当前笔记）与问题，或待 4 层防幻觉润色的单句转写文本直连发往用户配置的模型端点（支持本地回环 Ollama / LM Studio 免密运行）。
- **朗读选区/笔记与播控**（`read-aloud` 等）：默认 `system` 调用宿主 `window.speechSynthesis`（强制锁定 `manual` 打断）；桌面可选 `vits-wasm` **100% 本地离线合成**（配合本地 `Silero VAD` 原生 AEC3 语音打断，音频绝不外传）；桌面可选 `kokoro-daemon` 仅经原生 `fetch` 访问本机回环 `voice-daemon`（零远程外联，`< 1 s` 离线自动回退至 `vits-wasm` 或 `system`）；仅在用户显式选用 `openai-compat` 或 `mimo` 时才会将清洗后的句子直连发往用户配置的 TTS 端点。

### 3. Explicit External Model Downloads (Desktop, Shipped in M1/M2) / 桌面离线模型显式下载与隔离（M1/M2 已上线）

- Model weights and WASM runtime files are downloaded **only when explicitly triggered by the user** via **Settings → Offline speech models** (never silently on startup):
  - Speech models (`csukuangfj/vad`, `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`, and optional `csukuangfj/sherpa-onnx-vits-zh-ll`) are fetched over HTTPS from allowlisted model hosts: `https://huggingface.co` (including `*.huggingface.co` / `*.hf.co` LFS CDN redirects) or user-selected mirror `https://hf-mirror.com` (`*.hf-mirror.com`).
  - The `sherpa-onnx@2.0.2` WASM runtime tarball (`Apache-2.0`) is fetched over HTTPS from allowlisted npm registries: `https://registry.npmjs.org` with automatic failover to `https://registry.npmmirror.com` / `https://cdn.npmmirror.com`.
- Every downloaded archive and extracted file is verified against **pinned SHA256 digests**, hop-by-hop redirect host allowlists (blocking HTTP downgrades and unapproved hosts), and strict USTAR tar path-traversal / link rejection before activation.
- All verified assets (`245.3 MB` dictation stack; optional `116.1 MB` VITS bundle) are stored **strictly outside your Obsidian Vault** (`~/.cache/voice-mode/models/` on macOS, `$XDG_CACHE_HOME/voice-mode/models/` or `~/.cache/voice-mode/models/` on Linux, `%LOCALAPPDATA%\voice-mode\models\` on Windows, or a canonicalized user-specified external directory rejected if inside the Vault) so large binaries never pollute Obsidian Sync, iCloud, or Git repositories.

### 4. Optional BYOK Cloud Endpoints (BYOK TTS, STT & LLM Q&A/Polish Shipped in M2–M3) / 可选自带密钥（BYOK）云端能力

- Outbound requests to cloud TTS, STT, or LLM providers occur **only if you explicitly configure a provider and invoke a BYOK command** (and on mobile only when `Allow cloud fallback on mobile` is enabled).
- Requests are sent directly from your Obsidian client to the endpoint you configured (using native `fetch` with `redirect: 'error'`, or desktop zero-redirect Node HTTPS / mobile `requestUrl` when `Origin: app://obsidian.md` is blocked by provider CORS); this project operates **no relay server** and never sees your notes, audio, or API keys.

---

## Credential Storage & Outbound Hardening / 凭证隔离与出站安全红线

1. **Obsidian `SecretStorage` Only (`minAppVersion: 1.11.4`)**:
   - All API keys are stored exclusively via Obsidian's built-in `app.secretStorage` API.
   - **API keys are NEVER written to `.obsidian/plugins/voice-mode/data.json`**, preventing accidental leaks via Obsidian Sync, iCloud, or Vault Git repositories.
   - On older Obsidian versions lacking `SecretStorage`, plaintext fallback storage is refused.
2. **Per-Preset & Per-Engine Key Isolation**: Credentials are scoped per provider preset and engine (`llmApiKeySecretIds`, `ttsApiKeySecretIds` including `openai-compat:<presetId>` vs `mimo` `api-key`, `asrApiKeySecretId`, and loopback `daemonTokenSecretId`) so switching providers never leaks one provider's token to another endpoint.
3. **No Cross-Origin Redirects (`redirect: 'error'`)**: Outbound requests forbid HTTP redirects (301/302/303/307/308) pre-hop on both primary `fetch` and the desktop Node HTTPS CORS fallback. On mobile WebViews where CORS triggers Obsidian's official `requestUrl` fallback, `requestUrl` does not expose a pre-hop redirect-disable flag (any 3xx status returned is rejected).
4. **No Embedded URL Credentials**: Custom `baseUrl` values containing `user:pass@` are rejected during validation.
5. **Redact-Before-Truncate**: Error responses and diagnostic messages pass through `@voice-mode/core` secret redaction before truncation or display so partial bearer/API tokens cannot leak into logs or notices.

---

## Third-Party Model & License Isolation / 第三方模型与许可证隔离

- This repository's source code is licensed under the **MIT License**.
- **No third-party model weights, WASM binaries, or phoneme archives are bundled in this repository or its GitHub Releases.**
- In particular, `espeak-ng-data` (required by Kokoro TTS, upstream **GPL-3.0**) and `SenseVoice` model weights (**FunAudioLLM** license) are strictly excluded from the MIT repository and release artifacts; any runtime-downloaded assets are fetched independently by the user with explicit upstream license attribution.
