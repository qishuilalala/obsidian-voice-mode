# 当前恢复点（STATE · 2026-11-22）

> 本文件为唯一任务恢复点，按现状重写维护、**严格保持 ≤ 120 行**，不追加流水账。严禁将尚未通过真机验证的能力写成“已完成”，并严格遵守用户“先不发”边界。

## 当前基线版本

- **版本基线**：`0.1.0`（**M0–M4 本机桌面真机、实网 `MiMo` TTS、全新空 Vault / `BRAT 2.2.0` 双冒烟、Android 15 AVD 模拟器（`Obsidian 1.15.1` APK，System WebView `124.0`）`M-1`–`M-5` 验证、Xcode `iOS 27.0` Simulator `WKWebView` 测试基座验证、15s 横竖屏有声 Demo 与首发文案包**已全部闭环就绪；当前遵守 **“先不发”** 约束，暂未推送公开 Release Tag、暂未向 `obsidianmd/obsidian-releases` 提交外部 PR、暂未发布外部社媒帖）。
- **仓库身份**：`qishuilalala/obsidian-voice-mode`（Obsidian 插件 ID `voice-mode`，`minAppVersion: 1.11.4`，`isDesktopOnly: false`）。
- **工具链与真机宿主基线**：`obsidian@1.14.4`（类型）、`eslint-plugin-obsidianmd@0.6.0`、`esbuild@0.25.12`、`typescript@5.9.3`、Node `>= 22.18.0`；桌面真机为 macOS `27.2.1`（Apple M2 Max / 32 GB）上的 **Obsidian `1.15.1`（Electron `43.8.9` / Chromium `150.0.7871.250`）**；移动实测覆盖 **Android 15 AVD 模拟器（`Obsidian 1.15.1` APK，System WebView `124.0`）** 与 **Xcode `iOS 27.0` Simulator `WKWebView` 测试基座（`iPhone 18 Pro` / `AppleWebKit/605.1.15`）**；当前构建产物 `main.js` 为 **`284.13 KB`（`290,948 B`）**，`llm-router.ts` **`396` 行**（`< 400` 行预算），全仓 **`166` 项单测**（`76 core + 42 browser + 48 plugin`）全绿。

## 已落地 vs 外部待触发边界（诚实边界）

### 已落地并完成实测

1. **三包 Monorepo、深模块共享契约与五维治理门禁（`T1` 已合入 `07076d6`）**：
   - `@voice-mode/core` 与 `@voice-mode/browser` 支持 `pnpm run build:packages` 产出编译态 `dist/*.js` + `.d.ts`；沉淀 `< 1s` 快速回退 `DaemonClient`（`daemon` ASR / `kokoro-daemon` TTS）、情感 DSL 与 Prompt 编译器（`emotion.ts`）、通用焦点注入器 `FocusTextInjector`；配齐 `GLOSSARY.md`、`CODING_STANDARDS.md`、`ADR-0005`、根 `tsconfig.json` 与 `check:release` 7 项守卫。
2. **M0 全部 6 项真机 Spike + M1 桌面离线 WASM 听写 + M2 降噪朗读与原生 AEC3 打断**：
   - `Silero VAD` 冷载 `30 ms`、`SenseVoice int8` 冷载 `485 ms`、15 分钟中英混说均值 `RTF = 0.2148`、Vault 外 SHA256 模型管理器（`245.3 MB` 听写栈 + 可选 `116.1 MB` `vits-zh-ll`）、`Copilot 4.0.20` Lexical `10/10` 合成粘贴注入；
   - Markdown/表格降噪朗读、双主题高对比度字幕（`15.91:1` / `12.19:1`）、`< 100 ms` 瞬停、原生 AEC3 外放 3 分钟 `0` 自打断与 `66–370 ms` 语音打断。
3. **M3 BYOK 流式语音问答、4 重护栏润色、云端 ASR 与声学/脱敏门禁**：
   - `VoiceQaModal`（`ask-ai-about-note`）、`enableLlmPolish` 4 层反幻觉护栏、零 WASM `CloudDictationSession` + `OpenAiCompatAsrTransport`、桌面声学必过门禁 `A-1`–`A-4` 全部 `Pass`、401/500 报错全量 `<redacted>` 脱敏。
