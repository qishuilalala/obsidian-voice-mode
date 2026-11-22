# ADR-0005：多仓 `0.1.0` 编译包共享契约与统一 `DaemonClient` 深模块接缝

- **状态**：Accepted
- **日期**：2026-11-22
- **关联文档**：[ADR-0001](0001-obsidian-first-serialized-matrix.md)、[ADR-0002](0002-dual-mode-wasm-and-sidecar-daemon.md)、[ADR-0004](0004-obsidian-review-bot-and-sync-budget.md)、[GLOSSARY.md](../../GLOSSARY.md)

## 背景

在推进 Wave 2（`sillytavern-voice-mode`）与 Wave 3（原生 `voice-daemon` + Chrome/Edge MV3 扩展）并反哺 `dsh-voice-mode` 时，如果把所有宿主插件、Node 原生守护进程与浏览器扩展都塞进同一个 Monorepo，会同时撞上三重工程与合规硬墙：

1. **上游 `obsidian-workflows`（`ObsidianReviewBot`）全仓扫描机制**：官方审核流水线的 `scanner-eslint` 默认扫描仓库内 `packages/*` 源码并强制启用 `obsidianmd/no-nodejs-modules`，且在无匹配锁文件回退执行 `npm install` 时无法解析原生服务端工作区依赖。一旦本仓放入 Node HTTP 守护进程或 MV3 Service Worker 专有包，将直接触发审核机器人误杀。
2. **原生 N-API 锁文件膨胀与 GPL-3.0 音素资产隔离**：`voice-daemon` 解锁 Kokoro 103 音色与 Zipformer2 双通道识别依赖 `sherpa-onnx-node`（含多平台预编译二进制）并在运行时按需挂载 `espeak-ng-data`（上游 **GPL-3.0**）。将原生二进制依赖或音素包引入纯 MIT 的 Obsidian 插件仓会污染锁文件、拖慢三端 CI 并带来许可证传染风险。
3. **跨四端重复实现守护进程协议的漂移风险**：若 Obsidian、SillyTavern、MV3 扩展与 `dsh-voice-mode` 各自手写本地守护进程健康探测、WAV/Multipart 转写上传、Kokoro 语音合成与离线降级逻辑，极易在回环地址校验、Bearer 鉴权脱敏或超时回退延迟上出现分叉。

## 决策

1. **按宿主合规边界拆分为独立 `0.1.0` 仓库，消费编译态 `@voice-mode/{core,browser}@0.1.0`**：
   - 本仓（`qishuilalala/obsidian-voice-mode`）作为共享内核母仓，维护 `@voice-mode/core`、`@voice-mode/browser` 与 `@voice-mode/obsidian-plugin`；
   - Wave 2 `qishuilalala/sillytavern-voice-mode`（`0.1.0`）与 Wave 3 `qishuilalala/voice-mode-daemon`（含 Node 原生守护进程与零 `<all_urls>` MV3 扩展，`0.1.0`）及 `qishuilalala/dsh-voice-mode` 保持独立 Git 仓库与独立锁文件；
   - `@voice-mode/core` 与 `@voice-mode/browser` 新增 `tsconfig.build.json`（开启 `rewriteRelativeImportExtensions`）与 `pnpm run build:packages`，产出零 TypeScript 运行时剥离依赖的标准 ES2022 `dist/*.js` + `dist/*.d.ts`（`files: ["dist"]`），供外部仓库在 Node 22/24 与浏览器打包器中直接消费；同时保留母仓 `tsconfig.base.json` 的 `paths` 指向 `./src/index.ts`，确保母仓 `esbuild` 与类型检查零额外构建心智负担，并提供根级 `tsconfig.json` 对齐上游 `scanner-eslint`。
2. **在 `@voice-mode/core` 沉淀单一 `DaemonClient` 深模块接缝**：
   - `DaemonClient` 暴露 `.asr`（`AsrTransport`，`kind = 'daemon'`）与 `.tts`（`TtsEngine`，`kind = 'kokoro-daemon'`）窄接口，统一封装严格回环 `http:` / `https:` URL 校验（仅允许无内嵌凭据的 `127.0.0.1`、`localhost`、`[::1]`）、`redirect: 'error'`、可选 `Bearer` 令牌注入、默认 `800 ms` 且强制校验 `service === 'voice-daemon'` 的 `/v1/health` 探针（含健康缓存与失败冷却）、复用 `encodeMonoPcm16Wav` + `buildMultipartFormData` 的 `/v1/audio/transcriptions`、经 `sniffAudioMime` 魔数核验的 `/v1/audio/speech`（`kokoro-v1.1-zh` + `KOKORO_DEFAULT_SPEAKERS` 及 `0..102` 说话人索引），以及截断前 `redactSecrets` 脱敏；
   - 当本机 `voice-daemon` 未启动、端口被异构服务占用、超时或返回 `401/403/404/405/5xx` 时，`DaemonClient` 与宿主适配层在 **`< 1s`** 内自动无阻塞回退至已注入的 `fallbackAsr` / `fallbackTts`（如本地 WASM、BYOK 云端或系统语音）并触发显式回退通知。
3. **在 `@voice-mode/browser` 沉淀宿主无关的 `FocusTextInjector`（`focus-injector`）**：
   - 将穿透 Shadow DOM / 同源 iframe 的焦点解析、受控输入框原生 setter 写入与内存态合成 `ClipboardEvent("paste")` 抽离至 `@voice-mode/browser`，供 Obsidian、SillyTavern 与 MV3 扩展共享同一套零剪贴板污染的文本注入实现。

## 后果

- **正面**：彻底消除 `ObsidianReviewBot` 对 `node:*` 与跨包锁文件的误判风险，严格隔离 `sherpa-onnx-node` 原生依赖与 GPL-3.0 音素数据；四个终端仓库共享同一份经过单测验证的 `DaemonClient`、情感标签编译器与焦点注入器，核心代码复用率稳定高于 `75%`。
- **代价与约束**：修改 `@voice-mode/core` 或 `@voice-mode/browser` 公开契约后，须执行 `pnpm run build:packages` 验证编译产物与 `pnpm pack` 压缩包完整性，再向下游仓库同步版本。
