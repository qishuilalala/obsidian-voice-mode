# obsidian-voice-mode — 开发者上下文（CONTEXT）

> **身份与约束**：本文件为新会话的当前心智模型，按现状重写维护、不追加流水账，**严格保持 ≤ 110 行**。阶段进度与待办以 [docs/rules/STATE.md](docs/rules/STATE.md) 为准，完整路线图见 [docs/plan/master-plan.md](docs/plan/master-plan.md)，架构依据见 [docs/adr/README.md](docs/adr/README.md)。

## 项目定位与当前阶段

- **产品**：Obsidian 官方插件（ID `voice-mode`，Repo `qishuilalala/obsidian-voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`），也是跨平台 Voice Mode 系列开源矩阵的首发母仓。
- **当前真实状态（`0.1.0` · M0–M4 本机与移动模拟器全闭环封版就绪，遵守“先不发”暂未推公开 Tag / PR）**：已完成三包编译产物与治理体系（`T1`）、桌面离线 WASM 听写（`M1`）、Markdown/表格降噪朗读 + 原生 AEC3 打断（`M2`）、BYOK 流式问答 + 4 重护栏润色 + 云端 ASR + 声学/脱敏门禁（`M3`），以及 **Android 15 AVD 模拟器（`Obsidian 1.15.1` APK，System WebView `124.0`）`M-1`–`M-5` 验证 + Xcode `iOS 27.0` Simulator `WKWebView` 测试基座验证 + 实网 `MiMo` TTS 验证 + 全新空 Vault / `BRAT 2.2.0` 双冒烟 + 15s 横竖屏有声 Demo 与首发文案包（`T4`）**（`main.js` = `284.13 KB`，`llm-router.ts` `396` 行，全仓 `166` 项单测全绿）。

## 三包架构与硬依赖边界

| Workspace 包 | 职责 | 严格禁止导入（ESLint + `check-release-gate.mjs` 双守卫） |
| --- | --- | --- |
| `packages/voice-core`（`@voice-mode/core`） | 零依赖纯 TS 内核：Markdown/表格分句（`segmenter`）、纠错词表（`asr-replacements`）、情感 DSL 与 Prompt 编译器（`emotion`）、固定 SHA256 模型清单与 USTAR 解包器（`model-manifest`）、`OpenAiCompatAsrTransport`（`asr-engines`）、`OpenAiCompatTtsEngine` / `MimoTtsEngine` + `sniffAudioMime`（`tts-engines`）、`< 1s` 回退 `DaemonClient`（`daemon-client`）、密钥脱敏（`redact`）与 `< 400` 行双协议 BYOK `llm-router` | 零第三方运行时依赖；禁 `obsidian`、`electron`、`@deepseek-ai/*`、所有 `node:*`/Node 内置模块及 DOM 全局变量 |
| `packages/voice-browser`（`@voice-mode/browser`） | 浏览器/Electron 音频与焦点注入层：16 kHz `AudioWorklet`、重采样、AEC3 探针与 `AecBargeInMonitor`、支持暂停/跳句的 `PlaybackQueue`、`MEMFS` Sherpa 客户端、`VitsWasmTtsEngine`、离线听写（`dictation-session`）、零 WASM `CloudDictationSession` 与通用焦点注入器（`FocusTextInjector`） | 禁 `obsidian`、`electron`、`@deepseek-ai/*`、Node 内置模块 |
| `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`） | 极薄 Obsidian 适配层（含 `desktop-fs`、`model-manager`、`obsidian-http` CORS 兜底、`speech-player`、`voice-qa-modal`、`editor-bridge`），经 `esbuild.config.mjs` 打包为根目录 `main.js`（不入 Git） | 禁静态导入 `electron` / `node:*`；禁 `innerHTML` / `outerHTML` / `document.write` / `eval` / `new Function`；须全绿通过 `eslint-plugin-obsidianmd` |

## 核心架构不变量

