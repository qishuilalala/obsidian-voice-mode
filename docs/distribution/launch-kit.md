# Voice Mode `0.1.0` — Ready-to-Publish Launch Kit（首发提审与全渠道文案包）

> **发布状态守卫（“先不发”边界 · 2026-11-22）**：本文件汇总 `qishuilalala/obsidian-voice-mode`（`0.1.0`）的官方社区目录提审 PR 正文、GitHub Release 说明及海内外七大渠道首发定稿。所有性能与体积数据均引自本机真机/模拟器实测记录（见 [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md)），**当前仅作本地封版备审，尚未推送公开 Release Tag、尚未向 `obsidianmd/obsidian-releases` 发起 PR、尚未在任何外部平台发帖**。
>
> **随附演示视频资产（已忽略入库，本地生成于 `release-assets/`）**：
> - 横屏 16:9（`1920x1080` · `15.0s` · H.264 + AAC 有声）：`release-assets/demo-16x9-1080p.mp4`（适用于 GitHub README、Reddit、YouTube、B 站、少数派）
> - 竖屏 9:16（`1080x1920` · `15.0s` · H.264 + AAC 有声）：`release-assets/demo-9x16-vertical.mp4`（适用于小红书、Shorts）

---

## 1. `obsidianmd/obsidian-releases` PR Body（官方插件目录提审正文）

**Target repository**: `obsidianmd/obsidian-releases`  
**Target file**: `community-plugins.json` (append at end of array)

### `community-plugins.json` Entry

```json
  {
    "id": "voice-mode",
    "name": "Voice Mode",
    "author": "qishuilalala",
    "description": "Offline-first bilingual voice dictation, Markdown-aware read-aloud, and optional BYOK voice Q&A.",
    "repo": "qishuilalala/obsidian-voice-mode"
  }
```

### Pull Request Title

`Add plugin: Voice Mode`

### Pull Request Description

```markdown
# Add plugin: Voice Mode

- **Plugin ID**: `voice-mode`
- **Name**: `Voice Mode`
- **Author**: `qishuilalala`
- **Repository**: https://github.com/qishuilalala/obsidian-voice-mode
- **Initial Release Tag**: `0.1.0` (bare semver without leading `v`, matching `manifest.json` and `versions.json`)
- **Minimum Obsidian Version**: `1.11.4` (aligned with native `app.secretStorage` / `SecretComponent`)
- **Mobile Support**: `isDesktopOnly: false`

## Summary

Voice Mode adds an offline-first bilingual (Mandarin + English) voice dictation and Markdown-aware read-aloud layer to Obsidian, with optional bring-your-own-key (BYOK) speech and note Q&A endpoints:

1. **Desktop offline dictation (`SenseVoice WASM`)**: Runs `Silero VAD` + `SenseVoice int8` (`sherpa-onnx@2.0.2`) inside an isolated Web Worker with zero external Python/WebSocket server required by default (`toggle`, `single`, and `push-to-talk` modes), paired with a single-pass custom vocabulary replacement dictionary and cursor-accurate insertion into CodeMirror 6 and focused third-party sidebars (e.g., Copilot). Optional `Local voice daemon` (`127.0.0.1:18790`) is also supported on desktop with `< 1s` automatic fallback.
2. **Markdown & pipe-table aware read-aloud**: Strips YAML frontmatter, fenced code blocks, math blocks, bare URLs, callout markers, and pipe tables (`| --- |`), paired with floating subtitle size/width controls, `Pause` / `Next` / `Stop` actions, automatic stop on note switch, and native Chromium AEC3 hands-free voice barge-in on desktop binary audio (automatically locking `manual` stop on OS `speechSynthesis`).
3. **Graceful mobile host degradation (`Platform.isMobile`)**: Disables 200 MB+ local WASM downloads and Worker allocation on mobile to respect iOS `WKWebView` Jetsam (~500 MB) and Android WebView memory ceilings. Mobile hosts expose native `speechSynthesis` (where supported by the OS WebView, such as iOS `WKWebView`) and zero-WASM BYOK speech/Q&A gated behind an explicit `Allow cloud fallback on mobile` toggle (`default: false`).

## Privacy, Security & Asset Disclosures

- **Zero telemetry & zero startup network calls**: Verified in clean-room startup checks; no analytics or background requests occur on load.
- **Explicit out-of-vault model downloads (Desktop only)**: No model weights, WASM binaries, or GPL-3.0 `espeak-ng-data` files are bundled in git or GitHub Release assets (`main.js` is `284.1 KB`, well below the `5 MB` Obsidian Sync budget). Desktop models (`245.3 MB` dictation stack; optional `116.1 MB` VITS stack) are downloaded only after explicit user action in Settings from allowlisted HTTPS hosts (`huggingface.co` / `hf-mirror.com` and `registry.npmjs.org` / `registry.npmmirror.com`), verified against pinned SHA256 digests, and stored outside the vault (`~/.cache/voice-mode/models/` on macOS/Linux, `%LOCALAPPDATA%\voice-mode\models\` on Windows).
- **Native credential storage (`SecretStorage`)**: All optional BYOK credentials (LLM, ASR, TTS, local daemon token) are stored exclusively in `app.secretStorage` via `SecretComponent` and referenced only by opaque Secret IDs—never written to `data.json`. Outbound authenticated requests enforce `redirect: "error"` and redact secrets prior to error truncation.
- **Static analysis & UI guidelines**: Passes `eslint-plugin-obsidianmd@0.6.0` (`--max-warnings 0`), uses Sentence case across all settings/commands, registers all workspace/DOM listeners via `registerEvent` / `registerDomEvent`, and contains zero `innerHTML` / `outerHTML` / `eval` calls.

## Checklist

- [x] The `id` in `manifest.json` (`voice-mode`) matches the `id` in `community-plugins.json` and does not contain `obsidian`.
- [x] The `name` in `manifest.json` (`Voice Mode`) matches `community-plugins.json` and does not start/end with or contain `Obsidian`.
- [x] The `description` ends with terminal punctuation, is concise, and does not repeat the plugin name or mention `Obsidian`.
- [x] GitHub Release `0.1.0` uses a bare semver tag (no `v` prefix) and attaches **only** `main.js`, `manifest.json`, and `styles.css`.
- [x] Root `README.md` is written in English and clearly documents usage, external network domains, SHA256 model storage outside the vault, and privacy boundaries.
- [x] `LICENSE` (MIT) is present in the repository root.
- [x] Tested on Desktop (`Obsidian 1.15.1` on macOS) and verified on Mobile (`Android 15 AVD Emulator (Obsidian 1.15.1 APK, System WebView 124.0)` + `Xcode iOS 27.0 Simulator WKWebView harness`).
```

