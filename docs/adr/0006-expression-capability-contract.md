# ADR-0006：表达力能力契约与显式降级（E1/E2）

- **状态**：Accepted
- **日期**：2026-11-26
- **关联文档**：[ADR-0002](0002-dual-mode-wasm-and-sidecar-daemon.md)、[ADR-0003](0003-zero-dep-byok-llm-router-and-secret-storage.md)、[GLOSSARY.md](../../GLOSSARY.md)、内部表达力设计纪要（不公开）

## 背景

同一套 SSML 风格标签在五个 TTS 引擎（system / vits-wasm / kokoro-daemon / openai-compat / mimo）上的支持度差异极大：系统语音只有 rate，Kokoro 原生 `<break>`/`<whisper>`，BYOK 引擎只有 provider 相关的 `instructions`，而有些引擎完全没有情感能力。早期实现有两种坏结局：

1. **静默丢弃**：不支持的标签被直接移除，用户以为自己设置的情感生效了；
2. **标签朗读**：标签被当成正文读出来（"小于号 whisper"），破坏朗读体验。

## 决策

1. **单一能力契约**：`@voice-mode/core` 的 `expression-caps.ts` 定义 13 个能力维度（voices/rate/pause/whisper/emotion 等级、标签作用域等）与每个引擎的 caps 表；所有宿主（Obsidian/SillyTavern/dsh）从此契约派生能力披露，而不是各自维护一份"支持哪些标签"的文档。
2. **作用域标签 + 严格降级**：新增 `<slow>` / `<fast>` / `<spell>` / `<volume N>` / `<pitch N>` / `<emotion:NAME>`（`EMOTION_NAMES` 白名单），未闭合/非法作用域降级为纯文本并保留可读性；不支持的标签按契约显式降级（剥离或忽略），**不静默丢弃**。
3. **引擎映射**：`system` 引擎把 `<slow>/<fast>` 映射为逐句语速（×0.85/×1.15）；`kokoro-daemon` 原生支持 `<whisper>`/`<break>`；`openai-compat`/`mimo` 走 `instructions`；`vits-wasm` 仅 rate。
4. **对外披露**：README 维护"Engine expression capabilities"表；不支持的面明确写出（含 Edge 免费接口不支持 `mstts:express-as` 的实测结论）。

## 后果

- **一致性**：四产品的能力披露与降级行为同源；新增引擎只需在契约表登记。
- **可测试性**：`expression-caps` 有独立单测（覆盖每引擎 caps 与降级分析）；ST 的引擎表由 README 测试校验。
- **限制**：标签语法是产品自有 DSL（非完整 SSML）；不支持表达力的引擎（Edge）无法通过契约获得情感能力——这是能力边界而非缺陷。
