# Obsidian Voice Mode（语音模式）

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **当前真实状态（`0.1.0` · Alpha 架构初始化阶段）**
>
> 本仓库目前处于 **架构初始化与共享核心基建阶段**：已完成三包 Monorepo（`@voice-mode/core`、`@voice-mode/browser`、`@voice-mode/obsidian-plugin`）、纯文本/语音管线核心模块、音频契约、插件骨架（含设置页与字幕浮层）以及三端 CI/发布合规门禁。
>
> **`0.1.0` 已上线预览能力 vs 尚未实现能力**：
> - **`0.1.0` 骨架已注册命令**：其中「朗读选区/笔记」已提供零配置系统 `speechSynthesis` 预览（结合 Markdown/表格清洗与字幕浮层）；「切换听写」在 M1 本地离线 WASM 落地前仅在宿主浏览器/WebView 支持原生 `SpeechRecognition` 时作为占位兜底（**在未内置 Google Speech Key 的桌面 Obsidian Electron 上不可用**，且在支持的浏览器/WebView 下会把语音发送至对应浏览器/系统语音服务商）。
> - **尚未上线（计划于 M0–M3 实测落地）**：本地离线 WASM 听写（`Silero VAD` + `SenseVoice int8`）、Vault 外 SHA256 模型下载器、AEC3 打断闭环、BYOK 语音问答界面以及桌面/移动端真机声学验收。**请勿将 `0.1.0` 当作已可用的离线听写正式版安装**；最新进展见 [docs/rules/STATE.md](docs/rules/STATE.md) 与 [docs/plan/master-plan.md](docs/plan/master-plan.md)。

---

## 为什么做 Voice Mode？

现有 Obsidian 语音插件普遍存在三类割裂痛点：要么强迫用户自行部署外部本地 WebSocket 服务导致门槛极高，要么强制上传私人笔记与录音到第三方云端，要么在朗读笔记时把 Markdown 管道表格（`| --- |`）、代码块和 URL 原样机械念出。

**Voice Mode**（官方插件 ID `voice-mode`，最低要求 Obsidian `1.11.4`）定位为**零外置服务、本地优先、与 Copilot / Smart Connections 等既有 AI 插件和平共存的通用语音 I/O 层**：

