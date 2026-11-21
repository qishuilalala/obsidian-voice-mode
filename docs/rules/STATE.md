# 当前恢复点（STATE · 2026-11-21）

> 本文件为唯一任务恢复点，按现状重写维护、**严格保持 ≤ 120 行**，不追加流水账。严禁将尚未通过真机验证的规划能力写成“已完成”。

## 当前基线版本

- **版本基线**：`0.1.0`（Alpha 架构初始化阶段；尚未推送正式发布 Tag，尚未向 `obsidianmd/obsidian-releases` 提审）。
- **仓库身份**：`qishuilalala/obsidian-voice-mode`（Obsidian 插件 ID `voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`）。
- **工具链锁定（锁文件实测）**：`obsidian@1.14.4`、`eslint-plugin-obsidianmd@0.6.0`、`esbuild@0.25.12`（`^0.25.0`）、`typescript@5.9.3`（`^5.8.0`）、Node `>= 22.18.0`（单测直导 `.ts`，CI 固定 Node 22 + `pnpm@12.21.0`）。

## 已落地 vs 尚未实现（诚实边界）

### 已落地（`0.1.0` 架构初始化阶段）

1. **三包 Monorepo 与构建/合规门禁**：
   - `pnpm-workspace.yaml`、`tsconfig.base.json`、`esbuild.config.mjs`（打包至根目录 `main.js`）、`eslint.config.mjs`（含 `eslint-plugin-obsidianmd` 与跨包导入红线）；
   - `manifest.json`、`versions.json`、`styles.css`、`scripts/check-release-gate.mjs`、`scripts/version-bump.mjs`。
2. **共享核心、音频契约与插件骨架**：
   - `packages/voice-core`（`@voice-mode/core`）：零依赖纯模块（`segmenter`、`asr-replacements`、`emotion`、`engine-kind`、`voice-catalog`、`redact`、`contracts`、`llm-router`）；
   - `packages/voice-browser`（`@voice-mode/browser`）：浏览器/Electron 音频契约（`audio-worklet-source`、`resample`、`aec-probe`、`playback-queue`、`worker-protocol`）；
   - `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`）：插件骨架、设置面板、状态条、字幕浮层与运行时守卫（`runtime-guard`）；已注册 4 条命令——其中「朗读选区/笔记」已提供零配置系统 `speechSynthesis` 预览，「切换听写」在 M1 离线 WASM 落地前仅在宿主浏览器支持原生 `SpeechRecognition` 时作为占位兜底（无内置 Google Speech Key 的桌面 Electron 不可用，且在支持的浏览器/WebView 下会将语音发往对应浏览器/系统语音服务商）。
3. **治理、CI/CD 与增长资产**：
   - `.github/workflows/ci.yml`（Ubuntu/macOS/Windows 三端矩阵 + `audit`）、`.github/workflows/release.yml`（无 `v` 前缀 Tag 与 `CHANGELOG.md` 字面校验 + 5 MB 体积门 + 仅上传 3 个合规附件）、Issue/PR 模板；
   - `CONTEXT.md`、`docs/plan/master-plan.md`、ADR `0001`–`0004`、`docs/qa/acceptance-checklist.md`、`docs/distribution/launch-playbook.md`、`README.md`、`README.zh-CN.md`、`SECURITY.md`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、`LICENSE`。

### 尚未实现 / 待 M0–M3 落地（当前不可用于离线听写）

- **M0（阻断下一步）**：6 项真机 Spike 均处于 `Pending`（Obsidian 桌面端 Installer 1.14.4 / Electron 43.7.5 与 Installer 1.15.1 / Electron 43.8.9 内 Web Worker WASM 内存/RTF、Vault 外缓存与 Sync 隔离、Copilot 侧栏注入、国产 API CORS 实测、`sherpa-onnx` `#3960`/`#1939` 核查、AEC3 与移动端探针）。
- **M1**：桌面本地离线 WASM 听写（`Silero VAD` + `SenseVoice int8`）、Vault 外 SHA256 模型下载器、纠错词表完整闭环、编辑器与第三方侧栏聚焦注入。
- **M2**：Markdown/表格按句流式朗读与可选离线 TTS、悬浮字幕条完善、AEC3 外放打断。
- **M3**：BYOK 语音问答与润色 UI、`SecretStorage` 实机验证、iOS/Android 移动端降级实测、发版前 4 项真机声学必过门禁。
- **M4–M6**：`obsidian-releases` 提审上架、Wave 2 `sillytavern-voice-mode`、Wave 3 统一本机 `voice-daemon` 与 Chrome/Edge 扩展。

## 当前首要下一步（Next Action）

1. 复核 `0.1.0`（Alpha 架构初始化阶段）全量本地门禁（`pnpm run check:all` 全绿）。
2. 启动 **M0 6 项真机 Spike**，在真实桌面版 Obsidian（Installer 1.14.4 / Electron 43.7.5 与 Installer 1.15.1 / Electron 43.8.9）及移动设备中实测并把真实数据填入 [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md)。
3. 仅在 M0 全部通过（或确认回退架构并更新 ADR）后，启动 M1 离线 WASM 听写实现。

## 维护者与安全边界

- **真机验收不可跳过**：任何音频采集、朗读、打断或模型推理能力在通过真机检查前不得移除 Alpha / 计划中标识。
- **凭证与缓存红线**：严禁提交 API Key、私人录音、模型二进制或生成产物 `main.js` 到公开仓库。

## 关键入口

| 入口 | 说明 |
| --- | --- |
| [CONTEXT.md](../../CONTEXT.md) | 核心不变量、三包边界与常用命令 |
| [docs/plan/master-plan.md](../plan/master-plan.md) | 完整实测基准与 M0–M6 里程碑规划 |
| [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md) | M0 Spike、4 项真机声学门禁与移动端降级清单 |
| [docs/adr/README.md](../adr/README.md) | 架构决策记录（0001–0004） |
| [docs/distribution/launch-playbook.md](../distribution/launch-playbook.md) | 官方提审排雷、15 秒 Demo 与首发推广策略 |
