# 当前恢复点（STATE · 2026-11-22）

> 本文件为唯一任务恢复点，按现状重写维护、**严格保持 ≤ 120 行**，不追加流水账。严禁将尚未通过真机验证的规划能力写成“已完成”。

## 当前基线版本

- **版本基线**：`0.1.0`（**M0 6 项真机 Spike**、**M1 桌面离线 WASM 听写闭环**与 **M2 朗读/字幕/多 TTS 引擎/原生 AEC3 打断闭环**已在真实 Obsidian `1.15.1` 验收闭环，正在进入 **M3**；尚未推送正式发布 Tag，尚未向 `obsidianmd/obsidian-releases` 提审）。
- **仓库身份**：`qishuilalala/obsidian-voice-mode`（Obsidian 插件 ID `voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`）。
- **工具链与真机宿主基线**：`obsidian@1.14.4`（类型）、`eslint-plugin-obsidianmd@0.6.0`、`esbuild@0.25.12`、`typescript@5.9.3`、Node `>= 22.18.0`；本机实测真机为 macOS `27.2.1`（Apple M2 Max / 32 GB）上的 **Obsidian `1.15.1`（Electron `43.8.9` / Chromium `150.0.7871.250`）**；当前构建产物 `main.js` 为 **`213.11 KB`**，全仓 **115 项单测**全绿。

## 已落地 vs 尚未实现（诚实边界）

### 已落地

1. **三包 Monorepo 与构建/合规门禁**：
   - `pnpm-workspace.yaml`、`tsconfig.base.json`、`esbuild.config.mjs`、`eslint.config.mjs`（含 `eslint-plugin-obsidianmd` 与跨包导入红线）、`scripts/check-release-gate.mjs`、三端 CI 与合规 Release 工作流。
2. **M0 全部 6 项真机 Spike（2026-11-22 实测通过，详见 [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md)）**：
   - 覆盖 15 分钟 `MEMFS` Worker 内存/RTF（`S0-1`）、Vault 外缓存隔离（`S0-2`）、`Copilot 4.0.20` Lexical 注入（`S0-3`）、8 家云端 CORS 矩阵（`S0-4`）、`sherpa-onnx@2.0.2` `#3960`/`#1939` 复验（`S0-5`）与原生 AEC3 `+8.99 dB` 抑制探针（`S0-6`）。
3. **M1 桌面本地离线 WASM 听写闭环（2026-11-22 已提交 `ec45a34`）**：
   - Vault 外显式触发 + SHA256 校验模型管理器（支持 `.part` HTTP 206 续传、主备源切换、一键打开目录/清理）、隔离 `MEMFS` Worker `Silero VAD` + `SenseVoice int8`（`640 ms` 预卷缓冲，`toggle`/`single`/`push-to-talk`）、个人纠错词表可视化编辑与 CM6/Lexical 侧栏注入；断网 `0` 外联、4.8s 单句定稿 `1,245 ms`、53.1s 六段连续听写词表 `3/3` 100% 命中。
4. **M2 Markdown/表格口语化朗读、字幕档位播控、多 TTS 引擎与原生 AEC3 打断闭环（2026-11-22 实测通过）**：
   - **`@voice-mode/core`**：新增 `tts-engines.ts`（魔数嗅探 `sniffAudioMime` 拦截伪装 HTML/JSON、纯 `Uint8Array` `decodeBase64Strict`、支持预设与回环地址的 `OpenAiCompatTtsEngine` 及 `api-key` 头隔离的 `MimoTtsEngine`）；
   - **`@voice-mode/browser`**：升级 `PlaybackQueue`（`pause`/`resume`/`skipCurrent`）、单重模型互斥守卫（`SenseVoice` 与 `VITS` 切换前主动释放旧实例）、`VitsWasmTtsEngine` 与 `AecBargeInMonitor`（强制 `autoGainControl: false`、`system` TTS 锁定 `manual`、无原生 AEC 立即关麦降级）；
   - **`@voice-mode/obsidian-plugin` & `styles.css`**：新增 `obsidian-http.ts`（`fetch` 优先 -> 桌面零重定向 Node 流 / 移动端 `requestUrl` CORS 兜底）、`DesktopModelManager.downloadVitsStack()`、独立轻量 `bargeInWorkerClient`（防 `VITS` 预合成阻塞实时 VAD）、按预设隔离 TTS `SecretStorage`、字幕 `small/medium/large` 字号与 `narrow/medium/wide` 宽度档位、暂停/跳句/停止按钮与切笔记自动中断；
   - **真机端到端验收**：含 Frontmatter/代码块/URL/5×5 表格笔记朗读零念出噪声符号；浅色 `15.91:1` / 深色 `12.19:1` WCAG 对比度达标且窄宽自动换行零溢出；主动停止耗时 **`6.4–10.9 ms`（`< 100 ms`）**、切标签页自动中断；真实 `vits-wasm` 扬声器在 `bargeInMode=detect`（`activePolicy="auto"`）下连续外放 **`180,005 ms`（3 分钟 / 11 句 / `2,811` 帧）全程 `0` 自打断**，压测后外部语音触发原生 AEC3 免手按打断实测声学响应 **`66–370 ms`（`< 600 ms`）** 且麦轨干净归位 `idle`。

### 尚未实现 / 待 M3–M6 落地

- **M3（当前立即推进）**：BYOK 语音问答模态框/命令与听写后 4 重护栏 LLM 润色开关（复用 `obsidian-http.ts` CORS 兜底与 `SecretStorage`）、云端 BYOK 转写（`openai-compat` Whisper `/audio/transcriptions`）兜底、发版前 4 项真机声学门禁复核与移动端真机降级验收（`M-1`–`M-5`）。
- **M4–M6**：`obsidian-releases` 提审上架、Wave 2 `sillytavern-voice-mode`、Wave 3 统一本机 `voice-daemon` 与 Chrome/Edge 扩展。

## 当前首要下一步（Next Action）

1. 完成 M2 独立红队对抗审查并提交 M2 代码与文档。
2. 立即启动 **M3**：接入 `@voice-mode/core` `llm-router` 语音问答与听写后可选 4 层防幻觉润色，补齐 BYOK 云端 ASR 转写通路，执行密钥泄漏扫描与桌面真机声学复核。

## 关键入口

| 入口 | 说明 |
| --- | --- |
| [CONTEXT.md](../../CONTEXT.md) | 核心不变量、三包边界与常用命令 |
| [docs/plan/master-plan.md](../plan/master-plan.md) | 完整实测基准与 M0–M6 里程碑规划 |
| [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md) | M0/M1/M2 真机实测报告、4 项真机声学门禁与移动端降级清单 |
| [docs/adr/README.md](../adr/README.md) | 架构决策记录（0001–0004） |