---

## 2. GitHub Release `0.1.0` Notes（GitHub Release 正文）

**Tag**: `0.1.0` (no `v` prefix)  
**Title**: `0.1.0`  
**Attached Assets (strictly 3 files)**: `main.js`, `manifest.json`, `styles.css`

```markdown
Initial public `0.1.0` release of **Voice Mode** (`id: voice-mode`, `minAppVersion: 1.11.4`, `isDesktopOnly: false`)—an offline-first bilingual voice dictation, spoken Markdown read-aloud, and optional BYOK voice Q&A plugin for Obsidian.

### Highlights

- **100% Offline Desktop Dictation (`SenseVoice WASM`)**: Runs `Silero VAD` + `SenseVoice int8` (`sherpa-onnx@2.0.2`) inside an isolated `MEMFS` Web Worker (`485 ms` cold model load, `RTF = 0.215` over 15-minute continuous Mandarin/English speech, `640 ms` pre-roll buffer, `toggle` / `single` / `push-to-talk` modes, configurable idle Worker unload).
- **Vault-External SHA256 Model Manager**: User-triggered downloads (`245.3 MB` dictation stack; optional `116.1 MB` `vits-zh-ll` 5-speaker Mandarin TTS) with `.part` HTTP Range resume, mirror failover (`huggingface.co` / `hf-mirror.com` + `registry.npmjs.org` / `registry.npmmirror.com`), and strict out-of-vault storage (`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`) so Obsidian Sync stays clean (`main.js` = `284.1 KB`).
- **Custom Vocabulary Dictionary & Universal Focus Injection**: Single-pass multi-alias replacement editor (`12 KB` UTF-8 budget, supporting domain terms and `[[wikilinks]]`) and `FocusTextInjector` supporting CodeMirror 6, core Search, Shadow DOM `<textarea>`, and Lexical/ProseMirror sidebars (`Copilot 4.0.20`) via zero-clipboard synthetic `ClipboardEvent("paste")`.
- **Markdown & Table-Aware Read-Aloud + Native AEC3 Barge-In**: Strips YAML frontmatter, code blocks, math blocks, bare URLs, callouts, and pipe tables; includes floating subtitle size/width presets (`15.91:1` light / `12.19:1` dark WCAG contrast), `Pause`/`Resume`/`Next`/`Stop` controls (`< 100 ms` stop), note-switch auto-stop, optional local `vits-wasm` / `kokoro-daemon` (`< 1s` fallback) / BYOK `openai-compat` & `mimo` TTS, and hands-free native AEC3 barge-in (`180 s` speaker soak with `0` self-interrupts, `66–370 ms` voice interrupt).
- **Optional Zero-Dependency BYOK Voice Q&A, 4-Guard Polish & Cloud ASR**: `< 400`-line dual-protocol router (OpenAI-compatible + Anthropic Messages with automatic `Origin: app://obsidian.md` CORS fallback), `Ask AI about selection or note` streaming modal, optional 4-layer anti-hallucination post-dictation polish, zero-WASM `CloudDictationSession`, and `app.secretStorage` credential isolation (`0` plaintext keys in `data.json`).
- **Mobile Host Degradation (`Platform.isMobile`)**: Blocks 200 MB+ local WASM models on mobile to prevent WebView OOM/Jetsam crashes, gating remote BYOK calls behind `Allow cloud fallback on mobile` (`default: false`). Note: iOS `WKWebView` provides native `speechSynthesis` out of the box, whereas Android System WebView omits `window.speechSynthesis` and uses opt-in BYOK TTS (`openai-compat` / `mimo`) for audio read-aloud.

