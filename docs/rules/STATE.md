# 当前恢复点（STATE · 2026-11-22）

> 本文件为唯一任务恢复点，按现状重写维护、**严格保持 ≤ 120 行**，不追加流水账。严禁将尚未通过真机验证的规划能力写成“已完成”。

## 当前基线版本

- **版本基线**：`0.1.0`（**M0 6 项真机 Spike**、**M1 桌面离线 WASM 听写闭环**、**M2 朗读/字幕/多 TTS 引擎/原生 AEC3 打断闭环**与 **M3 BYOK 语音问答/4 重护栏润色/云端 ASR/桌面四项发版声学与脱敏门禁**均已在真实 Obsidian `1.15.1` 验收通过；iOS/Android 移动物理设备实机验证 `M-1`–`M-5` 与用户自有云端付费 Key 复核待完成后进入 **M4** 正式打 Tag 提审）。
- **仓库身份**：`qishuilalala/obsidian-voice-mode`（Obsidian 插件 ID `voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`）。
- **工具链与真机宿主基线**：`obsidian@1.14.4`（类型）、`eslint-plugin-obsidianmd@0.6.0`、`esbuild@0.25.12`、`typescript@5.9.3`、Node `>= 22.18.0`；本机实测真机为 macOS `27.2.1`（Apple M2 Max / 32 GB）上的 **Obsidian `1.15.1`（Electron `43.8.9` / Chromium `150.0.7871.250`）**；当前构建产物 `main.js` 为 **`261.94 KB`**，`llm-router.ts` **`395` 行**（`< 400` 行预算），全仓 **147 项单测**全绿。

## 已落地 vs 尚未实现（诚实边界）

### 已落地

1. **三包 Monorepo 与构建/合规门禁**：
   - `pnpm-workspace.yaml`、`tsconfig.base.json`、`esbuild.config.mjs`、`eslint.config.mjs`（含 `eslint-plugin-obsidianmd` 与跨包导入红线）、`scripts/check-release-gate.mjs`、三端 CI 与合规 Release 工作流。
2. **M0 全部 6 项真机 Spike（2026-11-22 已提交 `a5ac14f`）**：
   - 覆盖 15 分钟 `MEMFS` Worker 内存/RTF（`S0-1`）、Vault 外缓存隔离（`S0-2`）、`Copilot 4.0.20` Lexical 注入（`S0-3`）、8 家云端 CORS 矩阵（`S0-4`）、`sherpa-onnx@2.0.2` `#3960`/`#1939` 复验（`S0-5`）与原生 AEC3 `+8.99 dB` 抑制探针（`S0-6`）。
3. **M1 桌面本地离线 WASM 听写闭环（2026-11-22 已提交 `ec45a34`）**：
   - Vault 外显式触发 + SHA256 校验模型管理器、隔离 `MEMFS` Worker `Silero VAD` + `SenseVoice int8`（`640 ms` 预卷缓冲，`toggle`/`single`/`push-to-talk`）、个人纠错词表可视化编辑与 CM6/Lexical 侧栏注入。
4. **M2 Markdown/表格口语化朗读、字幕档位播控、多 TTS 引擎与原生 AEC3 打断闭环（2026-11-22 已提交 `50548f5`）**：
   - 魔数嗅探 `OpenAiCompatTtsEngine` / `MimoTtsEngine`、单重模型互斥 `VitsWasmTtsEngine`、`PlaybackQueue` 暂停/跳句、独立轻量 `bargeInWorkerClient` + `AecBargeInMonitor`（`vits-wasm` 连续外放 `180,005 ms` 零自打断，语音打断 `66–370 ms`）及 `obsidian-http.ts` CORS 兜底。
5. **M3 BYOK 语音问答、4 重护栏润色、云端 ASR 与桌面声学/安全门禁（2026-11-22 实测通过）**：
   - **`@voice-mode/core`**：`asr-engines.ts`（纯 `Uint8Array` RFC 7578 `multipart/form-data` + 44B WAV 编码的 `OpenAiCompatAsrTransport`，完美兼容桌面/移动 CORS 兜底）及 `llm-router.ts`（`395` 行，补齐回环免密与非 SSE JSON 兼容）；
   - **`@voice-mode/browser`**：零 WASM/Worker 依赖的 `CloudDictationSession`（`640 ms` 预卷缓冲、RMS 断句、60s 强切与 `sessionEpoch` 零泄漏取消）；
   - **`@voice-mode/obsidian-plugin` & `styles.css`**：`VoiceQaModal`（`ask-ai-about-note` 选区/笔记流式问答、按句跟读、单句口述提问与一键插入光标）、`enableLlmPolish` 听写后 4 层防幻觉润色（任意错误零丢字回退原文）、`vits-wasm -> sensevoice-wasm` 秒切即时卸载阻塞 Worker 与 `settingsWriteEpoch` 并发防覆盖；
   - **真机门禁**：`data.json` 与 401/500 控制台/弹窗密钥扫描 **`0` 泄漏**；桌面真机 `A-1`、`A-2`（打断 `83–202 ms`）、`A-3`（断网 53.1s 六段混说词表 `3/3` 100% 命中）、`A-4`（`manual` 外放 `120,005 ms` 零自打断 + 按住说话上屏归位）全部通过；`M-1`–`M-5` 已在 Apple `JavaScriptCore`（iOS `WKWebView` 引擎）+ Obsidian `1.15.1` `emulateMobile(true)` 无 Node 沙箱通过仿真与 5 分钟 26 次切笔记压测（JS 堆 `+1.70 MB`），并固化入 `check:release`。

### 尚未完成 / 待真机硬件与后续阶段落地

- **M4 正式发版前人工/物理设备确认项**：iOS/Android 物理手机/平板硬件最终冒烟（核验真实移动 OS WebView Jetsam 与系统语音，[docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md) §3 `M-1`–`M-5`）及用户自有第三方云端付费 API Key 端到端对话试听。
- **M4–M6**：完成上述实机确认后打正式无 `v` Tag 向 `obsidianmd/obsidian-releases` 提审上架；Wave 2 `sillytavern-voice-mode`；Wave 3 统一本机 `voice-daemon` 与 Chrome/Edge 扩展。

## 当前首要下一步（Next Action）

1. 完成 M3 红队终审、提交推送 `origin/main` 并确认 GitHub Actions 三端 CI 全绿。
2. 由用户在 iOS/Android 实机完成 `M-1`–`M-5` 降级核验与个人真实声学/自有 API Key 试听后，切入 **M4** 发版提审。

## 关键入口

| 入口 | 说明 |
| --- | --- |
| [CONTEXT.md](../../CONTEXT.md) | 核心不变量、三包边界与常用命令 |
| [docs/plan/master-plan.md](../plan/master-plan.md) | 完整实测基准与 M0–M6 里程碑规划 |
| [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md) | M0–M3 真机实测报告、4 项真机声学门禁与移动端降级清单 |
| [docs/adr/README.md](../adr/README.md) | 架构决策记录（0001–0004） |
