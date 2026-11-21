# Obsidian Voice Mode（语音模式）

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **当前真实状态（`0.1.0` Alpha · `main` 已完成 M0–M3 桌面核心与声学/安全门禁，待移动实机 `M-1`–`M-5` 确认后进入 M4 提审）**
>
> **`main` 当前已上线能力 vs 正式发版前待完成项**：
> - **`main` 已落地（M0 + M1 + M2 + M3）**：
>   - **桌面 100% 本地离线 WASM 听写（`SenseVoice WASM`）**：隔离 `MEMFS` Web Worker 运行 `Silero VAD` + `SenseVoice int8`（`sherpa-onnx@2.0.2`），支持 `toggle` 连续听写、`single` 单句自动停止与 `push-to-talk` 按住说话，支持空闲 Worker 自动卸载释放内存（`main.js` 仅 `261.9 KB`）。
>   - **Vault 外显式触发 + SHA256 校验模型管理器**：支持离线听写栈（`245.3 MB`）与可选离线 `vits-zh-ll` 朗读包（`116.1 MB`）的 `.part` 断点续传、主备源自动切换（`huggingface.co` / `hf-mirror.com` 与 `registry.npmjs.org` / `registry.npmmirror.com`）、一键打开目录与一键清理，严格校验路径位于 Vault 之外（`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`）。
>   - **个人纠错词表可视化编辑与全场景光标注入**：支持多同音别名单遍替换为专业术语或 `[[双链笔记]]`，精准写入 CodeMirror 6 主编辑器、全局搜索框、Shadow DOM 输入框及 Lexical/ProseMirror 第三方侧栏（`Copilot 4.0.20`）。
>   - **Markdown/表格降噪按句朗读、字幕档位播控与原生 AEC3 外放语音打断**：支持系统 `speechSynthesis`、桌面可选离线 `vits-wasm`（5 音色，单重模型互斥）及 BYOK `openai-compat` / `mimo` 云端 TTS（按预设隔离 `SecretStorage` + 零重定向 CORS 兜底），配套字号/宽度档位字幕条、暂停/跳句/停止按钮、切笔记自动中断与原生 AEC3 免手按语音打断（`180 s` 扬声器连续外放 `0` 自打断，外部语音打断 `66–370 ms < 600 ms`，`system` TTS 下自动锁定 `manual`）。
>   - **可选 BYOK 选区/笔记语音问答、4 重护栏听写润色与云端转写（`SecretStorage`）**：上线 `Ask AI about selection or note` 流式问答模态框（支持口述提问、流式按句跟读与一键写入光标处）、听写后可选 4 层防幻觉 LLM 润色（任意错误零丢字回退原文）及零 WASM 依赖的 `openai-compat` `/audio/transcriptions` 转写（移动端受 `Allow cloud fallback on mobile` 严格门控）。
> - **M4 商店提审前待实机核验项**：iOS/Android 移动物理设备实机验证（[docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) §3 `M-1`–`M-5`）与 Wave 3 可选本机 `voice-daemon`。最新进展见 [docs/rules/STATE.md](docs/rules/STATE.md) 与 [docs/plan/master-plan.md](docs/plan/master-plan.md)。

---

## 为什么做 Voice Mode？

现有 Obsidian 语音插件普遍存在三类割裂痛点：要么强迫用户自行部署外部本地 WebSocket 服务导致门槛极高，要么强制上传私人笔记与录音到第三方云端，要么在朗读笔记时把 Markdown 管道表格（`| --- |`）、代码块和 URL 原样机械念出。

**Voice Mode**（官方插件 ID `voice-mode`，最低要求 Obsidian `1.11.4`）定位为**零外置服务、本地优先、与 Copilot / Smart Connections 等既有 AI 插件和平共存的通用语音 I/O 层**：