### Installation (Manual / BRAT before Community Directory approval)

1. **Manual**: Copy `main.js`, `manifest.json`, and `styles.css` from this release into `<Vault>/.obsidian/plugins/voice-mode/`, reload Obsidian, and enable **Voice Mode** under **Settings → Community plugins**.
2. **BRAT**: Open **BRAT → Add Beta plugin**, enter `qishuilalala/obsidian-voice-mode`, and enable **Voice Mode**.
```

---

## 3. Reddit `r/ObsidianMD` Post

**Title**:  
`I built an open-source, offline-first Voice Mode for Obsidian — bilingual dictation, pipe-table-aware read-aloud, and zero-coupling Copilot sidebar input (no external server)`

**Body**:

```markdown
Hi r/ObsidianMD!

Whenever I tried adding voice dictation or read-aloud to my Obsidian workflow, I kept running into three friction points:
1. Plugins that require installing and running a separate Python/WebSocket server in a terminal first;
2. Cloud-only tools where private journal notes and mic audio have to leave the machine;
3. TTS readers that read Markdown pipe tables (`| --- | --- |`), YAML frontmatter, and code fences out loud character by character.

So I built **Voice Mode** (`voice-mode`, MIT licensed) — a local-first voice I/O layer designed to work alongside your existing setup (including plugins like Copilot) rather than replacing them.

*(Attach `demo-16x9-1080p.mp4` here — 15s demo with real audio)*

### What it does in `0.1.0`

- **Desktop 100% offline dictation (zero external server)**: Runs `Silero VAD` + `SenseVoice int8` (`sherpa-onnx@2.0.2`) inside an isolated Web Worker. On an M2 Max (`Obsidian 1.15.1`), cold model load takes `485 ms` with an average real-time factor (`RTF`) of `0.215` across mixed English + Mandarin dictation (`toggle`, `single` utterance, and `push-to-talk` modes).
- **Personal vocabulary replacement dictionary**: Map homophones or spoken shorthand directly to exact proper nouns, acronyms, or `[[wikilinks]]` in a single pass before text hits the editor.
- **Works inside CodeMirror 6 AND third-party sidebars**: Inserts at your active Markdown cursor, or—if your cursor is focused inside a sidebar like **Obsidian Copilot** (`Lexical` `contenteditable`)—dispatches an in-memory synthetic paste event without touching your OS clipboard, keeping Undo/Redo intact.
- **Markdown & pipe-table aware read-aloud**: Strips YAML frontmatter, fenced code, `$$` math blocks, bare URLs, callout syntax, and pipe tables (skip or short spoken placeholder). Includes a floating caption bar (`small`/`medium`/`large` font, `narrow`/`medium`/`wide` width, `Pause`/`Next`/`Stop`, auto-stop on note switch) plus native AEC3 hands-free voice barge-in when using binary TTS engines (`vits-wasm` or BYOK TTS).
- **Vault-clean model storage & `SecretStorage` privacy**:
  - `main.js` is `284 KB` (nothing heavy inside `.obsidian/plugins/`).
  - Optional desktop offline models (`245.3 MB` dictation stack; `116.1 MB` local VITS TTS) download **only when you click download**, verify against pinned SHA256 hashes, and live **outside your Vault** (`~/.cache/voice-mode/models/` or `%LOCALAPPDATA%\voice-mode\models\`) so Obsidian Sync / iCloud / Git are never polluted.
  - Optional BYOK endpoints (OpenAI-compatible STT/TTS/LLM, Anthropic, Xiaomi MiMo, local Ollama/LM Studio) store credentials exclusively in Obsidian's native `SecretStorage` (`minAppVersion: 1.11.4`), never in `data.json`.

### Honest limitations & mobile behavior (`isDesktopOnly: false`)

- **Mobile memory & WebView differences**: To stay well under iOS `WKWebView`'s ~500 MB Jetsam ceiling, 200 MB+ local WASM models are disabled on mobile (`Allow cloud fallback on mobile` defaults to `false`). iOS `WKWebView` supports native system `speechSynthesis` out of the box, while Android System WebView does not expose `window.speechSynthesis`—so Android read-aloud and mobile dictation use opt-in BYOK endpoints.
- **Offline VITS speed**: Local desktop `vits-zh-ll` runs single-threaded in WASM at `RTF ~1.27` (slightly slower than real-time on long paragraphs), so OS system speech and BYOK TTS remain the snappiest zero-setup defaults while power users can pair the optional local [`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon) for native `Kokoro 103` voices (`< 1s` auto-fallback).