- **默认零外置离线听写（计划 M1）**：桌面端通过 Web Worker WASM 运行单模型离线识别（`Silero VAD` + `SenseVoice int8`），支持中英混说自动标点与个人纠错词表（专有名词/双链术语准确替换）。
- **主编辑器与第三方侧栏零耦合注入（计划 M1）**：优先写入当前 Markdown 编辑器光标处，也可直接向聚焦中的 Copilot 等第三方侧栏输入框语音输入。
- **Markdown 与表格降噪朗读（`0.1.0` 已提供系统语音预览；完整链路计划 M2）**：朗读前剥离 YAML Frontmatter、代码围栏（```` ``` ```` / `~~~`）、数学块（`$$...$$`）、裸 URL、Obsidian Callout 标记与 Markdown 管道表格，并将内联代码与 Wikilink 语法清理为自然口语文本，配合悬浮字幕条与计划中的原生 AEC3 打断（不支持原生回声消除时自动降级为 `manual` 按键打断）。
- **可选零依赖 BYOK 语音问答与润色（计划 M3）**：内置 `< 400` 行纯 TypeScript 双协议路由，支持 OpenAI 兼容接口（DeepSeek、阿里云百炼 Qwen、火山方舟 Doubao、Kimi、硅基流动、OpenRouter、OpenAI、本地 Ollama）及 Anthropic Messages，凭据严格托管于 Obsidian 原生 `SecretStorage`。
- **可选统一本机 `voice-daemon`（计划 Wave 3）**：面向重度用户的一键可选加速进程，绕开 Electron V8 内存笼解锁 Kokoro 103 音色与跨软件单份模型共享缓存。

---

## 三包架构与参考基准

本仓库从初始化即拆分为三包 Monorepo，严格隔离宿主耦合，作为与 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 同源的跨平台 Voice Mode 系列母仓：

| 包名 | 核心职责 | 依赖红线 |
| --- | --- | --- |
| `packages/voice-core`（`@voice-mode/core`） | 零依赖纯 TS 语音管线：Markdown/表格朗读分句、ASR 纠错词表、情感标签 DSL、密钥脱敏与双协议 BYOK `llm-router` | 零第三方运行时依赖；禁 `obsidian`、`electron`、`node:*` |
| `packages/voice-browser`（`@voice-mode/browser`） | 浏览器/Electron 音频契约：16 kHz `AudioWorklet` 重采样、AEC3 探针、播放队列与 Worker 协议 | 仅依赖标准 Web/Audio API；禁 `obsidian` |
| `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`） | 极薄 Obsidian 适配层，通过 `esbuild` 打包为根目录 `main.js`（严守 `< 5 MB` Obsidian Sync 预算） | `obsidian`（`minAppVersion: 1.11.4`） |

### Obsidian 真机 Web Worker WASM 实测基准（M0 门禁已通过 · 2026-11-22）

实测环境：**Apple M2 Max macOS `27.2.1`（32 GB 内存）、真实 Obsidian `1.15.1`（`Electron 43.8.9` / `Chromium 150.0.7871.250`）渲染进程隔离 `MEMFS` Web Worker、`sherpa-onnx@2.0.2` WASM、连续 15 分钟（60 轮中英混说语料）会话**（完整记录见 [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md)；M1 插件端到端集成推进中）：

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
| **桌面端**（macOS / Windows / Linux，Obsidian `>= 1.11.4`） | 主力端（待 M0–M3 实机验证） | `0.1.0` 已提供系统 `speechSynthesis` 朗读预览；计划支持默认 Web Worker 离线 WASM 听写 + 系统/BYOK/可选本地朗读 + Wave 3 可选 `voice-daemon` |
| **移动端**（iOS / Android，Obsidian `>= 1.11.4`） | 优雅降级（`isDesktopOnly: false`，待 M3 真机验证） | `Platform.isMobile` 下强制禁用 200 MB+ 本地 WASM 模型以防 iOS WKWebView（~500 MB Jetsam）闪退，提供 BYOK API + 系统语音 |

---

## 隐私边界、外部网络与模型来源披露

严格遵循 Obsidian 开发者政策，提前完整披露所有权限与网络行为（详见 [SECURITY.md](SECURITY.md)）：

1. **零遥测与零静默外联**：不收集任何使用统计、崩溃上报或行为埋点；插件启动时不发起任何网络请求。
2. **当前 `0.1.0` 预览命令说明**：
   - 「朗读选区/笔记」调用宿主 `window.speechSynthesis`；
   - 「切换听写」在 M1 前仅在宿主暴露原生 `SpeechRecognition` 时作为占位兜底（无内置 Google Speech Key 的桌面 Electron 不可用；在支持的浏览器/WebView 下音频会发往对应浏览器/系统语音服务商）。
3. **模型下载完全由用户显式触发（计划 M1/M2，尚未上线）**：
   - 桌面离线模型仅在用户点击下载后从公开 HTTPS 源拉取（默认 `https://huggingface.co`，可选国内镜像 `https://hf-mirror.com`），逐文件按固定 **SHA256** 校验；
   - 模型一律保存在 **Vault 之外**的操作系统应用缓存目录（macOS/Linux `~/.cache/voice-mode/models/`，Windows `%LOCALAPPDATA%\voice-mode\models\`），绝不污染 `.obsidian/`、Obsidian Sync、iCloud 或个人 Git 仓库。
4. **可选 BYOK 云端接口（计划 M3，尚未上线）**：
   - 仅当用户主动填写服务商并调用对应命令时，才由客户端直连目标端点，无任何开发者中转服务器；
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
- **M1（推进中）**：桌面离线 WASM 听写（`Silero VAD` + `SenseVoice int8`）、自定义纠错词表、编辑器与第三方侧栏聚焦注入。
- **M2**：Markdown/表格降噪按句朗读、悬浮字幕条与 AEC3 外放打断 / `manual` 兜底。
- **M3**：基于 `SecretStorage` 的可选 BYOK 语音问答与润色、移动端降级实测、发版前 4 项真机声学门禁。
- **M4**：向 `obsidianmd/obsidian-releases` 提交官方社区目录 PR 并发布正式版。
- **Wave 2（M5）与 Wave 3（M6）**：复用 `@voice-mode/core` 与 `@voice-mode/browser`，与 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 联动推出 `sillytavern-voice-mode` 全双工情感语音插件，以及跨宿主统一 `voice-daemon` + 开源 Chrome/Edge 扩展。

完整规划与架构依据见 [docs/plan/master-plan.md](docs/plan/master-plan.md) 与 [docs/adr/README.md](docs/adr/README.md)。

## 许可证

[MIT](LICENSE) © 2026 qishuilalala
