# Obsidian Voice Mode（语音模式）

[![CI](https://github.com/qishuilalala/obsidian-voice-mode/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/qishuilalala/obsidian-voice-mode/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/github/license/qishuilalala/obsidian-voice-mode?style=flat-square)](LICENSE)

[English](README.en.md) | 简体中文

Voice Mode 可以把口述内容写入当前笔记或侧栏输入框，也能跳过代码块和表格，按句朗读选区或整篇笔记。桌面离线听写支持中英混说，首次使用需下载模型。语音问答和云端转写可按需启用。

**安装状态**　当前提供 `0.1.0` 源码。本仓尚未创建该版本的 GitHub Release，也未向 Obsidian 社区插件目录提审。

## 在桌面上开始使用

插件界面跟随 Obsidian 的应用语言。以下使用简体中文界面；「听写语言」用于选择识别语种。

1. 安装 Obsidian `1.11.4` 或更高版本。下载或克隆本仓源码，使用 Node.js `>= 22.18.0` 和 `pnpm@12.21.0`，在仓库根目录运行：

   ```bash
   pnpm install --frozen-lockfile
   pnpm run build
   ```

2. 在要使用的笔记库中创建 `.obsidian/plugins/voice-mode/`（使用自定义配置目录时替换 `.obsidian`）。将仓库根目录的 `main.js`、`manifest.json`、`styles.css` 复制进去，重新加载 Obsidian，在「设置 → 第三方插件」中启用 **Voice Mode**。
3. **先试朗读。** 打开一篇笔记，选中一段文字，在命令面板运行「朗读选中文本或当前笔记」。没有选区时会朗读当前笔记。使用系统语音时无需下载插件模型。
   - 长笔记朗读采用**背压分批入队**，队列推进时自动补批，超长笔记不再丢尾；字幕标题显示进度（如「正在朗读 (12/300)」）。
   - **按句自动切换语言**：系统语音会按句子语言选择语音（中文 zh-CN / 英文 en-US / 日文 ja-JP / 韩文 ko-KR）；Kokoro 音色在中英混排时会自动切换中/英音色（设置中可关闭 `autoLanguageVoice`）。
   - **发音词典**：可在设置中用与听写纠错相同的规则编辑器维护「朗读前替换」（例如把 `API` 念作 `A P I`），只作用于朗读。
   - 运行「**复制语音运行状态**」可把结构化运行快照（引擎/平台/模型状态/打断策略）复制到剪贴板，方便提交 issue；「**查看语音运行状态**」命令则以通知形式展示同一份快照。
   - 运行「**将朗读导出为 WAV**」可把选区或整篇笔记用 WAV 引擎（本地 VITS 或本机 daemon）合成为单个音频文件写入笔记库；系统语音无法导出时会明确提示。
   - 运行「**从上次位置继续朗读**」会从整篇笔记上次中断的句子继续，读完后清除书签。朗读选区或问答不会覆盖书签。
   - 首次使用本地模型（离线听写/朗读）时会自动弹出**下载向导**：说明一次性下载体积、提供「立即下载」（带进度）与「暂时使用系统语音」两个选择，无需先翻设置。
   - 表达标签：`<slow>` / `<fast>` / `<whisper>` 等由共享内核解析；当前版本 Obsidian 界面**尚未把标签接入引擎生效**，朗读时按普通文本处理（不念出标签本身）。
4. **再试离线听写。** 打开 Voice Mode 设置，在「模型与隐私」中点击「下载或校验模型」获取听写模型（约 245.3 MB，存放在笔记库外）。确认「语音输入」中的「识别引擎」为「SenseVoice WASM（桌面离线）」，把光标放回笔记，运行「听写一句话」，允许麦克风权限后说一句话。停顿后识别结果会写到光标处。需要连续听写时，运行「开始或停止听写」；再次运行即可结束。

移动端禁用本地 WASM 模型。已验证的环境为 Android 15 模拟器中的 Obsidian APK 和 iOS 27 模拟器中的 WKWebView 测试程序；实体手机尚待验证。移动端使用远程服务须在设置中开启「允许在移动端使用云服务回退」并配置服务商。见[验收记录](docs/qa/acceptance-checklist.md)。

---

## 为什么做 Voice Mode？

现有 Obsidian 语音插件普遍存在三类割裂痛点：要么强迫用户自行部署外部本地 WebSocket 服务导致门槛极高，要么强制上传私人笔记与录音到第三方云端，要么在朗读笔记时把 Markdown 管道表格（`| --- |`）、代码块和 URL 原样机械念出。

**Voice Mode**（插件 ID `voice-mode`，最低要求 Obsidian `1.11.4`）定位为**零外置服务、本地优先、与 Copilot / Smart Connections 等既有 AI 插件和平共存的通用语音 I/O 层**：

- **桌面离线听写（M1）**：桌面端通过 Web Worker WASM 运行单模型离线识别（`Silero VAD` + `SenseVoice int8`），支持中英混说、自动标点、连续听写、单句听写与按住说话。可在设置中编辑个人纠错词表，把同音别名写成专有名词或双链笔记。空闲时可自动卸载 Worker，释放内存。
- **在笔记和第三方侧栏中听写（M1）**：优先写入当前 Markdown 编辑器光标处，也可将光标放在搜索框、Shadow DOM 输入框或 Copilot（Lexical）等富文本侧栏中听写。输入时保留系统剪贴板内容。
- **跳过 Markdown 标记和表格朗读（M2）**：朗读前剥离 YAML Frontmatter、代码围栏（```` ``` ```` / `~~~`）、数学块（`$$...$$`）、裸 URL、Obsidian Callout 标记与 Markdown 管道表格，并将内联代码与 Wikilink 语法清理为自然口语文本，配合可调字号/宽度与暂停/跳句/停止按钮的悬浮字幕条、可选离线 `vits-wasm` / BYOK TTS 及原生 AEC3 外放语音打断（无原生回声消除或系统语音时自动降级为 `manual` 按键打断）。
- **可选语音问答、听写润色与云端转写（M3，自备 API 密钥，即 BYOK）**：内置 `< 400` 行纯 TypeScript 双协议路由，支持 OpenAI 兼容接口（DeepSeek `api.deepseek.com`、阿里云百炼 Qwen `dashscope.aliyuncs.com`、火山方舟 Doubao `ark.cn-beijing.volces.com`、Kimi `api.moonshot.cn`、硅基流动 `api.siliconflow.cn`、OpenRouter `openrouter.ai`、OpenAI `api.openai.com`、本地 Ollama `127.0.0.1:11434`）、Anthropic Messages（`api.anthropic.com`）及 `/audio/transcriptions` 语音转写，凭据严格托管于 Obsidian 原生 `SecretStorage`。
- **可选统一本机 `voice-daemon`（M6，见 [`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon)）**：面向重度用户的可选本机加速守护进程，绕开 Electron V8 内存笼解锁原生 `Kokoro 103` 音色（含 `<whisper>` / `<break>` 情感合成），并与 [`sillytavern-voice-mode`](https://github.com/qishuilalala/sillytavern-voice-mode)、[`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 共享内核。Obsidian 与 Chrome MV3 扩展联调时共用一个模型实例（`622.7 MB` RSS），守护进程退出时 `< 1s`（实测 `3 ms`）自动无感回退。属进阶可选、面向开发者的后端（需从源码构建，无安装包），**不是插件必需**：不安装它，桌面离线听写与朗读仍可正常使用。

---

## 三包架构与参考基准

本仓库从初始化即拆分为三包 Monorepo，严格隔离宿主耦合，作为与 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 同源的跨平台 Voice Mode 系列母仓：

| 包名 | 核心职责 | 依赖红线 |
| --- | --- | --- |
| `packages/voice-core`（`@voice-mode/core`） | 零依赖纯 TS 语音管线：Markdown/表格朗读分句、ASR 纠错词表、情感标签 DSL、固定 SHA256 模型清单与 USTAR tar 解包器、`OpenAiCompatAsrTransport`、`OpenAiCompatTtsEngine` / `MimoTtsEngine` + `sniffAudioMime`、密钥脱敏与 `< 400` 行双协议 BYOK `llm-router` | 零第三方运行时依赖；禁 `obsidian`、`electron`、`node:*` |
| `packages/voice-browser`（`@voice-mode/browser`） | 浏览器/Electron 音频契约：16 kHz `AudioWorklet` 重采样、AEC3 探针与 `AecBargeInMonitor`、支持暂停/跳句的 `PlaybackQueue`、隔离 `MEMFS` Web Worker 运行时/客户端、`VitsWasmTtsEngine`、离线听写与零 WASM 的 `CloudDictationSession`（`640 ms` 预卷缓冲 + 断句） | 仅依赖标准 Web/Audio API；禁 `obsidian` |
| `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`） | 极薄 Obsidian 适配层，通过 `esbuild` 打包为根目录 `main.js`（构建时检查 `< 5 MiB` 的体积上限） | `obsidian`（`minAppVersion: 1.11.4`） |

### Obsidian 真机 Web Worker WASM 实测基准（M0、M1 与 M2 门禁已通过 · 2026-11-22）

实测环境：**Apple M2 Max macOS `27.2.1`（32 GB 内存）、真实 Obsidian `1.15.1`（`Electron 43.8.9` / `Chromium 150.0.7871.250`）渲染进程隔离 `MEMFS` Web Worker、`sherpa-onnx@2.0.2` WASM、连续 15 分钟（60 轮中英混说语料）会话及 M1 插件端到端离线听写验收**（完整记录见 [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md)）：

| WASM 引擎 / 模型 | 冷加载耗时 | RTF（实时率） | 常驻 RSS 增量 | 定位 |
| --- | ---: | ---: | ---: | --- |
| `Silero VAD` | `30 ms` | — | 含于下方同 Worker | 端点检测与打断 VAD |
| `SenseVoice int8` | `485 ms` | `0.215`（15m 均值） | 稳态 `+348.7 MB`（峰值 `+527.5 MB`，WASM 堆恒定 `512 MB`） | M1 桌面单模型离线听写 |
| `Zipformer2` | `1,939 ms`（Node 参考） | `0.259` | `463 MB`（Node 参考） | 可选流式识别 / Wave 3 `voice-daemon` |
| `VITS`（`vits-zh-ll`） | `391 ms` | `1.268` | 80 句稳态 `438 MB` | M2 桌面显式可选离线 TTS（`#3960` 未修，Kokoro 留归 Wave 3 `voice-daemon`） |

---

## 平台支持与移动端降级策略

| 平台 | 目标定位 | 运行策略 |
| --- | --- | --- |
| **桌面端**（macOS / Windows / Linux，Obsidian `>= 1.11.4`） | 主力端（macOS M0–M6 已实测通过，含 `voice-daemon` 联调 E2E） | 支持 Web Worker 离线 WASM 听写（`SenseVoice WASM`）、多引擎朗读（系统语音、可选离线 `vits-wasm` / 本机 `kokoro-daemon`、BYOK `openai-compat` / 实网 `mimo`）+ 原生 AEC3 外放打断，以及可选 BYOK 选区/笔记语音问答（`VoiceQaModal`）、4 层防幻觉润色与 `openai-compat` / `daemon` 转写 |
| **移动端**（iOS / Android，Obsidian `>= 1.11.4`） | 优雅降级（`isDesktopOnly: false`，已通过 Android 15 AVD 模拟器 `Obsidian 1.15.1` APK 与 Xcode `iOS 27.0` Simulator `WKWebView` 测试基座验证） | `Platform.isMobile` 下禁用 200 MB+ 本地 WASM 模型以降低内存压力；受测 iOS `WKWebView` 提供 `speechSynthesis`（`68` 音色），Android System WebView（`124.0`）原生无 `window.speechSynthesis`（友好提示启用 BYOK TTS，同时保留 `webkitSpeechRecognition`），受 `allowCloudFallbackOnMobile`（默认 `false`）门控 |

> **移动端听写为有条件能力**：仅当移动 WebView 暴露 `SpeechRecognition` 且系统语音服务可用时生效；本地 WASM 听写模型与本机 `voice-daemon` 在移动端按设计禁用。实体手机验证尚未完成，因此不宣称移动端听写已验证——离线听写请使用桌面端。

### 表达力能力披露

能力来自 `@voice-mode/core` 的表达力契约；不支持的表达面会明确降级提示，不会被静默丢弃。

| 引擎 | 音色 | 语速 | 停顿 | 耳语 | 情感 |
| --- | --- | --- | --- | --- | --- |
| `system` | 宿主提供 | 支持 | 分段模拟 | 剥离 | 剥离 |
| `vits-wasm` | 5 | 支持 | 分段模拟 | — | — |
| `kokoro-daemon` | 103 | 支持 | 原生 `<break Nms>`（≤5000ms） | 原生（×0.5 增益） | — |
| `openai-compat` | 取决于服务商 | 支持 | 取决于服务商 | 取决于服务商 | 指令（取决于服务商） |
| `mimo` | 9 | 支持 | 取决于服务商 | 取决于服务商 | 指令 |

表达标签（`<slow>`/`<fast>`/`<whisper>` 等）由 `@voice-mode/core` 解析并声明降级语义；**当前版本 Obsidian 界面尚未把标签接入引擎生效**（按普通文本朗读，标签本身不会被念出）。

---

## 隐私边界、外部网络与模型来源披露

各功能使用的数据和网络端点如下（详见 [SECURITY.md](SECURITY.md)）：

1. **零遥测与零静默外联**：不收集任何使用统计、崩溃上报或行为埋点；插件启动时不发起任何网络请求。
2. **听写、朗读与语音问答的数据去向**：
   - 桌面端开启 `SenseVoice WASM` 后，「开始或停止听写」和「听写一句话」在隔离 Web Worker 中 100% 本地离线运行，识别过程在本机完成；仅在显式选用 `openai-compat` 时将切分后的 16 kHz WAV 上传至用户配置的 `/audio/transcriptions` 端点；若保持「系统语音识别」，仅在宿主暴露原生 `SpeechRecognition` 时兜底（无内置 Google Speech Key 的桌面 Electron 不可用，插件会提示切换至 `SenseVoice WASM`；在支持的浏览器/WebView 下音频由宿主发往对应浏览器/系统语音服务商）；
   - 「朗读选中文本或当前笔记」默认调用宿主 `window.speechSynthesis`，并支持桌面可选 100% 本地离线 `VITS WASM` 或用户显式配置的 BYOK `OpenAI 兼容` / `MiMo` 云端朗读；
   - 「就选中文本或当前笔记向 AI 提问」与「听写后用 AI 润色」**默认关闭**（`enableVoiceQa: false`、`enableLlmPolish: false`），仅在用户显式开启后才将当前选区（或上限 `24,000` 字符的当前笔记）与问题，或单句待 4 层防幻觉润色的转写文本发往用户配置的模型端点。
3. **模型下载完全由用户显式触发（桌面端，M1/M2）**：
   - 桌面离线模型仅在用户在设置页点击下载后从公开白名单 HTTPS 源拉取：语音权重（`Silero VAD`、`SenseVoice int8`、可选 `VITS`）走 `https://huggingface.co` 或可选国内镜像 `https://hf-mirror.com`，`sherpa-onnx@2.0.2` WASM 运行时（`Apache-2.0`）走 `https://registry.npmjs.org` 或 `https://registry.npmmirror.com`（`cdn.npmmirror.com`），支持断点续传和备用镜像，逐文件按固定 **SHA256** 与重定向域名白名单校验；
   - 全部模型与运行时（听写栈 `245.3 MB`；可选 VITS 朗读包 `116.1 MB`）保存在 **Vault 之外**的操作系统应用缓存目录（macOS/Linux `~/.cache/voice-mode/models/`，Windows `%LOCALAPPDATA%\voice-mode\models\`，或经校验位于 Vault 外的自定义路径），绝不污染 `.obsidian/`、Obsidian Sync、iCloud 或个人 Git 仓库。
4. **可选 BYOK 云端接口（BYOK TTS、LLM 问答、4 层润色与转写在 M2/M3 中实现，均默认关闭/按需启用）**：
   - 仅当用户主动配置服务商并启用对应能力（`/audio/speech`、`/audio/transcriptions`、`/chat/completions`、`/messages`、本地回环 Ollama / LM Studio 或小米 `MiMo` `https://api.xiaomimimo.com/v1/chat/completions`）时，才由客户端直连目标端点，无任何开发者中转服务器；移动端默认关闭非回环云端请求（需开启「允许在移动端使用云服务回退」）；
   - 所有 API Key 仅存放在 Obsidian 官方 `app.secretStorage`（`>= 1.11.4`），**绝不明文写入 `data.json`**；携带鉴权头的请求强制 `redirect: 'error'`，错误日志先脱敏后截断。
5. **系统权限**：仅在用户主动开启听写或外放打断监听时申请麦克风权限。
6. **许可证隔离**：本仓库代码采用 MIT 许可证；仓库与 GitHub Release **严禁打包**任何模型权重或 GPL-3.0 `espeak-ng-data` 音素数据，运行时独立下载的模型资产保留各自上游许可证（SenseVoice 为 FunAudioLLM，`sherpa-onnx` / Kokoro 为 Apache-2.0，`espeak-ng-data` 为 GPL-3.0）。

   - **关于可选中文 VITS 模型（`vits-zh-ll`）**：其 Hugging Face 模型卡（`csukuangfj/vits-zh-ll`）未声明许可；sherpa-onnx 生态实践中按 Apache-2.0 使用，但上游未书面确认——如你需要许可明确的引擎，请改用系统语音、`kokoro-daemon` 或 BYOK 服务商。

---

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 朗读没有声音 | 检查系统音量与「设置 → 语音输入/朗读」中选择的引擎；Android WebView 无系统语音时请改用 BYOK 朗读服务商。 |
| 听写启动但没有文字 | 授予麦克风权限；移动端本地 WASM 模型按设计禁用，请使用浏览器识别或云端转写端点。 |
| 模型下载失败/卡住 | 重试、把「模型下载主机」切换为镜像（`hf-mirror.com`），或清除缓存后重新下载。 |
| BYOK 请求失败 | 检查端点 URL、已保存密钥（SecretStorage）与服务商 CORS；本机回环地址允许 `http://`。 |
| `kokoro-daemon` 请求失败 | 确认守护进程已运行（`voice-daemon models status`）且令牌文件存在；插件会在 1 秒内回退系统语音。 |
| 提交问题 | 先运行「查看语音运行状态 / 复制语音运行状态」并把快照贴进 issue。 |

## 本地开发与验证

需 **Node.js `>= 22.18.0`**（三包单测依赖 Node 原生 type-stripping 直接导入 `.ts`；CI 使用 Node 22）与 **`pnpm@12.21.0`**：

```bash
pnpm install --frozen-lockfile
pnpm run check:all
```

`pnpm run check:all` 会先编译共享包，再依次执行 `typecheck`、`lint`（含 `eslint-plugin-obsidianmd`）、`test`、`build` 与 `check:release`。开发规范见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CONTEXT.md](CONTEXT.md)。

---

## 路线图与开源语音矩阵

- **M0（已完成 · 2026-11-22）**：Obsidian `1.15.1`（`Electron 43.8.9`）真机通过全部 6 项开工前 Spike（Worker WASM 15 分钟内存/RTF、Vault 外缓存隔离、Copilot `4.0.20` Lexical 侧栏注入、API CORS 与回环 SSE 矩阵、`sherpa-onnx@2.0.2` `#3960`/`#1939` 复验、原生 AEC3 与 `SecretStorage` 探针）。
- **M1（已完成 · 2026-11-22）**：桌面离线 WASM 听写（`Silero VAD` + `SenseVoice int8`）、Vault 外 SHA256 模型管理器、个人纠错词表 UI、主编辑器与 Copilot Lexical 侧栏注入。
- **M2（已完成 · 2026-11-22）**：Markdown/表格降噪按句朗读、悬浮字幕字号/宽度档位与暂停/跳句/停止交互、可选离线 `vits-wasm` / BYOK TTS（`openai-compat`、`mimo`）及原生 AEC3 外放打断（`180 s` 零自打断压测，`66–370 ms` 语音打断）与 `manual` 兜底。
- **M3 与 M4（已完成封版准备 · 2026-11-22）**：基于 `SecretStorage` 的可选 BYOK 选区/笔记语音问答（`VoiceQaModal`）、听写后 4 层防幻觉润色（`enableLlmPolish`）、`openai-compat` `/audio/transcriptions` 转写（`CloudDictationSession`）、`< 1s` `DaemonClient` 接缝、401/500 密钥脱敏审计、桌面 4 项声学必过门禁（`A-1`–`A-4`）、实网 `MiMo` 朗读验收、全新空库 / `BRAT 2.2.0` 双冒烟及 Android 15 AVD 模拟器（`Obsidian 1.15.1` APK，System WebView `124.0`）+ Xcode `iOS 27.0` Simulator `WKWebView` 测试基座 `M-1`–`M-5` 验证（该次构建记录为 `284.13 KB`、`166` 项单测）。
- **Wave 2（`M5` · 验收记录 · 2026-11-22）**：[`sillytavern-voice-mode`](https://github.com/qishuilalala/sillytavern-voice-mode)（当次验收提交 `b792551`）——SillyTavern `1.19.1` 全双工情感语音扩展，复用 `75.05%` `@voice-mode/{core,browser}@0.1.0`（`firstSentenceLeadMs = 341 ms`、`20/20` 原生 AEC3 `detect` 外放语音打断 + `stopGeneration()` 均值 `205 ms < 600 ms`、角色 `voiceMap` 抽屉、跨句 `<whisper>` 情感 DSL 与可选 SSRF 加固服务端插件）。
- **Wave 3（`M6` · 验收记录 · 2026-11-22）**：[`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon)（当次验收提交 `29ca1f9`）——`@voice-mode/daemon`（`127.0.0.1:18790`、`sk-vmd-` 192-bit `0o600` Bearer 鉴权 + `Host`/`Origin` 白名单，原生 `sherpa-onnx-node` 解锁 `Kokoro 103` 音色 + `Zipformer2` + `SenseVoice`）与零 `<all_urls>` 权限的 Chrome/Edge MV3 `@voice-mode/browser-extension`（已在真实 Obsidian `1.15.1` + Chrome `159` 完成联调 E2E：单份常驻模型 `modelInstanceCount = 1` 共享 `622.7 MB` RSS、`<whisper>` + `<break 250ms>` `24 kHz` WAV 朗读、`daemon` ASR 转写 `631 ms`、停掉守护进程 `3 ms < 1,000 ms` 自动回退），并完成 [`dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode) 内核反哺收敛（净删 `725` 行重复代码，`110/110` 测试文件全绿）。

完整规划与架构依据见 [docs/plan/master-plan.md](docs/plan/master-plan.md) 与 [docs/adr/README.md](docs/adr/README.md)。

## 许可证

[MIT](LICENSE) © 2026 qishuilalala