### Links

- **GitHub (MIT)**: https://github.com/qishuilalala/obsidian-voice-mode
- **Install via BRAT**: `qishuilalala/obsidian-voice-mode` (or grab `main.js`, `manifest.json`, `styles.css` from Release `0.1.0`)

Feedback on audio hardware edge cases, Linux Flatpak cache paths, or sidebar compatibility is super welcome!
```

---

## 4. Hacker News (`Show HN`)

**Title**:  
`Show HN: Obsidian Voice Mode – Offline WASM speech pipeline, zero-dep BYOK router, SecretStorage`

**Body**:

```markdown
Hi HN,

I built Voice Mode (`qishuilalala/obsidian-voice-mode`, MIT), an offline-first voice dictation and Markdown-aware read-aloud plugin for Obsidian structured as three host-agnostic TypeScript packages (`@voice-mode/core`, `@voice-mode/browser`, `@voice-mode/obsidian-plugin`).

Repo: https://github.com/qishuilalala/obsidian-voice-mode

A few engineering constraints inside Electron (`43.8.9` / Chromium `150`) and mobile WebViews shaped the design:

1. **Running `sherpa-onnx@2.0.2` WASM inside Electron without hitting Node fs collisions or Sync bloat**:
   - In Electron renderer Workers where Node integration may be probed, Emscripten glue tries to route file reads to host `fs`. We patch the Worker bootstrap into an isolated `MEMFS` environment, transfer verified model `ArrayBuffer`s zero-copy, and `FS.unlink` staging buffers immediately after recognizer initialization.
   - Measured in `Obsidian 1.15.1` on Apple M2 Max over a 15-minute (60-utterance) continuous session: `Silero VAD` loads in `30 ms`, `SenseVoice int8` loads in `485 ms`, average `RTF = 0.2148`, WASM linear memory stays flat at `512 MB` (`+348.7 MB` steady renderer RSS delta), and `worker.terminate()` reclaims the heap cleanly after configurable idle timeout.
   - We also reproduced `k2-fsa/sherpa-onnx#3960` (`kokoro-int8` WASM emitting `NaN` silence in `2.0.2`) and disabled WASM Kokoro rather than shipping broken audio, deferring Kokoro 103 voices + GPL-3.0 `espeak-ng-data` runtime isolation to an optional loopback `voice-daemon` (`DaemonClient` probes `/v1/health` with `< 1s` fallback).

2. **Echo-safe hands-free barge-in (`AecBargeInMonitor`)**:
   - Chromium's native AEC3 cancels speaker playback only when audio flows through Chromium's render mixer (`HTMLAudioElement`, measured `+8.99 dB` residual suppression with `autoGainControl: false`—enabling AGC actually amplified echo residual from `0.0123` to `0.0221`).
   - OS `window.speechSynthesis` bypasses Chromium's mixer via an OS daemon, leaving full speaker echo on the mic. Accordingly, hands-free barge-in automatically locks to `manual` whenever `system` TTS is active or native AEC is absent, and uses a separate `1.8 MB` `Silero VAD` Worker when active (`180 s` speaker soak with `0` false self-interrupts, `66–370 ms` voice interrupt).