- **默认零外置离线听写（M1 已上线）**：桌面端通过 Web Worker WASM 运行单模型离线识别（`Silero VAD` + `SenseVoice int8`），支持中英混说自动标点与个人纠错词表可视化编辑（专有名词/双链术语准确替换）。
- **主编辑器与第三方侧栏零耦合注入（M1 已上线）**：优先写入当前 Markdown 编辑器光标处，也可直接向聚焦中的 Copilot（Lexical）等第三方侧栏输入框语音输入且零污染系统剪贴板。
- **Markdown 与表格降噪朗读（M2 已上线）**：朗读前剥离 YAML Frontmatter、代码围栏（```` ``` ```` / `~~~`）、数学块（`$$...$$`）、裸 URL、Obsidian Callout 标记与 Markdown 管道表格，并将内联代码与 Wikilink 语法清理为自然口语文本，配合可调字号/宽度与暂停/跳句/停止按钮的悬浮字幕条、可选离线 `vits-wasm` / BYOK TTS 及原生 AEC3 外放语音打断（无原生回声消除或系统语音时自动降级为 `manual` 按键打断）。
- **可选零依赖 BYOK 语音问答、4 重护栏润色与云端转写（M3 已上线）**：内置 `< 400` 行纯 TypeScript 双协议路由，支持 OpenAI 兼容接口（DeepSeek、阿里云百炼 Qwen、火山方舟 Doubao、Kimi、硅基流动、OpenRouter、OpenAI、本地 Ollama）、Anthropic Messages 及 `/audio/transcriptions` 语音转写，凭据严格托管于 Obsidian 原生 `SecretStorage`。
- **可选统一本机 `voice-daemon`（计划 Wave 3）**：面向重度用户的一键可选加速进程，绕开 Electron V8 内存笼解锁 Kokoro 103 音色与跨软件单份模型共享缓存。

---

## 三包架构与参考基准

本仓库从初始化即拆分为三包 Monorepo，严格隔离宿主耦合，作为与 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 同源的跨平台 Voice Mode 系列母仓：

| 包名 | 核心职责 | 依赖红线 |
| --- | --- | --- |
| `packages/voice-core`（`@voice-mode/core`） | 零依赖纯 TS 语音管线：Markdown/表格朗读分句、ASR 纠错词表、情感标签 DSL、固定 SHA256 模型清单与 USTAR tar 解包器、`OpenAiCompatAsrTransport`、`OpenAiCompatTtsEngine` / `MimoTtsEngine` + `sniffAudioMime`、密钥脱敏与 `< 400` 行双协议 BYOK `llm-router` | 零第三方运行时依赖；禁 `obsidian`、`electron`、`node:*` |
| `packages/voice-browser`（`@voice-mode/browser`） | 浏览器/Electron 音频契约：16 kHz `AudioWorklet` 重采样、AEC3 探针与 `AecBargeInMonitor`、支持暂停/跳句的 `PlaybackQueue`、隔离 `MEMFS` Web Worker 运行时/客户端、`VitsWasmTtsEngine`、离线听写与零 WASM 的 `CloudDictationSession`（`640 ms` 预卷缓冲 + 断句） | 仅依赖标准 Web/Audio API；禁 `obsidian` |
| `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`） | 极薄 Obsidian 适配层，通过 `esbuild` 打包为根目录 `main.js`（当前 `261.9 KB`，远低于 `< 5 MB` Obsidian Sync 预算） | `obsidian`（`minAppVersion: 1.11.4`） |

### Obsidian 真机 Web Worker WASM 实测基准（M0、M1 与 M2 门禁已通过 · 2026-11-22）

实测环境：**Apple M2 Max macOS `27.2.1`（32 GB 内存）、真实 Obsidian `1.15.1`（`Electron 43.8.9` / `Chromium 150.0.7871.250`）渲染进程隔离 `MEMFS` Web Worker、`sherpa-onnx@2.0.2` WASM、连续 15 分钟（60 轮中英混说语料）会话及 M1 插件端到端离线听写验收**（完整记录见 [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md)）：

| WASM 引擎 / 模型 | 冷加载耗时 | RTF（实时率） | 常驻 RSS 增量 | 定位 |
| --- | ---: | ---: | ---: | --- |
| `Silero VAD` | `30 ms` | — | 含于下方同 Worker | 端点检测与打断 VAD |
| `SenseVoice int8` | `485 ms` | `0.215`（15m 均值） | 稳态 `+348.7 MB`（峰值 `+527.5 MB`，WASM 堆恒定 `512 MB`） | M1 桌面默认单模型离线听写 |
| `Zipformer2` | `1,939 ms`（Node 参考） | `0.259` | `463 MB`（Node 参考） | 可选流式识别 / Wave 3 `voice-daemon` |
| `VITS`（`vits-zh-ll`） | `391 ms` | `1.268` | 80 句稳态 `438 MB` | M2 桌面显式可选离线 TTS（`#3960` 未修，Kokoro 留归 Wave 3 `voice-daemon`） |

