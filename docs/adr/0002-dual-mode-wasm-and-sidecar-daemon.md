# ADR-0002：双模语音运行时——默认零外置 Web Worker WASM + 可选统一 `voice-daemon`

- **状态**：Accepted（2026-11-22 M0 真机 Spike S0-1 / S0-5 于 Obsidian `1.15.1` · Electron `43.8.9` 实测验证定案）
- **日期**：2026-11-21
- **关联文档**：[docs/plan/master-plan.md](../plan/master-plan.md)、[docs/qa/acceptance-checklist.md](../qa/acceptance-checklist.md)

## 背景

在桌面端（尤其是 Electron 宿主）部署本地离线语音引擎面临一对尖锐矛盾：

1. **强制外置守护进程会击穿获客漏斗**：Obsidian 官方目录的对照数据证明，强依赖外部进程或独立 App 的语音插件下载量比零外置同类低 1–2 个数量级（`Local Speech Recognition` 181 下载、`Otoha TTS` 1,000 下载 vs `Speech Kit` 6,000、`Aloud` 20,134、`Whisper` 60,000）。
2. **现代 Electron 与浏览器 WASM 存在三重物理上限**：
   - **Electron V8 内存笼（Memory Cage）**：Obsidian 桌面端 Installer 1.14.4 为 **Electron 43.7.5**、Installer 1.15.1 已升至 **Electron 43.8.9**，两者均启用 V8 Memory Cage 并禁止 N-API 返回堆外 `External Buffer`，导致高性能原生包 `sherpa-onnx-node`（Kokoro 103 音色）在 Electron 渲染进程、主进程及 `ELECTRON_RUN_AS_NODE=1` 子进程中均会 100% 抛出 `External buffers are not allowed`。
   - **WASM 内存墙与算子缺陷**：32 位 WASM 堆在多模型常驻时极易触发 OOM（实测单模型本机基准：`Silero VAD` 27 ms、`SenseVoice int8` 696 ms / RTF 0.258 / 460 MB RSS、`Zipformer2` 1,939 ms / RTF 0.259 / 463 MB RSS、`VITS` 444 ms / 581 MB RSS）；同时 `sherpa-onnx v1.13.7` WASM 构建运行 `kokoro-int8-multi-lang-v1_1` 因缺失 `ConvInteger(10)` 会静默输出全零静音（`k2-fsa/sherpa-onnx#3960`）。
   - **移动端硬红线**：iOS WKWebView 无 Node 运行时且受约 500 MB Jetsam 内存上限约束，加载 200 MB+ WASM 模型会直接导致 App 闪退。

## 决策

采用**双模运行时分流架构**，将“零摩擦首装”与“满血本地 Hi-Fi”解耦：

1. **Default 默认层（Wave 1 桌面开箱，零外置安装）**：
   - 在桌面端 Web Worker 内运行单模型离线栈：**`Silero VAD` + `SenseVoice int8`**，规避 Zipformer2 + SenseVoice 双模型并行常驻的内存翻倍风险，并支持空闲超时释放 Worker；
   - 朗读默认提供合规系统语音 + BYOK 在线 TTS（及按 M0 Spike-5 实测结果可选加载轻量离线 VITS），**绝不内置逆向 Edge 私有 WebSocket**；
   - 移动端（`Platform.isMobile`）强制关闭本地重型 WASM 加载，平滑降级为 BYOK API + 系统朗读。
2. **Hi-Fi 进阶层（Wave 3 可选跨宿主统一 `voice-daemon` Sidecar）**：
   - 面向需要 Kokoro 103 音色、流式 Zipformer2 + SenseVoice 满血双通道或跨软件共享缓存的重度用户，提供独立真 Node.js / 原生进程 `voice-daemon`；
   - 仅绑定 `127.0.0.1` + 随机 Bearer Token + 严格 `Origin` 白名单，一份本地模型缓存（`~/.cache/voice-mode/models`）同时服务 Obsidian、SillyTavern、Chrome/Edge 扩展与 `dsh-voice-mode`；
   - `voice-daemon` 始终为**可选加速项**，未安装或掉线时自动回退默认层。

## 后果

- **正面**：保住零外置一键安装的转化漏斗，同时从架构上彻底规避 Electron V8 内存笼、WASM `#3960` 静音与多宿主重复占用数 GB 模型磁盘的问题。
- **代价与约束**：`@voice-mode/browser` 必须抽象传输契约（本地 Worker / 远端 BYOK / 可选本地回环 HTTP/WS）。2026-11-22 M0 真机实测确认：Obsidian `1.15.1`（Electron `43.8.9`）的 Web Worker 默认暴露 `process.type === "worker"`，必须在 Worker 胶水层显式固定 `ENVIRONMENT_IS_NODE=false`、屏蔽 `NODERAWFS` 并注入纯 JS POSIX `path` 垫片以强制走隔离 `MEMFS`；配合单份 `ArrayBuffer` 零拷贝传入与会话初始化后立即 `FS.unlink` 释放重复文件缓冲时，`sherpa-onnx@2.0.2` 下 `Silero VAD` 冷载 `30 ms`、`SenseVoice int8` 冷载 `485 ms`、15 分钟连续 60 轮听写平均 `RTF = 0.2148`、稳态常驻增量 `+348.7 MB`（峰值 `+527.5 MB < 700 MB`）且 `worker.terminate()` 后可即时回收内存；`kokoro-int8` 在 `2.0.2` WASM 下仍输出全 `NaN`（`#3960` 未修），故 M2 禁用 WASM Kokoro，将已确认无内存泄漏（`#1939` 已修，80 句稳态 `438 MB`，单线程 `RTF = 1.22–1.275`）的 `vits-wasm` 作为桌面显式可选引擎（默认保持系统语音 + BYOK）。