3. **Zero-dependency `< 400`-line BYOK router & credential hygiene**:
   - `@voice-mode/core` has zero npm runtime dependencies (`main.js` bundle is `284.13 KB`, `166` unit tests). It includes a `396`-line dual-protocol (`openai-compat` + `anthropic-messages`) streaming SSE router, pure-`Uint8Array` RFC 7578 multipart WAV encoder, magic-byte audio MIME sniffer, and 4-layer anti-hallucination transcript polish guards.
   - In `Origin: app://obsidian.md`, providers that block renderer CORS (e.g., OpenAI, Volcengine Ark, default local Ollama without `OLLAMA_ORIGINS`) automatically fall back to main-process `requestUrl` / zero-redirect HTTP streams, while API keys live strictly in Obsidian `app.secretStorage` (`0` secrets in `data.json`, redact-before-truncate on all error bodies).

4. **Mobile WebView boundaries (`isDesktopOnly: false`)**:
   - Under `Platform.isMobile`, local WASM models are hard-disabled to avoid iOS `WKWebView` (~500 MB Jetsam) kills. Verification on `Android 15 AVD Emulator (Obsidian 1.15.1 APK, System WebView 124.0)` and `Xcode iOS 27.0 Simulator WKWebView harness` confirmed another subtle split: iOS `WKWebView` ships `window.speechSynthesis` (`68` voices), whereas Android System WebView omits `window.speechSynthesis` (cleanly prompting BYOK TTS while exposing `webkitSpeechRecognition` and `HTMLAudioElement`)—so mobile cloud fallback stays opt-in (`default: false`) and fails closed with clear notices.

Happy to answer questions or hear feedback on the architecture!
```

---

## 5. Obsidian 中文论坛 / PKMer 社群首发帖

**标题**：  
`【开源发布】Voice Mode 0.1.0：免部署外部服务的 Obsidian 离线中英语音听写、Markdown 表格降噪朗读与 Copilot 侧栏输入插件`

**正文**：

```markdown
大家好！分享一个我打磨并完成真机闭环测试的开源 Obsidian 语音插件 —— **Voice Mode**（插件 ID：`voice-mode`，MIT 协议开源）。

在做这个插件之前，我在 Obsidian 里用语音一直遇到三个痛点：
1. **安装门槛高**：不少离线语音方案要求先装 Python 环境、手动跑本地 WebSocket 服务，换台电脑就断链；
2. **朗读噪音大**：普通 TTS 遇到 YAML Frontmatter、代码块、裸链接和 `| --- |` Markdown 管道表格会逐字硬念“竖线减号减号”；
3. **与现有 AI 插件割裂**：很多时候我们只想对着已经装好的 **Copilot** 侧栏口述提问，而不是再换一套封闭聊天框。

### 核心能力与真机实测指标（`0.1.0`）

1. **桌面端 100% 本地离线中英混说听写（默认零外置服务）**
   - 内置隔离 `MEMFS` Web Worker 运行 `Silero VAD` + `SenseVoice int8`（`sherpa-onnx@2.0.2`），支持 **连续切换（Toggle）/ 单句自动停（Single）/ 按住说话（Push-to-Talk）** 与 `640 ms` 预卷防吞字。
   - **实测数据**（Apple M2 Max · Obsidian `1.15.1`）：`SenseVoice int8` 冷加载仅 **`485 ms`**，连续 15 分钟中英混说平均实时率 **`RTF = 0.215`**，4.8 秒单句定稿延迟 `1.25 秒`，空闲自动卸载释放内存。
   - **国内直连友好 + Vault 零污染**：插件本体 `main.js` 仅 **`284 KB`**；离线模型包（听写栈 `245.3 MB`，可选本地中文 `vits-zh-ll` 朗读包 `116.1 MB`）仅在你手动点击下载时拉取，内置 **`hf-mirror.com` + `npmmirror`** 自动切换与 `.part` 断点续传，固定 SHA256 校验，统一存放在 **Vault 之外**（`~/.cache/voice-mode/models/` 或 `%LOCALAPPDATA%\voice-mode\models\`），绝不污染 Obsidian Sync、iCloud 或 Git。

2. **个人纠错词表 + 直接向 Copilot 侧栏语音输入**
   - 设置页内置可视化多别名纠错词表（支持把同音词一键映射为 `Obsidian`、`Zettelkasten` 或 `[[双链笔记]]`）。
   - 除了写入当前笔记光标处，把光标点进右侧 **Copilot（`4.0.20` Lexical 富文本输入框）** 或全局搜索框按快捷键说话，文字直接注入侧栏、不污染系统剪贴板、保留完整 `Cmd/Ctrl+Z` 撤销栈。

3. **跳过表格与代码的朗读 + 悬浮字幕条 + 原生 AEC3 外放语音打断**
   - 自动剥离 Frontmatter、代码围栏、`$$` 公式、裸 URL、Callout 与管道表格；底部悬浮字幕支持字号/宽度三档调节（浅/深色对比度 `15.91:1` / `12.19:1`）、`Pause / Next / Stop`（`< 100 ms` 瞬停）及切笔记自动停读。
   - 支持系统语音、本地离线 `VITS`（5 音色）、本机可选 `Kokoro` 守护进程，以及 **小米 MiMo / SiliconFlow / OpenAI 兼容** BYOK 云端朗读；桌面使用非系统音频朗读且原生 AEC3 生效时，支持免手按开口即停（连续外放 `180 秒` 零误触发自打断，人声打断响应 `66–370 ms`）。

4. **可选 BYOK 选区/笔记流式语音问答与 4 重护栏润色（`SecretStorage`）**
   - 默认关闭；开启后支持 DeepSeek、通义千问 Qwen、火山方舟 Doubao、Kimi、硅基流动、OpenRouter、OpenAI、Anthropic 与本地 Ollama（遇 `Origin: app://obsidian.md` CORS 阻断自动无感回退）。
   - 所有 API Key 严格保存在 Obsidian `1.11.4+` 原生系统钥匙串 `SecretStorage` 中，**`data.json` 零明文密钥**。

