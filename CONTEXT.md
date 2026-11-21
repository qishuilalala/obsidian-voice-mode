# obsidian-voice-mode — 开发者上下文（CONTEXT）

> **身份与约束**：本文件为新会话的当前心智模型，按现状重写维护、不追加流水账，**严格保持 ≤ 110 行**。阶段进度与待办以 [docs/rules/STATE.md](docs/rules/STATE.md) 为准，完整路线图见 [docs/plan/master-plan.md](docs/plan/master-plan.md)，架构依据见 [docs/adr/README.md](docs/adr/README.md)。

## 项目定位与当前阶段

- **产品**：Obsidian 官方插件（ID `voice-mode`，Repo `qishuilalala/obsidian-voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`），也是跨平台 Voice Mode 系列开源矩阵的首发母仓。
- **当前真实状态（`0.1.0` · M0 与 M1 已实测闭环，进入 M2 研发）**：已完成三包 Monorepo 基建、**M0 6 项真机 Spike** 与 **M1 桌面本地离线 WASM 听写闭环**（Vault 外用户显式触发 + SHA256 校验模型管理器、隔离 `MEMFS` Web Worker `Silero VAD` + `SenseVoice int8`、个人纠错词表可视化编辑、含 Lexical 兼容的主编辑器/第三方侧栏注入，`main.js` 仅 `159.4 KB`）。下一步推进 **M2**（Markdown/表格流式朗读、悬浮字幕字号/宽度档位、可选离线 `vits-wasm` / BYOK TTS 与原生 AEC3 外放打断）。

## 三包架构与硬依赖边界

| Workspace 包 | 职责 | 严格禁止导入（ESLint + `check-release-gate.mjs` 双守卫） |
| --- | --- | --- |
| `packages/voice-core`（`@voice-mode/core`） | 零依赖纯 TS 内核：Markdown/表格口语化分句（`segmenter`）、纠错词表（`asr-replacements`）、情感 DSL（`emotion`）、引擎/音色清单、固定 SHA256 模型清单与 USTAR 解包器（`model-manifest`）、密钥脱敏（`redact`）、契约与 `<400` 行双协议 BYOK `llm-router` | 零第三方运行时依赖；禁 `obsidian`、`electron`、`@deepseek-ai/*`、所有 `node:*` 与裸 Node 内置模块 |
| `packages/voice-browser`（`@voice-mode/browser`） | 浏览器/Electron 音频与 Worker 运行时：16 kHz `AudioWorklet`、重采样（`resample`）、AEC3 探针（`aec-probe`）、播放队列（`playback-queue`）、Worker 协议与 `MEMFS` Sherpa 客户端/离线听写会话（`sherpa-worker-*` / `dictation-session`） | 禁 `obsidian`、`electron`、`@deepseek-ai/*`、Node 内置模块 |
| `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`） | 极薄 Obsidian 适配层（含 `desktop-fs` 零拷贝读取与 Vault 外隔离守卫、`model-manager`、`editor-bridge`），经 `esbuild.config.mjs` 打包为仓库根目录 `main.js`（不入 Git） | 禁静态导入 `electron` / `node:*`；禁 `innerHTML` / `outerHTML` / `document.write` / `eval` / `new Function`；须全绿通过 `eslint-plugin-obsidianmd` |

## 核心架构不变量

1. **双模运行时分流（ADR-0002）**：桌面默认走零外置 Web Worker 单模型 WASM（`Silero VAD` + `SenseVoice int8`，强制 `ENVIRONMENT_IS_NODE=false` 隔离 `MEMFS` 且建图后立即 `FS.unlink` 释放重复堆）；Wave 3 可选统一本机 `voice-daemon` 绕开 Electron V8 Memory Cage 与 WASM `#3960` 静音缺陷，解锁 Kokoro 103 音色。
2. **移动端降级红线**：`isDesktopOnly: false`，但运行时按 `Platform.isMobile` 强制屏蔽 200 MB+ 本地 WASM 模型以防 iOS WKWebView（~500 MB Jetsam）闪退，降级为 BYOK API + 系统语音。
3. **声学与打断兜底**：仅在原生 AEC3 生效**且音频经 Chromium 渲染混音器输出（`HTMLAudioElement` / `AudioContext`）**时才允许自动语音打断，且打断采集须置 `autoGainControl: false`；系统 `speechSynthesis`（走 OS 独立守护进程无参考流）或 AEC 失效时强制锁定 `bargeInMode=manual`；严禁内置逆向 Edge Read Aloud 私有 WebSocket。
4. **Markdown 朗读降噪与全场景注入**：`segmenter` 剥离 YAML Frontmatter、代码围栏、数学块、裸 URL、Callout 与管道表格；`editor-bridge` 优先经 CM6 写入当前笔记，对第三方富文本侧栏（如 Copilot Lexical）优先派发内存态合成 `ClipboardEvent("paste")`（零污染系统剪贴板，未拦截时回退 `Range`）。
5. **诚实宣称与真机门禁**：单测绿灯不代表声学或真实模型推理等价；任何发版均须实跑 [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) 的真机门禁。

## 安全与 Obsidian 商店合规红线

- **密钥隔离（ADR-0003）**：全量 BYOK 密钥仅经 Obsidian `app.secretStorage`（`>= 1.11.4`）存储，**绝不写入 `data.json`**；按预设隔离 Key；携带凭据的出站请求强制 `redirect: 'error'`；拒绝含 `user:pass@` 的 `baseUrl`；错误体先脱敏再截断。
- **Sync 体积与模型隔离（ADR-0004）**：`main.js` 硬上限 `< 5 MB`（当前 `159.4 KB`）；离线模型仅由用户显式点击触发下载，经逐跳 HTTPS 域名白名单 + 固定 SHA256 校验 + tar 路径穿越/链接拦截，落盘于 **Vault 之外**的缓存目录（`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`）。
- **许可证纯净**：MIT 仓库与 GitHub Release **严禁打包**任何模型权重、WASM 大二进制或 GPL-3.0 `espeak-ng-data`；零遥测、零启动外联。
- **发布格式**：Tag 严禁带 `v` 前缀（如 `0.1.0`），与 `manifest.json`、`package.json`、`versions.json` 及 `CHANGELOG.md` 强对齐；Release 仅上传 `main.js`、`manifest.json`、`styles.css`。

## 常用命令

```bash
pnpm install --frozen-lockfile  # 安装锁定依赖（Node >= 22.18.0，CI 固定 Node 22 + pnpm@12.21.0）
pnpm run typecheck              # 三包严格 TypeScript 类型检查
pnpm run lint                   # ESLint（含 eslint-plugin-obsidianmd 与跨包边界规则）
pnpm run test                   # 三包 Node 内置测试套件（87 项单测，原生 type-stripping 直导 .ts）
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
| [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) | M0/M1 真机实测报告、发版 4 项声学必过门禁与移动端降级表 |
| [docs/distribution/launch-playbook.md](docs/distribution/launch-playbook.md) | `obsidian-releases` 提审排雷、15 秒 Demo 分镜与首发增长排期 |
| [SECURITY.md](SECURITY.md) | 隐私数据流、`SecretStorage` 边界、模型 SHA256 与 GPL 隔离声明 |