4. **M4 移动双端实测、实网 `MiMo` 朗读、全新空库 / `BRAT 2.2.0` 冒烟与首发资产包（`T4`，2026-11-22）**：
   - **Android 15 AVD 模拟器（`Obsidian 1.15.1` APK，System WebView `124.0`）**：实测通过 `M-1`（`0` Node 报错、桌面状态栏未挂载）、`M-2`（屏蔽本地 WASM、同步配置自动降级 `system`，并记录 Android System WebView 原生无 `window.speechSynthesis` 而保留 `webkitSpeechRecognition` 差异，友好提示启用 BYOK TTS）、`M-3`（隐私门控 + `SecretStorage` 听写与问答上屏，`data.json` `0` 密钥）、`M-4`（`307.3 s` 连续朗读 + 5 篇笔记 `25` 次切换，V8 堆平稳 `24.80 MB`、`0` 崩溃）、`M-5`（`pm revoke RECORD_AUDIO` 真实触发 `NotAllowedError` 可读提示并归位 `idle`）；
   - **Xcode `iOS 27.0` Simulator `WKWebView` 测试基座**：实测 `68` 种原生系统语音（`2` 中文 / `25` 英文）、`PlaybackQueue`、`FocusTextInjector`、`CloudDictationSession` 与 `main.js` 移动生命周期 `0` 报错；
   - **全新空库 + `BRAT 2.2.0` + 实网 `MiMo` TTS**：零软链 3 文件冷载 `5.8 ms`（`0` 启动网络请求、`0` 报错），与 `BRAT 2.2.0` 共存无冲突；实网 `MiMo` 经 `MimoTtsEngine` `res.ok` 2xx 与魔数校验返回 `199.7 KB` `audio/wav`（播放 `6.72 s`，停止 `1.3 ms`），测毕即清密钥且 `obsidian.json` 逐字节还原；
   - **首发资产**：封版 `CHANGELOG.md` `## [0.1.0]`，产出 `docs/distribution/launch-kit.md` 及已忽略入库的 15.0s 有声演示视频 `release-assets/demo-16x9-1080p.mp4`（`1920x1080`）与 `release-assets/demo-9x16-vertical.mp4`（`1080x1920`）。

### 尚未对外执行 / 后续波次事项

- **外部公开发布动作（受“先不发”门控）**：待用户明确授权发布后，推送裸 `0.1.0` Tag 触发 GitHub Release 3 附件发布、向 `obsidianmd/obsidian-releases` 提交 [launch-kit.md](../distribution/launch-kit.md) §1 PR，并在口袋物理 iPhone/Android 手机做最终随身核验。
- **跨仓协同波次（M5–M6）**：Wave 2 独立仓 `sillytavern-voice-mode`（`0.1.0`）、Wave 3 独立仓 `voice-mode-daemon`（`Kokoro 103` 守护进程 + Chrome/Edge MV3 扩展）及反哺 `dsh-voice-mode`。

## 当前首要下一步（Next Action）

1. 完成本仓 T4 双轴代码/规范审查（`/code-review`）与独立红队审计，按路径干净提交。
2. 保持“先不发”待命；待用户下达正式对外发布指令后再打公开 `0.1.0` Release Tag 并提交 `obsidianmd/obsidian-releases` PR。

## 关键入口

| 入口 | 说明 |
| --- | --- |
| [CONTEXT.md](../../CONTEXT.md) | 核心不变量、三包边界与常用命令 |
| [docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md) | M0–M4 桌面真机、实网 MiMo、Android 35 APK 与 iOS 27 `WKWebView` 实测报告 |
| [docs/distribution/launch-kit.md](../distribution/launch-kit.md) | 官方目录 PR、GitHub Release `0.1.0` 与全渠道首发定稿包 |
| [docs/adr/README.md](../adr/README.md) | 架构决策记录（0001–0005） |