5. **移动端安全降级说明（`isDesktopOnly: false`）**
   - 为避免触发 iOS `WKWebView`（~500 MB Jetsam）内存闪退，移动端自动屏蔽 200 MB+ 本地 WASM 模型，且默认关闭移动端云端回退开关（需手动开启 `Allow cloud fallback on mobile`）。
   - 实测 iOS `WKWebView` 原生自带 68 种系统 `speechSynthesis` 语音；Android 系统 WebView 原生不含 `window.speechSynthesis`，在 Android 端朗读或跨端听写可开启 BYOK 接口使用。

### 安装与开源地址

- **GitHub 仓库（MIT 开源）**：https://github.com/qishuilalala/obsidian-voice-mode
- **BRAT 抢先安装**：在 BRAT 中添加 `qishuilalala/obsidian-voice-mode` 即可启用；或从 Release `0.1.0` 下载 `main.js`、`manifest.json`、`styles.css` 放入 `.obsidian/plugins/voice-mode/`。

欢迎大家试用反馈真实声卡、Windows/Linux 与移动端机型的体验建议！
```

---

## 6. 少数派（Matrix 深度文章导语与正文框架）

**标题**：  
`在 Obsidian 里实现真离线中英语音听写与降噪朗读：为什么我放弃外置服务，重写了一套开源语音 I/O 层`

**正文**：

```markdown
如果你尝试过在 Obsidian 里用语音记闪念或听长文笔记，大概率踩过这几个坑：要么得先在终端跑起一个 Python / Faster-Whisper 本地服务，合上盖子再打开就连接失败；要么只能把私人日记录音发往云端；而想用 TTS 听一篇技术或读书笔记时，朗读者又会一丝不苟地把 YAML 属性、`https://...` 长链接和 `| --- |` Markdown 表格线从头念到尾。

过去几周，我把自己在终端工具里验证过的语音内核抽离成了零依赖的 TypeScript 开源工作空间，做出了 **Obsidian Voice Mode**（`0.1.0`，MIT 协议开源）。这篇文章聊清楚三件事：它解决什么具体问题、遇到了哪些真实的 Electron / WebView 工程暗坑，以及它的诚实能力边界。

*(此处嵌入 15 秒横屏有声演示 `demo-16x9-1080p.mp4`)*

### 1. 零外置服务，也不把模型塞进你的 Vault

许多离线插件之所以难推广，是因为外部服务把普通用户挡在了门外；但如果把两三百兆模型直接放进 `.obsidian/plugins/`，又会瞬间撑爆 Obsidian Sync 和 Git 仓库。

