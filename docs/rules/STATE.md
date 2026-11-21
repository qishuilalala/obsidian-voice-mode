# 当前恢复点（STATE · 2026-11-22）

> 本文件为唯一任务恢复点，按现状重写维护、**严格保持 ≤ 120 行**，不追加流水账。严禁将尚未通过真机验证的规划能力写成“已完成”。

## 当前基线版本

- **版本基线**：`0.1.0`（M0 6 项真机 Spike 已全通闭环，正在推进 M1 桌面离线 WASM 听写；尚未推送正式发布 Tag，尚未向 `obsidianmd/obsidian-releases` 提审）。
- **仓库身份**：`qishuilalala/obsidian-voice-mode`（Obsidian 插件 ID `voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`）。
- **工具链与真机宿主基线**：`obsidian@1.14.4`（类型）、`eslint-plugin-obsidianmd@0.6.0`、`esbuild@0.25.12`、`typescript@5.9.3`、Node `>= 22.18.0`；本机实测真机为 macOS `27.2.1`（Apple M2 Max / 32 GB）上的 **Obsidian `1.15.1`（Electron `43.8.9` / Chromium `150.0.7871.250`）**。

## 已落地 vs 尚未实现（诚实边界）

### 已落地

1. **三包 Monorepo 与构建/合规门禁**：
   - `pnpm-workspace.yaml`、`tsconfig.base.json`、`esbuild.config.mjs`（打包至根目录 `main.js`）、`eslint.config.mjs`（含 `eslint-plugin-obsidianmd` 与跨包导入红线）；
   - `manifest.json`、`versions.json`、`styles.css`、`scripts/check-release-gate.mjs`、`scripts/version-bump.mjs`、三端 CI 与合规 Release 工作流。
2. **共享核心、音频契约与插件骨架**：
   - `packages/voice-core`（`@voice-mode/core`）：零依赖纯模块（`segmenter`、`asr-replacements`、`emotion`、`engine-kind`、`voice-catalog`、`redact`、`contracts`、`llm-router`）；
   - `packages/voice-browser`（`@voice-mode/browser`）：浏览器/Electron 音频契约（`audio-worklet-source`、`resample`、`aec-probe`、`playback-queue`、`worker-protocol`）；
   - `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`）：插件骨架、设置面板、状态条、字幕浮层与运行时守卫（`runtime-guard`）。
3. **M0 全部 6 项真机 Spike（2026-11-22 实测通过，详见 [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md)）**：
   - **S0-1（`Pass`）**：Obsidian `1.15.1` Web Worker 内加载 `sherpa-onnx@2.0.2` WASM（`19 ms`）+ `Silero VAD`（`30 ms`）+ `SenseVoice int8`（`485 ms`），900 秒连续 60 轮真实中英混说会话平均 `RTF = 0.2148`，峰值增量 `+527.5 MB`、稳态增量 `+348.7 MB`、WASM 线性堆恒定 `512 MB`，`worker.terminate()` 后 30 秒内渲染进程 RSS 从 `779.0 MB` 回落至 `469.3 MB`；
   - **S0-2（`Pass`）**：`245.3 MB` 模型与 WASM 落盘 `~/.cache/voice-mode/models/`，SHA256 100% 匹配，杀进程重启后复读 `605.2 MB/s`，Vault 与插件目录模型文件数为 `0`；
   - **S0-3（`Pass`，M0 原型已验 / M1 合入源码）**：CM6、搜索框、Shadow DOM `<textarea>` 及真实 `Copilot 4.0.20`（Lexical `contenteditable`，经 M0 CDP 原型验证合成内存态 `ClipboardEvent("paste")` 适配，计划于 M1 写入 `editor-bridge.ts`）连续 `10/10` 注入与 Undo/Redo 全部通过；
   - **S0-4（`Mitigated/Pass`）**：占位密钥跨域预检/POST 实测确认 DeepSeek、百炼 Qwen、Kimi、SiliconFlow、OpenRouter 与带直连头的 Anthropic 放行 `app://obsidian.md` CORS（回环服务验证 `fetch` 3 分片流式 SSE 正常）；火山方舟 Doubao、OpenAI 及默认 Ollama `Origin` 规则回环模拟遭 CORS 拦截，走主进程 `requestUrl` 100% 可达（本机未装 Ollama CLI，`:11434` 返回 `ERR_CONNECTION_REFUSED`）；
   - **S0-5（`Mitigated/Pass`）**：`sherpa-onnx@2.0.2` 下 `kokoro-int8` WASM 仍输出全 `NaN`（`#3960` 未修，M2 禁用 WASM Kokoro）；`vits-zh-ll` 连续 80 句变长合成稳态 `438 MB`（`#1939` 已修，单线程 `RTF = 1.275`，M2 作为桌面可选引擎）；
   - **S0-6（`Mitigated/Pass`）**：`48k->16k AudioWorklet` 正常运转，关闭 AGC 后 `HTMLAudioElement` 实测原生 AEC3 抑制 `+8.99 dB`，系统 `speechSynthesis` 无 Chromium 参考流（M2 在 `system` TTS 下强制锁定 `manual` 打断）；桌面 `SecretStorage` 往返读写与 `detectRuntimeCapabilities(true)` 逻辑守卫通过（iOS/Android 物理真机留待 M3 验收）。

### 尚未实现 / 待 M1–M6 落地

- **M1（当前正在实施）**：桌面本地离线 WASM 听写闭环（Vault 外用户显式触发 + SHA256 校验 + HuggingFace/`hf-mirror.com` 模型管理器、Web Worker `Silero VAD` + `SenseVoice int8`、纠错词表可视化编辑、含 Lexical 兼容的编辑器/侧栏注入）。
- **M2**：Markdown/表格按句流式朗读与可选离线 `vits-wasm` / BYOK TTS、悬浮字幕条完善、AEC3 外放打断（`system` TTS 自动锁定 `manual`）。
- **M3**：BYOK 语音问答与润色 UI（含 `requestUrl` CORS 兜底路由）、移动端真机降级实测、发版前 4 项真机声学必过门禁。
- **M4–M6**：`obsidian-releases` 提审上架、Wave 2 `sillytavern-voice-mode`、Wave 3 统一本机 `voice-daemon` 与 Chrome/Edge 扩展。

## 当前首要下一步（Next Action）

1. 按 M0 实测结论落地 **M1 桌面离线 WASM 听写闭环**（模型管理器、Web Worker `Silero VAD` + `SenseVoice int8` 引擎、纠错词表 UI、Lexical 兼容文本注入器与空闲 Worker 自动卸载）。
2. 完成 M1 全量单测、`pnpm run check:all`、独立红队对抗审查及真实 Obsidian `1.15.1` 断网离线听写端到端验收后推进 M2。

## 关键入口

| 入口 | 说明 |
| --- | --- |
| [CONTEXT.md](../../CONTEXT.md) | 核心不变量、三包边界与常用命令 |
| [docs/plan/master-plan.md](../plan/master-plan.md) | 完整实测基准与 M0–M6 里程碑规划 |
| [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md) | M0 Spike 实测报告、4 项真机声学门禁与移动端降级清单 |
| [docs/adr/README.md](../adr/README.md) | 架构决策记录（0001–0004） |
