# 当前恢复点（STATE · 2026-11-22）

> 本文件为唯一任务恢复点，按现状重写维护、**严格保持 ≤ 120 行**，不追加流水账。严禁将尚未通过真机验证的规划能力写成“已完成”。

## 当前基线版本

- **版本基线**：`0.1.0`（**M0 6 项真机 Spike** 与 **M1 桌面离线 WASM 听写闭环**已在真实 Obsidian `1.15.1` 验收闭环，正在进入 **M2**；尚未推送正式发布 Tag，尚未向 `obsidianmd/obsidian-releases` 提审）。
- **仓库身份**：`qishuilalala/obsidian-voice-mode`（Obsidian 插件 ID `voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`）。
- **工具链与真机宿主基线**：`obsidian@1.14.4`（类型）、`eslint-plugin-obsidianmd@0.6.0`、`esbuild@0.25.12`、`typescript@5.9.3`、Node `>= 22.18.0`；本机实测真机为 macOS `27.2.1`（Apple M2 Max / 32 GB）上的 **Obsidian `1.15.1`（Electron `43.8.9` / Chromium `150.0.7871.250`）**；当前构建产物 `main.js` 为 **`159.36 KB`**，全仓 **87 项单测**全绿。

## 已落地 vs 尚未实现（诚实边界）

### 已落地

1. **三包 Monorepo 与构建/合规门禁**：
   - `pnpm-workspace.yaml`、`tsconfig.base.json`、`esbuild.config.mjs`（打包至根目录 `main.js`）、`eslint.config.mjs`（含 `eslint-plugin-obsidianmd` 与跨包导入红线）；
   - `manifest.json`、`versions.json`、`styles.css`、`scripts/check-release-gate.mjs`、`scripts/version-bump.mjs`、三端 CI 与合规 Release 工作流。
2. **M0 全部 6 项真机 Spike（2026-11-22 实测通过，详见 [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md)）**：
   - **S0-1（`Pass`）**：Web Worker `MEMFS` 下 `Silero VAD` 冷载 `30 ms`、`SenseVoice int8` 冷载 `485 ms`，900 秒连续 60 轮会话平均 `RTF = 0.2148`，峰值增量 `+527.5 MB`、稳态增量 `+348.7 MB`、`worker.terminate()` 后 RSS 回落至 `469.3 MB`；
   - **S0-2（`Pass`）**：`245.3 MB` 权重与 WASM 落盘 `~/.cache/voice-mode/models/`，SHA256 100% 匹配，Vault 与插件目录模型文件数为 `0`；
   - **S0-3（`Pass`）**：CM6、搜索框、Shadow DOM `<textarea>` 及 `Copilot 4.0.20`（Lexical `contenteditable`）连续 `10/10` 注入与 Undo/Redo 全部通过；
   - **S0-4（`Mitigated/Pass`）**：8 家云端 CORS 预检矩阵 + 回环 SSE/Ollama 验证完成（Doubao、OpenAI、默认 Ollama 于 M3 自动回退 `requestUrl`）；
   - **S0-5（`Mitigated/Pass`）**：`kokoro-int8` WASM `#3960` 仍全 `NaN`（M2 禁用 WASM Kokoro）；`vits-zh-ll` `#1939` 已修（80 句稳态 `438 MB`，`RTF = 1.275`，M2 作为桌面可选引擎）；
   - **S0-6（`Mitigated/Pass`）**：关闭 AGC 后 `HTMLAudioElement` 实测原生 AEC3 抑制 `+8.99 dB`，系统 `speechSynthesis` 无参考流（M2 在 `system` TTS 下强制锁定 `manual` 打断）。
3. **M1 桌面本地离线 WASM 听写闭环（2026-11-22 实测通过）**：
   - **`@voice-mode/core`**：新增 `model-manifest.ts`（固定 `Silero VAD`、`SenseVoice int8`、`vits-zh-ll` 与 `sherpa-onnx@2.0.2` WASM 的 SHA256/提交哈希、重定向白名单校验、纯 JS USTAR tar 解包器与 `MEMFS` 胶水构造器）；
   - **`@voice-mode/browser`**：新增 `sherpa-worker-runtime.ts`、`sherpa-worker-client.ts` 与 `dictation-session.ts`（零拷贝 `MEMFS` 挂载 + 立即 `unlink`、`640 ms` 环形预卷缓冲 + 句间 `160 ms` 静音前导防吞首字、支持 `toggle` / `single` / `push-to-talk` 三模式与空闲 Worker 自动卸载）；
   - **`@voice-mode/obsidian-plugin`**：新增 `desktop-fs.ts`（`realpath` Vault 外隔离强守卫、流式 1 MB 分块 SHA256、`fh.read` 零拷贝 `ArrayBuffer` 读取、一键打开缓存目录）与 `model-manager.ts`（`.part` HTTP 206 断点续传、主备镜像自动切换、`verified-sha256-v1.json` 1 ms 暖校验）；升级 `editor-bridge.ts`（内存态合成 `ClipboardEvent("paste")` 兼容 Lexical/ProseMirror）、`settings-tab.ts`（离线模型卡片 + 个人纠错词表可视化增删改）与 `main.ts`（含 `dictate-single-utterance` 命令与麦克风权限拒绝友好提示）；
   - **真机端到端验收**：真实 Obsidian `1.15.1` 断网门禁下网络请求数 **`0`**，4.8s 单句定稿延迟 **`1,245 ms`（`< 1,500 ms`）**，53.1s 六段连续听写首尾零吞字且 3 条纠错词表 **`3/3`（100%）** 准确命中，物理扬声器->麦克风 Push-to-Talk 实时听写与同音替换上屏成功。

### 尚未实现 / 待 M2–M6 落地

- **M2（当前立即推进）**：Markdown/表格按句流式朗读与可选离线 `vits-wasm` / BYOK TTS（`openai-compat`、`mimo`）、悬浮字幕字号/宽度档位与暂停/跳句/停止按钮、原生 AEC3 外放打断（`system` TTS 自动锁定 `manual` 且禁用 AGC）。
- **M3**：BYOK 语音问答与 4 层防幻觉润色 UI（含 `requestUrl` CORS 兜底路由）、移动端真机降级实测、发版前 4 项真机声学必过门禁（`A-1`–`A-4`）。
- **M4–M6**：`obsidian-releases` 提审上架、Wave 2 `sillytavern-voice-mode`、Wave 3 统一本机 `voice-daemon` 与 Chrome/Edge 扩展。

## 当前首要下一步（Next Action）

1. 完成 M1 独立红队对抗审查并提交 M1 代码与文档。
2. 立即启动 **M2**：落地桌面可选 `vits-wasm` / BYOK TTS 引擎适配、悬浮字幕档位与播控交互、切笔记 `< 100 ms` 瞬停以及原生 AEC3 外放打断监测器。

## 关键入口

| 入口 | 说明 |
| --- | --- |
| [CONTEXT.md](../../CONTEXT.md) | 核心不变量、三包边界与常用命令 |
| [docs/plan/master-plan.md](../plan/master-plan.md) | 完整实测基准与 M0–M6 里程碑规划 |
| [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md) | M0/M1 真机实测报告、4 项真机声学门禁与移动端降级清单 |
| [docs/adr/README.md](../adr/README.md) | 架构决策记录（0001–0004） |
