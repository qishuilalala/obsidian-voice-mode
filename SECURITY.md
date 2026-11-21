# Security Policy / 安全策略

## Supported Versions / 支持的版本

Only the latest release receives security fixes. The repository is currently at **`0.1.0` (Alpha · M0 & M1 shipped on `main`)**; breaking security or storage adjustments may occur prior to `1.0.0`.

仅最新版本接收安全修复。当前仓库处于 **`0.1.0`（Alpha · `main` 已落地 M0 与 M1 桌面离线听写）**，在 `1.0.0` 正式版前可能发生安全边界或配置结构调整。

## Reporting a Vulnerability / 报告漏洞

Please **do not** disclose security vulnerabilities in public GitHub issues, pull requests, or discussions. Use GitHub's private vulnerability reporting channel (**Security → Report a vulnerability** on `qishuilalala/obsidian-voice-mode`). We will acknowledge receipt, assess severity, and coordinate disclosure once a fix is released.

请**不要**在公开 Issue、PR 或讨论区披露安全漏洞细节。请使用本仓库的私密漏洞报告入口（**Security → Report a vulnerability**）。我们会尽快确认并在发布修复后于 `CHANGELOG.md` 同步说明。

---

## Privacy & Data Flow Boundaries / 隐私与数据流边界

### 1. Zero Telemetry / 零遥测承诺

- This plugin sends **zero telemetry, zero analytics, zero crash reports, and zero usage tracking**.
- No network requests are made on plugin startup.

本插件**零遥测、零埋点、零崩溃上报**，启动时不会发起任何静默外联请求。

### 2. Shipped Commands & Data Flows (`main` / M1 Baseline) / 当前已上线命令的数据流

- **Toggle voice dictation / Dictate single utterance** (`toggle-dictation`, `dictate-single-utterance`):
  - **Desktop offline mode (`SenseVoice WASM`, shipped in M1)**: Runs **100% locally** inside an isolated Web Worker (`Silero VAD` + `SenseVoice int8` via `sherpa-onnx@2.0.2` WASM). Raw microphone audio and transcripts **never leave your device**, and zero outbound network calls occur during dictation.
  - **Host browser fallback (`system`)**: When recognition engine is left on `System speech recognition`, the command uses the host runtime's native `SpeechRecognition` / `webkitSpeechRecognition` API **only if exposed by the host**. On standard desktop Obsidian Electron builds without a bundled Google Speech API key, browser recognition is unavailable (the plugin prompts you to switch to `SenseVoice WASM`); on browsers or mobile WebViews that do provide native `SpeechRecognition`, microphone audio is sent by the host runtime to that browser or OS speech service provider.
- **Read selection or note aloud** (`read-aloud`): currently runs a zero-config preview using the host's native `window.speechSynthesis` API (uses local OS voices or whatever voice provider your OS/browser is configured with; optional local `vits-wasm` and BYOK TTS are planned for M2).

当前已上线命令的数据流说明：

- **切换听写 / 单句听写**（`toggle-dictation`、`dictate-single-utterance`）：
  - **桌面本地离线模式（`SenseVoice WASM`，M1 已上线）**：在隔离 Web Worker 内通过 `sherpa-onnx@2.0.2` WASM **100% 本地运行** `Silero VAD` + `SenseVoice int8`，麦克风音频与转写文本绝不离开本机，听写全程零网络请求。
  - **系统/浏览器语音兜底（`system`）**：当识别引擎设为系统语音时，仅在宿主运行环境暴露原生 `SpeechRecognition` 时调用。未内置 Google Speech Key 的桌面 Obsidian Electron 端该接口不可用（插件会提示切换至 `SenseVoice WASM` 离线引擎）；在支持原生 `SpeechRecognition` 的浏览器或移动端 WebView 上，语音由宿主发送至对应的浏览器/系统语音服务商。
- **朗读选区/笔记**（`read-aloud`）：当前调用宿主原生 `window.speechSynthesis`（M2 计划扩展桌面可选离线 `vits-wasm` 与 BYOK 云端朗读）。

### 3. Explicit External Model Downloads (Desktop, Shipped in M1) / 桌面离线模型显式下载与隔离（M1 已上线）

- Model weights and WASM runtime files are downloaded **only when explicitly triggered by the user** via **Settings → Download or verify models** (never silently on startup):
  - Speech models (`csukuangfj/vad`, `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17`) are fetched over HTTPS from allowlisted model hosts: `https://huggingface.co` (including `*.huggingface.co` / `*.hf.co` LFS CDN redirects) or user-selected mirror `https://hf-mirror.com` (`*.hf-mirror.com`).
  - The `sherpa-onnx@2.0.2` WASM runtime tarball (`Apache-2.0`) is fetched over HTTPS from allowlisted npm registries: `https://registry.npmjs.org` with automatic failover to `https://registry.npmmirror.com` / `https://cdn.npmmirror.com`.
- Every downloaded archive and extracted file is verified against **pinned SHA256 digests**, hop-by-hop redirect host allowlists (blocking HTTP downgrades and unapproved hosts), and strict USTAR tar path-traversal / link rejection before activation.
- All `245.3 MB` of verified assets are stored **strictly outside your Obsidian Vault** (`~/.cache/voice-mode/models/` on macOS, `$XDG_CACHE_HOME/voice-mode/models/` or `~/.cache/voice-mode/models/` on Linux, `%LOCALAPPDATA%\voice-mode\models\` on Windows, or a canonicalized user-specified external directory rejected if inside the Vault) so large binaries never pollute Obsidian Sync, iCloud, or Git repositories.

桌面端离线模型与 WASM 运行时**仅在用户在设置页显式点击下载后**拉取（绝不静默下载）：模型权重仅走白名单 HTTPS 源（`https://huggingface.co` 或可选镜像 `https://hf-mirror.com` 及其受控 CDN 重定向），`sherpa-onnx@2.0.2` WASM 运行时仅走 `https://registry.npmjs.org` / `https://registry.npmmirror.com`（`cdn.npmmirror.com`），逐跳校验重定向域名白名单、拒绝 tar 路径穿越与软硬链接，并按固定 **SHA256** 逐文件校验后落盘于 **Vault 之外**的缓存目录（支持一键打开目录与一键清理），绝不污染 Obsidian Sync、iCloud 或 Git。

### 4. Optional BYOK Cloud Endpoints (Planned M2/M3 — Not Yet Shipped) / 可选自带密钥（BYOK）云端能力（计划中）

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