Voice Mode 的做法是：**插件本体 `main.js` 只有 `284 KB`**，安装后即可零配置调用系统朗读；当你在桌面端设置页主动点击下载离线模型时，插件会从白名单源（支持一键切换 `hf-mirror.com` 与 `npmmirror` 国内源及断点续传）拉取 `Silero VAD` + `SenseVoice int8`（共 `245.3 MB`），逐文件校验固定 SHA256，并强制存放在 **Vault 之外**的系统缓存目录（macOS/Linux 为 `~/.cache/voice-mode/models/`，Windows 为 `%LOCALAPPDATA%\voice-mode\models\`）。

在 Apple M2 Max 的真实 `Obsidian 1.15.1`（Electron `43.8.9`）15 分钟连续压测中，隔离 `MEMFS` Web Worker 冷加载 `SenseVoice int8` 仅需 `485 ms`，中英混说平均实时率 `RTF = 0.215`，WASM 线性内存全程恒定在 `512 MB`，闲置超时后自动终止 Worker 归还内存。

### 2. 不是替代 Copilot，而是成为所有输入框的“麦克风层”

我不希望用户为了语音输入放弃自己已经配好知识库索引的 Copilot。因此 Voice Mode 内置了通用的焦点穿透注入器（`FocusTextInjector`）：
- 光标在正文时，走 CodeMirror 6 接口精准写入；
- 光标点进右侧 **Copilot 侧栏**（基于 Lexical 虚拟 DOM 的 `contenteditable`）时，派发内存态合成 `ClipboardEvent("paste")`——既不会被虚拟编辑器吞字，也不会覆盖你系统剪贴板里原有的内容，还能正常 `Cmd+Z` 撤销；
- 配合单遍多别名纠错词表，口述里的同音词会自动替换成准确的英文术语或 `[[双链笔记]]`。

### 3. 朗读不念表格线，外放打断不自己吵停自己

朗读链路内置了流式 `SentenceSegmenter`：自动剥离 YAML Frontmatter、代码围栏、数学公式块、裸 URL、Callout 头与管道表格，配合可调字号/宽度的底部字幕条。

在“开口打断朗读（Barge-in）”上，实测揭示了一个很容易被忽略的声学事实：开启麦克风自动增益（`autoGainControl: true`）反而会把扬声器回声残差放大近一倍；且系统自带 `window.speechSynthesis` 走操作系统独立守护进程，不经过 Chromium 混音器，回声消除没有参考信号。因此 Voice Mode 仅在非系统音频（本地 `VITS` 或 BYOK 云端语音）且探测到原生 AEC3 生效时才开启免手按语音打断（外放连续朗读 3 分钟 `0` 误触发，开口 `66–370 ms` 即停），其余场景自动锁定安全的按键停止。

### 4. 安全红线与跨端边界

- **零明文密钥**：所有可选 BYOK 接口（DeepSeek、通义千问、豆包、Kimi、硅基流动、OpenAI、Anthropic、小米 MiMo TTS 等）均通过 Obsidian `1.11.4+` 原生 `SecretStorage` 存储密钥，`data.json` 零密钥落盘，报错日志先脱敏再截断。
- **移动端诚实降级**：移动端自动禁用 200 MB+ 本地 WASM 模型以防触发 iOS `WKWebView` ~500 MB Jetsam 闪退；iOS 端可直接用系统内置语音，Android 系统 WebView 因底层未暴露 `window.speechSynthesis`，可通过手动开启 BYOK 云端接口实现朗读与听写。

项目完全按 MIT 协议开源在 GitHub：`https://github.com/qishuilalala/obsidian-voice-mode`（支持 BRAT 直接安装），欢迎尝鲜与提 Issue 交流。
```

---

## 7. V2EX (`/go/create` · 分享创造)

**标题**：  
`开源了一个 Obsidian 离线中英语音插件 voice-mode：无需部署后端，内置词表纠错、表格降噪朗读，可直接给 Copilot 侧栏语音输入`

**正文**：

```markdown
最近给 Obsidian 写了一个本地优先的开源语音插件 **Voice Mode**（`0.1.0`，MIT 协议），把离线听写、Markdown 降噪朗读和可选 BYOK 语音问答做成了一个 `284 KB` 的纯前端插件包。

GitHub：https://github.com/qishuilalala/obsidian-voice-mode

### 主要特性与实测数据

