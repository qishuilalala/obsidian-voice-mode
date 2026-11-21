# obsidian-voice-mode — 开发者上下文（CONTEXT）

> **身份与约束**：本文件为新会话的当前心智模型，按现状重写维护、不追加流水账，**严格保持 ≤ 110 行**。阶段进度与待办以 [docs/rules/STATE.md](docs/rules/STATE.md) 为准，完整路线图见 [docs/plan/master-plan.md](docs/plan/master-plan.md)，架构依据见 [docs/adr/README.md](docs/adr/README.md)。

## 项目定位与当前阶段

- **产品**：Obsidian 官方插件（ID `voice-mode`，Repo `qishuilalala/obsidian-voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`），也是跨平台 Voice Mode 系列开源矩阵的首发母仓。
- **当前真实状态（`0.1.0` · M0、M1 与 M2 已实测闭环，进入 M3 研发）**：已完成三包 Monorepo 基建、**M0 6 项真机 Spike**、**M1 桌面离线 WASM 听写闭环**与 **M2 Markdown/表格降噪按句朗读 + 悬浮字幕档位/播控 + 可选离线 `vits-wasm` / BYOK TTS + 原生 AEC3 外放语音打断闭环**（`main.js` 仅 `213.1 KB`，全仓 115 项单测全绿）。下一步推进 **M3**（基于 `SecretStorage` 的 BYOK 语音问答与 4 重护栏润色 UI、移动端降级实测与 4 项发版声学门禁）。

## 三包架构与硬依赖边界

| Workspace 包 | 职责 | 严格禁止导入（ESLint + `check-release-gate.mjs` 双守卫） |
| --- | --- | --- |
| `packages/voice-core`（`@voice-mode/core`） | 零依赖纯 TS 内核：Markdown/表格分句（`segmenter`）、纠错词表（`asr-replacements`）、情感 DSL（`emotion`）、固定 SHA256 模型清单与 USTAR 解包器（`model-manifest`）、`OpenAiCompatTtsEngine` / `MimoTtsEngine` + `sniffAudioMime`（`tts-engines`）、密钥脱敏（`redact`）与双协议 BYOK `llm-router` | 零第三方运行时依赖；禁 `obsidian`、`electron`、`@deepseek-ai/*`、所有 `node:*`/Node 内置模块及 DOM 全局变量 |
| `packages/voice-browser`（`@voice-mode/browser`） | 浏览器/Electron 音频与 Worker 运行时：16 kHz `AudioWorklet`、重采样、AEC3 探针与 `AecBargeInMonitor`、支持暂停/跳句的 `PlaybackQueue`、`MEMFS` Sherpa 客户端、`VitsWasmTtsEngine` 与离线听写会话（`dictation-session`） | 禁 `obsidian`、`electron`、`@deepseek-ai/*`、Node 内置模块 |
| `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`） | 极薄 Obsidian 适配层（含 `desktop-fs`、`model-manager`、`obsidian-http` CORS 兜底、`speech-player`、`editor-bridge`），经 `esbuild.config.mjs` 打包为根目录 `main.js`（不入 Git） | 禁静态导入 `electron` / `node:*`；禁 `innerHTML` / `outerHTML` / `document.write` / `eval` / `new Function`；须全绿通过 `eslint-plugin-obsidianmd` |

## 核心架构不变量