1. **双模运行时与单重模型互斥（ADR-0002 / ADR-0005）**：桌面默认走零外置 `MEMFS` Web Worker WASM，`workerClient` 严格执行 `SenseVoice int8` 与 `VITS` 互斥（切听写时立即卸载阻塞中的 VITS Worker），`AecBargeInMonitor` 使用独立轻量 `bargeInWorkerClient`（`1.8 MB` `Silero VAD`）；桌面可选连接本机 `voice-daemon`（`< 1s` 探测失败自动回退本地 WASM / 系统语音）。
2. **移动端降级与 WebView 差异守卫**：`isDesktopOnly: false`；`Platform.isMobile` 下强制屏蔽 200 MB+ 本地 WASM 模型以防 iOS `WKWebView`（~500 MB Jetsam）闪退，远程云端请求受 `allowCloudFallbackOnMobile`（默认 `false`）门控；iOS `WKWebView` 具备原生 `speechSynthesis`，而 Android 系统 WebView 原生不含 `window.speechSynthesis`，可开启 BYOK TTS 走 `HTMLAudioElement` 朗读。
3. **声学与打断兜底**：仅在原生 AEC3 生效**且音频经 Chromium 混音器输出（`HTMLAudioElement`）**时开启 `AecBargeInMonitor`（强制 `autoGainControl: false`）；系统 `speechSynthesis` 或 AEC 失效时强制锁定 `bargeInMode=manual`；严禁内置逆向 Edge Read Aloud 私有 WebSocket。
4. **Markdown 朗读降噪与全场景注入**：`segmenter` 剥离 YAML Frontmatter、代码围栏、数学块、裸 URL、Callout 与管道表格；`editor-bridge` 优先经 CM6 写入当前笔记，对第三方富文本侧栏（如 Copilot Lexical）经 `FocusTextInjector` 派发内存态合成 `ClipboardEvent("paste")`；`enableLlmPolish` 经 4 层反幻觉护栏校验，任意异常零丢字回退原文。
5. **诚实宣称与真机门禁**：单测绿灯不代表声学或移动硬件等价；实测环境严格区分桌面真机、Android 35 APK、iOS 27 Simulator `WKWebView` 与口袋物理手机，详见 [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md)。

## 安全与 Obsidian 商店合规红线

- **密钥隔离与 CORS 安全兜底（ADR-0003）**：全量 BYOK 密钥仅经 Obsidian `app.secretStorage`（`>= 1.11.4`）按预设/引擎隔离存储，**绝不写入 `data.json`**；`obsidian-http.ts` 优先走 `fetch`（`redirect: 'error'`），遇 `app://obsidian.md` CORS 拦截时桌面端回退零重定向 Node 流、移动端回退 `requestUrl`；错误体先脱敏再截断。
- **Sync 体积与模型隔离（ADR-0004）**：`main.js` 硬上限 `< 5 MB`（当前 `284.13 KB`）；离线模型仅由用户显式点击下载，经逐跳 HTTPS 域名白名单 + 固定 SHA256 校验落盘于 **Vault 之外**（`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`）。
- **许可证纯净与发布格式**：MIT 仓库与 GitHub Release **严禁打包**任何模型权重、WASM 二进制、`.mp4` 视频或 GPL-3.0 `espeak-ng-data`；零遥测、零启动外联；Tag 严禁带 `v` 前缀（如 `0.1.0`），Release 仅上传 `main.js`、`manifest.json`、`styles.css`。

## 常用命令

```bash
pnpm install --frozen-lockfile  # 安装锁定依赖（Node >= 22.18.0，CI 固定 Node 22 + pnpm@12.21.0）
pnpm run build:packages         # 编译 @voice-mode/core 与 @voice-mode/browser 至 dist/*.js + .d.ts
pnpm run typecheck              # 根级与三包严格 TypeScript 类型检查
pnpm run lint                   # ESLint（含 eslint-plugin-obsidianmd 与跨包边界规则）
pnpm run test                   # 三包 Node 内置测试套件（166 项）
pnpm run build                  # esbuild 生产打包生成根目录 main.js
pnpm run check:release          # 清单/版本/体积/边界/密钥与移动净室全检
pnpm run check:all              # 以上完整门禁顺序执行（PR 与发版前必跑）
```

## 关键入口索引

| 文档 | 用途 |
| --- | --- |
| [GLOSSARY.md](GLOSSARY.md) / [CODING_STANDARDS.md](CODING_STANDARDS.md) | 领域词典与主观判断编码/审查规范 |
| [docs/rules/STATE.md](docs/rules/STATE.md) | 当前阶段恢复点：精确区分已落地与未对外发布项 |
| [docs/plan/master-plan.md](docs/plan/master-plan.md) | 实测基准、三波开源矩阵与 M0–M6 规划 |
| [docs/adr/README.md](docs/adr/README.md) | ADR-0001 ~ 0005 架构决策索引 |
| [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) | M0–M4 桌面真机、实网 MiMo、Android 35 APK 与 iOS 27 `WKWebView` 实测报告 |
| [docs/distribution/launch-playbook.md](docs/distribution/launch-playbook.md) / [launch-kit.md](docs/distribution/launch-kit.md) | `obsidian-releases` 提审排雷、15 秒 Demo 分镜与全渠道首发定稿包 |
| [SECURITY.md](SECURITY.md) | 隐私数据流、`SecretStorage` 边界、模型 SHA256 与 GPL 隔离声明 |