- **免装外部后端的桌面离线听写**：基于 `sherpa-onnx@2.0.2` WASM，在隔离 `MEMFS` Web Worker 内跑 `Silero VAD` + `SenseVoice int8`。M2 Max（Obsidian `1.15.1`）实测冷加载 `485 ms`，15 分钟连续中英混说均值 `RTF = 0.215`，支持 Toggle / 单句自动停 / Push-to-Talk，空闲自动销毁 Worker 回收内存。
- **Vault 外缓存 + 国内源**：模型只在设置页手动点下载时拉取（支持 `hf-mirror.com` + `npmmirror` 断点续传与固定 SHA256 校验），存在 `~/.cache/voice-mode/models/`（Windows 在 `%LOCALAPPDATA%\voice-mode\models\`），不进 Vault，不污染 Obsidian Sync / Git。
- **词表替换 + 侧栏焦点注入**：支持把常被识别错的专有名词或 `[[双链]]` 配进个人词表；焦点在主编辑器走 CM6，焦点在 Copilot（`4.0.20` Lexical）等侧栏输入框时走内存态合成 `ClipboardEvent("paste")`，不污染系统剪贴板。
- **Markdown 表格/代码降噪朗读 + 原生 AEC3 打断**：自动跳过 YAML frontmatter、代码块、公式、URL 和 `| --- |` 管道表格；支持系统语音、可选本地 `vits-zh-ll`（5 音色）、小米 `MiMo` / OpenAI 兼容 TTS；非系统 TTS 下基于原生 AEC3（`+8.99 dB` 抑制）实现外放开口即停（3 分钟外放 `0` 自打断，打断延迟 `66–370 ms`）。
- **零依赖 BYOK 路由 + `SecretStorage`**：`@voice-mode/core` 零运行时 npm 依赖，`396` 行双协议路由覆盖 DeepSeek / Qwen / 豆包 / Kimi / SiliconFlow / OpenRouter / OpenAI / Anthropic / 本地 Ollama（自动处理 `Origin: app://obsidian.md` CORS 回退），API Key 只存 Obsidian `1.11.4+` 原生 `SecretStorage`，绝不写 `data.json`。
- **移动端边界**：`isDesktopOnly: false`（已通过 `Android 15 AVD Emulator (Obsidian 1.15.1 APK, System WebView 124.0)` 与 `Xcode iOS 27.0 Simulator WKWebView harness` 验证），移动端自动屏蔽重型 WASM 防 Jetsam OOM；iOS `WKWebView` 可直接用系统语音，Android System WebView 原生无 `speechSynthesis`（保留 `webkitSpeechRecognition` 并友好提示开启 BYOK 云端 TTS）。

目前可通过 BRAT（填入 `qishuilalala/obsidian-voice-mode`）或下载 Release `0.1.0` 的 `main.js` / `manifest.json` / `styles.css` 安装。底层拆成了 `@voice-mode/core` 和 `@voice-mode/browser`，同系开源矩阵还包含 SillyTavern 扩展 [`sillytavern-voice-mode`](https://github.com/qishuilalala/sillytavern-voice-mode)、本机共享守护进程与浏览器扩展 [`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon)（解锁原生 Kokoro 103 音色，多端共享单份模型）及 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode)。欢迎各位 V 友拍砖！
```

---

## 8. 小红书（9:16 竖屏短视频配套图文）

**配片**：`release-assets/demo-9x16-vertical.mp4`（`1080x1920` · `15.0s` 真实 Obsidian 界面与合成语音有声演示）

**标题**（≤ 20 字）：  
`Obsidian 断网也能语音写笔记了！还能对 Copilot 说话`

**正文**：

```markdown
写论文、记闪念或者复盘长笔记的时候，终于不用在 Obsidian 外面折腾本地 Python 服务和复制粘贴了！

自己开源了一个免费无广告的 Obsidian 语音插件 **Voice Mode**（MIT 开源），15 秒真实界面有声演示展示 4 个最顺手的细节：

1️⃣ **完全断网也能中英混说听写（桌面端）**
不用装任何外部软件！在插件设置里点一下模型下载（内置国内镜像断点续传，自动存在笔记库外面，完全不占同步空间），中英文夹杂自动加标点，冷启动不到 0.5 秒。

2️⃣ **专属词表零错字**
平时总被听错的专业术语、人名或者 `[[双链笔记]]`，配进个人替换词表，说出口直接变成准确格式。

3️⃣ **朗读自动跳过 Markdown 表格和代码**
再也不会听到机械念出“竖线杠杠杠竖线”了！自带底部清透字幕条，字号宽度可调，切到别的笔记自动停读，还支持接入本地离线语音或 MiMo / 硅基流动等自然音色。

4️⃣ **光标点进 Copilot 侧栏也能直接语音提问**
不用换掉你习惯的 AI 插件，点进右侧 Copilot 输入框按同一个快捷键说话，文字直接落进对话框，而且完全不覆盖剪贴板！

🔒 **隐私安心**：零遥测、零启动联网；如果自配 API Key，全部走 Obsidian 官方系统钥匙串加密保存，不落明文配置。手机端也会自动开启内存保护模式防闪退～

📦 **安装方式**：
开源地址：`github.com/qishuilalala/obsidian-voice-mode`
装了 BRAT 插件的朋友直接添加 `qishuilalala/obsidian-voice-mode` 就能一键体验！

#Obsidian #Obsidian插件 #知识管理 #效率工具 #开源软件 #双链笔记 #本地离线AI #科研工具
```
