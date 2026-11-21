# obsidian-voice-mode — 开发者上下文（CONTEXT）

> **身份与约束**：本文件为新会话的当前心智模型，按现状重写维护、不追加流水账，**严格保持 ≤ 110 行**。阶段进度与待办以 [docs/rules/STATE.md](docs/rules/STATE.md) 为准，完整路线图见 [docs/plan/master-plan.md](docs/plan/master-plan.md)，架构依据见 [docs/adr/README.md](docs/adr/README.md)。

## 项目定位与当前阶段

- **产品**：Obsidian 官方插件（ID `voice-mode`，Repo `qishuilalala/obsidian-voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`），也是跨平台 Voice Mode 系列开源矩阵的首发母仓。
- **当前真实状态（`0.1.0` · Alpha 架构初始化阶段）**：已完成三包 Monorepo 基建、纯内核模块、浏览器音频契约、插件骨架与 CI/发布门禁；骨架内「朗读选区/笔记」已提供系统 `speechSynthesis` 预览，「切换听写」在 M1 前仅为宿主原生 `SpeechRecognition` 占位兜底（无内置 Google Speech Key 的桌面 Electron 不可用）。**本地离线 WASM 推理、Vault 外 SHA256 模型下载器与 BYOK 问答界面尚未接入**，开工前须先跑完 M0 6 项真机 Spike。

## 三包架构与硬依赖边界

| Workspace 包 | 职责 | 严格禁止导入（ESLint + `check-release-gate.mjs` 双守卫） |
| --- | --- | --- |
| `packages/voice-core`（`@voice-mode/core`） | 零依赖纯 TS 内核：Markdown/表格口语化分句（`segmenter`）、纠错词表（`asr-replacements`）、情感 DSL（`emotion`）、引擎/音色清单（`engine-kind` / `voice-catalog`）、密钥脱敏（`redact`）、契约与 `<400` 行双协议 BYOK `llm-router` | 零第三方运行时依赖；禁 `obsidian`、`electron`、`@deepseek-ai/*`、所有 `node:*` 与裸 Node 内置模块 |
| `packages/voice-browser`（`@voice-mode/browser`） | 浏览器/Electron 音频契约：16 kHz `AudioWorklet`、重采样（`resample`）、原生 AEC3 探针（`aec-probe`）、播放队列（`playback-queue`）与 Worker 协议（`worker-protocol`） | 禁 `obsidian`、`electron`、`@deepseek-ai/*` |
| `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`） | 极薄 Obsidian 适配层，经 `esbuild.config.mjs` 打包为仓库根目录 `main.js`（不入 Git） | 禁 `innerHTML` / `outerHTML` / `document.write` / `eval` / `new Function`；须全绿通过 `eslint-plugin-obsidianmd` |

## 核心架构不变量

1. **双模运行时分流（ADR-0002）**：桌面默认走零外置 Web Worker 单模型 WASM（`Silero VAD` + `SenseVoice int8`）保住首装转化；Wave 3 可选统一本机 `voice-daemon`（`127.0.0.1` + Bearer Token + Origin 白名单）绕开 Obsidian 桌面端（Installer 1.14.4 / Electron 43.7.5 与 Installer 1.15.1 / Electron 43.8.9）V8 Memory Cage（`sherpa-onnx-node` 报 `External buffers are not allowed`）与 WASM `#3960` 静音缺陷，解锁 Kokoro 103 音色。
2. **移动端降级红线**：`isDesktopOnly: false`，但运行时按 `Platform.isMobile` 强制屏蔽 200 MB+ 本地 WASM 模型以防 iOS WKWebView（~500 MB Jetsam）闪退，降级为 BYOK API + 系统语音。
3. **声学与打断兜底**：原生 AEC3 生效才启用自动语音打断，失效或外放异常时自动回退 `bargeInMode=manual`；严禁内置逆向 Edge Read Aloud 私有 WebSocket。
4. **Markdown 朗读降噪**：`segmenter` 剥离 YAML Frontmatter、代码围栏（```` ``` ```` / `~~~`）、数学块（`$$...$$`）、裸 URL、Obsidian Callout 标记与 Markdown 管道表格，并将内联代码与 Wikilink 语法清理为自然口语文本，不依赖外部 System Prompt。
5. **诚实宣称与真机门禁**：单测绿灯不代表声学或真实模型推理等价；任何发版均须实跑 [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) 的真机门禁。

## 安全与 Obsidian 商店合规红线

- **密钥隔离（ADR-0003）**：全量 BYOK 密钥仅经 Obsidian `app.secretStorage`（`>= 1.11.4`）存储，**绝不写入 `data.json`**；按预设隔离 Key；携带凭据的出站请求强制 `redirect: 'error'`；拒绝含 `user:pass@` 的 `baseUrl`；错误体先脱敏再截断。
- **Sync 体积与模型隔离（ADR-0004）**：`main.js` 硬上限 `< 5 MB`（目标 `< 1 MB`）；离线模型仅由用户显式点击触发下载，经 HTTPS 白名单 + 固定 SHA256 校验，落盘于 **Vault 之外**的缓存目录（`~/.cache/voice-mode/models/` / `%LOCALAPPDATA%\voice-mode\models\`）。
- **许可证纯净**：MIT 仓库与 GitHub Release **严禁打包**任何模型权重、WASM 大二进制或 GPL-3.0 `espeak-ng-data`；零遥测、零启动外联。
- **发布格式**：Tag 严禁带 `v` 前缀（如 `0.1.0`），与 `manifest.json`、`package.json`、`versions.json` 及 `CHANGELOG.md` 强对齐；Release 仅上传 `main.js`、`manifest.json`、`styles.css`。

## 常用命令

```bash
pnpm install --frozen-lockfile  # 安装锁定依赖（Node >= 22.18.0，CI 固定 Node 22 + pnpm@12.21.0）
pnpm run typecheck              # 三包严格 TypeScript 类型检查
pnpm run lint                   # ESLint（含 eslint-plugin-obsidianmd 与跨包边界规则）
pnpm run test                   # 三包 Node 内置测试套件（原生 type-stripping 直导 .ts）
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
| [docs/qa/acceptance-checklist.md](docs/qa/acceptance-checklist.md) | M0 6 项真机 Spike、发版 4 项声学必过门禁与移动端降级表 |
| [docs/distribution/launch-playbook.md](docs/distribution/launch-playbook.md) | `obsidian-releases` 提审排雷、15 秒 Demo 分镜与首发增长排期 |
| [SECURITY.md](SECURITY.md) | 隐私数据流、`SecretStorage` 边界、模型 SHA256 与 GPL 隔离声明 |
