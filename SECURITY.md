# Security Policy / 安全策略

## Supported Versions / 支持的版本

Only the latest release receives security fixes. The repository is currently at **`0.1.0` (Alpha architecture baseline)**; breaking security or storage adjustments may occur prior to `1.0.0`.

仅最新版本接收安全修复。当前仓库处于 **`0.1.0`（Alpha 架构初始化阶段）**，在 `1.0.0` 正式版前可能发生安全边界或配置结构调整。

## Reporting a Vulnerability / 报告漏洞

Please **do not** disclose security vulnerabilities in public GitHub issues, pull requests, or discussions. Use GitHub's private vulnerability reporting channel (**Security → Report a vulnerability** on `qishuilalala/obsidian-voice-mode`). We will acknowledge receipt, assess severity, and coordinate disclosure once a fix is released.

请**不要**在公开 Issue、PR 或讨论区披露安全漏洞细节。请使用本仓库的私密漏洞报告入口（**Security → Report a vulnerability**）。我们会尽快确认并在发布修复后于 `CHANGELOG.md` 同步说明。

---

## Privacy & Data Flow Boundaries / 隐私与数据流边界

### 1. Zero Telemetry / 零遥测承诺

- This plugin sends **zero telemetry, zero analytics, zero crash reports, and zero usage tracking**.
- No network requests are made on plugin startup.

本插件**零遥测、零埋点、零崩溃上报**，启动时不会发起任何静默外联请求。

### 2. Current `0.1.0` Skeleton Preview Commands / 当前 `0.1.0` 骨架预览命令的数据流

- **Read selection or note aloud** (`read-aloud`): currently runs a zero-config preview using the host's native `window.speechSynthesis` API (uses local OS voices or whatever voice provider your OS/browser is configured with).
- **Toggle voice dictation** (`toggle-dictation`): until M1 offline WASM ships, this command falls back to the host browser/WebView's native `SpeechRecognition` / `webkitSpeechRecognition` API **only if exposed by the host**. On standard desktop Obsidian Electron builds without a bundled Google Speech API key, this fallback is unavailable; on browsers or mobile WebViews that do provide native `SpeechRecognition`, microphone audio is sent by the host runtime to that browser or OS speech service provider.

当前 `0.1.0` 骨架已注册命令的数据流说明：

- **朗读选区/笔记**（`read-aloud`）：当前提供零配置预览，调用宿主原生的 `window.speechSynthesis`（使用本机或系统已配置的语音引擎）。
- **切换听写**（`toggle-dictation`）：在 M1 本地离线 WASM 落地前，仅在宿主浏览器/WebView 提供原生 `SpeechRecognition` 时作为占位兜底。未内置 Google Speech Key 的桌面 Obsidian Electron 端该能力不可用；在支持原生 `SpeechRecognition` 的浏览器或移动端 WebView 上，语音会被宿主发送至对应的浏览器或系统语音服务商。

### 3. Local Offline Mode (Desktop, Planned M1/M2 — Not Yet Shipped) / 桌面本地离线模式（计划中）

- Once implemented in M1/M2, desktop offline dictation (`Silero VAD` + `SenseVoice int8` via Web Worker WASM) will run **100% locally** on your machine. Raw microphone audio and transcripts will never leave your device in offline mode.
- Model files will be downloaded **only when explicitly triggered by the user** from disclosed HTTPS sources (default HuggingFace `https://huggingface.co` or optional mirror `https://hf-mirror.com`), verified against pinned **SHA256** digests, and checked against path traversal before writing.
- Model files will be stored **outside your Obsidian Vault** (`~/.cache/voice-mode/models/` on macOS/Linux, `%LOCALAPPDATA%\voice-mode\models\` on Windows) so 200+ MB binaries never pollute Obsidian Sync, iCloud, or Git repositories.

桌面端离线模式（计划于 M1/M2 落地，当前未上线）的语音采集与推理将**完全在本地执行**，音频与转写文本不上传任何服务器；模型仅在用户显式点击后从公开披露的 HTTPS 源下载、按固定 SHA256 校验，并保存在 **Vault 之外**的缓存目录（macOS/Linux `~/.cache/voice-mode/models/`、Windows `%LOCALAPPDATA%\voice-mode\models\`），不污染 Obsidian Sync 或 Git。

### 4. Optional BYOK Cloud Endpoints (Planned M3 — Not Yet Shipped) / 可选自带密钥（BYOK）云端能力（计划中）

- Outbound requests to LLM or cloud speech providers occur **only if you explicitly configure a provider and invoke a BYOK command** (e.g., voice Q&A, optional transcript polish, or cloud STT/TTS, including on mobile where heavy WASM models are disabled).
- Requests are sent directly from your Obsidian client to the endpoint you configured (`openai-compat` or `anthropic-messages`); this project operates **no relay server** and never sees your notes, audio, or API keys.

仅当用户显式配置 BYOK 服务并主动触发相应命令（或移动端降级使用云端能力）时，文本/音频才会直连发往用户指定的服务商端点；本项目不经过任何开发者中转服务器。

---

## Credential Storage & Outbound Hardening / 凭证隔离与出站安全红线

1. **Obsidian `SecretStorage` Only (`minAppVersion: 1.11.4`)**:
   - All API keys are stored exclusively via Obsidian's built-in `app.secretStorage` API.
   - **API keys are NEVER written to `.obsidian/plugins/voice-mode/data.json`**, preventing accidental leaks via Obsidian Sync, iCloud, or Vault Git repositories.
   - On older Obsidian versions lacking `SecretStorage`, plaintext fallback storage is refused.
2. **Per-Preset Key Isolation**: Credentials are scoped per provider preset so switching providers never leaks one provider's token to another endpoint.
3. **No Cross-Origin Redirects (`redirect: 'error'`)**: Authenticated outbound requests forbid HTTP redirects (301/302/307/308) to prevent leaking `Authorization` or `x-api-key` headers to unintended hosts.
4. **No Embedded URL Credentials**: Custom `baseUrl` values containing `user:pass@` are rejected during validation.
5. **Redact-Before-Truncate**: Error responses and diagnostic messages pass through `@voice-mode/core` secret redaction before truncation or display so partial bearer/API tokens cannot leak into logs or notices.

---

## Third-Party Model & License Isolation / 第三方模型与许可证隔离

- This repository's source code is licensed under the **MIT License**.
- **No third-party model weights, WASM binaries, or phoneme archives are bundled in this repository or its GitHub Releases.**
- In particular, `espeak-ng-data` (required by Kokoro TTS, upstream **GPL-3.0**) and `SenseVoice` model weights (**FunAudioLLM** license) are strictly excluded from the MIT repository and release artifacts; any runtime-downloaded assets are fetched independently by the user with explicit upstream license attribution.