---

## 平台支持与移动端降级策略

| 平台 | 目标定位 | 运行策略 |
| --- | --- | --- |
| **桌面端**（macOS / Windows / Linux，Obsidian `>= 1.11.4`） | 主力端（macOS M0–M3 已实测通过） | 已上线 Web Worker 离线 WASM 听写（`SenseVoice WASM`）、多引擎朗读（系统语音、可选离线 `vits-wasm`、BYOK `openai-compat`/`mimo`）+ 原生 AEC3 外放打断，以及可选 BYOK 选区/笔记语音问答（`VoiceQaModal`）、4 层防幻觉润色与 `openai-compat` 转写；Wave 3 可选 `voice-daemon` 规划中 |
| **移动端**（iOS / Android，Obsidian `>= 1.11.4`） | 优雅降级（`isDesktopOnly: false`，待移动物理实机 `M-1`–`M-5` 核验） | `Platform.isMobile` 下强制禁用 200 MB+ 本地 WASM 模型以防 iOS WKWebView（~500 MB Jetsam）闪退，提供系统语音与默认关闭的显式授权 BYOK 接口（`allowCloudFallbackOnMobile` 默认 `false`） |

---

## 隐私边界、外部网络与模型来源披露

严格遵循 Obsidian 开发者政策，提前完整披露所有权限与网络行为（详见 [SECURITY.md](SECURITY.md)）：

1. **零遥测与零静默外联**：不收集任何使用统计、崩溃上报或行为埋点；插件启动时不发起任何网络请求。
2. **当前已上线听写、朗读与语音问答命令说明**：
   - 桌面端开启 `SenseVoice WASM` 后，「切换听写 / 单句听写」在隔离 Web Worker 中 100% 本地离线运行，听写全程零外联；仅在显式选用 `openai-compat` 时将切分后的 16 kHz WAV 上传至用户配置的 `/audio/transcriptions` 端点；若保持「系统语音识别」，仅在宿主暴露原生 `SpeechRecognition` 时兜底（无内置 Google Speech Key 的桌面 Electron 不可用，插件会提示切换至 `SenseVoice WASM`；在支持的浏览器/WebView 下音频由宿主发往对应浏览器/系统语音服务商）；
   - 「朗读选区/笔记」默认调用零外联宿主 `window.speechSynthesis`，并支持桌面可选 100% 本地离线 `VITS WASM` 或用户显式配置的 BYOK `OpenAI 兼容` / `MiMo` 云端朗读；
   - 「向 AI 询问选区/笔记」与「听写后 LLM 润色」**默认关闭**（`enableVoiceQa: false`、`enableLlmPolish: false`），仅在用户显式开启后才将当前选区（或上限 `24,000` 字符的当前笔记）与问题，或单句待 4 层防幻觉润色的转写文本发往用户配置的模型端点。
3. **模型下载完全由用户显式触发（桌面端，M1/M2 已上线）**：
   - 桌面离线模型仅在用户在设置页点击下载后从公开白名单 HTTPS 源拉取：语音权重（`Silero VAD`、`SenseVoice int8`、可选 `VITS`）走 `https://huggingface.co` 或可选国内镜像 `https://hf-mirror.com`，`sherpa-onnx@2.0.2` WASM 运行时（`Apache-2.0`）走 `https://registry.npmjs.org` 或 `https://registry.npmmirror.com`（`cdn.npmmirror.com`），逐文件按固定 **SHA256** 与重定向域名白名单校验；
   - 全部模型与运行时（听写栈 `245.3 MB`；可选 VITS 朗读包 `116.1 MB`）保存在 **Vault 之外**的操作系统应用缓存目录（macOS/Linux `~/.cache/voice-mode/models/`，Windows `%LOCALAPPDATA%\voice-mode\models\`，或经校验位于 Vault 外的自定义路径），绝不污染 `.obsidian/`、Obsidian Sync、iCloud 或个人 Git 仓库。
4. **可选 BYOK 云端接口（BYOK TTS、LLM 问答、4 层润色与转写已于 M2/M3 上线，均默认关闭/按需启用）**：
   - 仅当用户主动配置服务商并启用对应能力（`/audio/speech`、`/audio/transcriptions`、`/chat/completions`、`/messages`、本地回环 Ollama / LM Studio 或小米 `MiMo` `https://api.xiaomimimo.com/v1/chat/completions`）时，才由客户端直连目标端点，无任何开发者中转服务器；移动端默认关闭非回环云端请求（需开启 `Allow cloud fallback on mobile`）；
   - 所有 API Key 仅存放在 Obsidian 官方 `app.secretStorage`（`>= 1.11.4`），**绝不明文写入 `data.json`**；携带鉴权头的请求强制 `redirect: 'error'`，错误日志先脱敏后截断。