1. **双模运行时与单重模型互斥（ADR-0002）**：桌面默认走零外置 `MEMFS` Web Worker WASM，`workerClient` 严格执行 `SenseVoice int8` 与 `VITS` 互斥（峰值仅常驻 1 个重模型 `< 700 MB`），而 `AecBargeInMonitor` 使用独立轻量 `bargeInWorkerClient`（仅挂载 `1.8 MB` `Silero VAD`）防止被 `VITS` 句间预合成阻塞；Wave 3 可选 `voice-daemon` 解锁 Kokoro 103 音色。
2. **移动端降级红线**：`isDesktopOnly: false`，但运行时按 `Platform.isMobile` 强制屏蔽 200 MB+ 本地 WASM 模型以防 iOS WKWebView（~500 MB Jetsam）闪退，降级为 BYOK API + 系统语音。
3. **声学与打断兜底**：仅在原生 AEC3 生效**且音频经 Chromium 渲染混音器输出（`HTMLAudioElement`）**时才开启 `AecBargeInMonitor`（强制 `autoGainControl: false`）；系统 `speechSynthesis`（走 OS 独立守护进程无参考流）或 AEC 失效时强制锁定 `bargeInMode=manual`；严禁内置逆向 Edge Read Aloud 私有 WebSocket。
4. **Markdown 朗读降噪与全场景注入**：`segmenter` 剥离 YAML Frontmatter、代码围栏、数学块、裸 URL、Callout 与管道表格；`editor-bridge` 优先经 CM6 写入当前笔记，对第三方富文本侧栏（如 Copilot Lexical）派发内存态合成 `ClipboardEvent("paste")`。
5. **诚实宣称与真机门禁**：单测绿灯不代表声学或真实模型推理等价；任何发版均须实跑 [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) 的真机门禁。

## 安全与 Obsidian 商店合规红线

- **密钥隔离与 CORS 安全兜底（ADR-0003）**：全量 BYOK 密钥仅经 Obsidian `app.secretStorage`（`>= 1.11.4`）按预设/引擎隔离存储，**绝不写入 `data.json`**；`obsidian-http.ts` 优先走 `fetch`（`redirect: 'error'`），遇 `app://obsidian.md` CORS 拦截时桌面端回退零重定向 Node 流、移动端回退 `requestUrl`；错误体先脱敏再截断。
- **Sync 体积与模型隔离（ADR-0004）**：`main.js` 硬上限 `< 5 MB`（当前 `213.1 KB`）；离线模型仅由用户显式点击下载，经逐跳 HTTPS 域名白名单 + 固定 SHA256 校验 + tar 路径穿越/链接拦截，落盘于 **Vault 之外**（`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`）。
- **许可证纯净**：MIT 仓库与 GitHub Release **严禁打包**任何模型权重、WASM 大二进制或 GPL-3.0 `espeak-ng-data`；零遥测、零启动外联。
- **发布格式**：Tag 严禁带 `v` 前缀（如 `0.1.0`），与 `manifest.json`、`package.json`、`versions.json` 及 `CHANGELOG.md` 强对齐；Release 仅上传 `main.js`、`manifest.json`、`styles.css`。

## 常用命令

```bash
pnpm install --frozen-lockfile  # 安装锁定依赖（Node >= 22.18.0，CI 固定 Node 22 + pnpm@12.21.0）
pnpm run typecheck              # 三包严格 TypeScript 类型检查
pnpm run lint                   # ESLint（含 eslint-plugin-obsidianmd 与跨包边界规则）
pnpm run test                   # 三包 Node 内置测试套件（115 项单测，原生 type-stripping 直导 .ts）
pnpm run build                  # esbuild 生产打包生成根目录 main.js
pnpm run check:release          # 清单/版本/体积/边界/密钥与卫生全检
pnpm run check:all              # 以上五项完整顺序执行（PR 与发版前必跑）
```

## 关键入口索引

| 文档 | 用途 |
| --- | --- |
| [docs/rules/STATE.md](docs/rules/STATE.md) | 当前阶段恢复点：精确区分已落地与未实现能力 |
| [docs/plan/master-plan.md](docs/plan/master-plan.md) | 实测基准、三波开源矩阵（Obsidian → SillyTavern → Daemon/扩展）与 M0–M6 规划 |
| [docs/adr/README.md](docs/adr/README.md) | ADR-0001 ~ 0004 架构决策记录 |
| [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) | M0/M1/M2 真机实测报告、发版 4 项声学必过门禁与移动端降级表 |
| [docs/distribution/launch-playbook.md](docs/distribution/launch-playbook.md) | `obsidian-releases` 提审排雷、15 秒 Demo 分镜与首发增长排期 |
| [SECURITY.md](SECURITY.md) | 隐私数据流、`SecretStorage` 边界、模型 SHA256 与 GPL 隔离声明 |