5. **系统权限**：仅在用户主动开启听写或外放打断监听时申请麦克风权限。
6. **许可证隔离**：本仓库代码采用 MIT 许可证；仓库与 GitHub Release **严禁打包**任何模型权重或 GPL-3.0 `espeak-ng-data` 音素数据，运行时独立下载的模型资产保留各自上游许可证（SenseVoice 为 FunAudioLLM，`sherpa-onnx` / Kokoro 为 Apache-2.0，`espeak-ng-data` 为 GPL-3.0）。

---

## 本地开发与验证

需 **Node.js `>= 22.18.0`**（三包单测依赖 Node 原生 type-stripping 直接导入 `.ts`；CI 使用 Node 22）与 **`pnpm@12.21.0`**：

```bash
pnpm install --frozen-lockfile
pnpm run check:all
```

`pnpm run check:all` 会依次执行三包 `typecheck`、`lint`（含 `eslint-plugin-obsidianmd`）、`test`、`build` 与 `check:release`。开发规范见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CONTEXT.md](CONTEXT.md)。

---

## 路线图与开源语音矩阵

- **M0（已完成 · 2026-11-22）**：Obsidian `1.15.1`（`Electron 43.8.9`）真机通过全部 6 项开工前 Spike（Worker WASM 15 分钟内存/RTF、Vault 外缓存隔离、Copilot `4.0.20` Lexical 侧栏注入、API CORS 与回环 SSE 矩阵、`sherpa-onnx@2.0.2` `#3960`/`#1939` 复验、原生 AEC3 与 `SecretStorage` 探针）。
- **M1（已完成 · 2026-11-22）**：桌面离线 WASM 听写（`Silero VAD` + `SenseVoice int8`）、Vault 外 SHA256 模型管理器、个人纠错词表 UI、主编辑器与 Copilot Lexical 侧栏注入。
- **M2（已完成 · 2026-11-22）**：Markdown/表格降噪按句朗读、悬浮字幕字号/宽度档位与暂停/跳句/停止交互、可选离线 `vits-wasm` / BYOK TTS（`openai-compat`、`mimo`）及原生 AEC3 外放打断（`180 s` 零自打断压测，`66–370 ms` 语音打断）与 `manual` 兜底。
- **M3（桌面核心与声学/安全门禁已完成 · 2026-11-22）**：基于 `SecretStorage` 的可选 BYOK 选区/笔记语音问答（`VoiceQaModal`）、听写后 4 层防幻觉润色（`enableLlmPolish`）、`openai-compat` `/audio/transcriptions` 转写（`CloudDictationSession`）、401/500 密钥脱敏审计及发版前 4 项桌面真机声学门禁（`A-1`–`A-4` 全部通过；`main.js` `261.9 KB`，`147` 项单测；iOS/Android 移动物理真机 `M-1`–`M-5` 待核验）。
- **M4**：向 `obsidianmd/obsidian-releases` 提交官方社区目录 PR 并发布正式版。
- **Wave 2（M5）与 Wave 3（M6）**：复用 `@voice-mode/core` 与 `@voice-mode/browser`，与 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 联动推出 `sillytavern-voice-mode` 全双工情感语音插件，以及跨宿主统一 `voice-daemon` + 开源 Chrome/Edge 扩展。

完整规划与架构依据见 [docs/plan/master-plan.md](docs/plan/master-plan.md) 与 [docs/adr/README.md](docs/adr/README.md)。

## 许可证

[MIT](LICENSE) © 2026 qishuilalala
