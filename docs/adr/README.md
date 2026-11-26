# 架构决策记录（ADR）索引

本目录记录 `obsidian-voice-mode` 及其共享核心（`@voice-mode/core`、`@voice-mode/browser`）的关键不可逆或高成本架构决策。每篇 ADR 仅记录背景、决策、依据与后果，避免与实现细节流水账混写。

| 编号 | 标题 | 状态 | 决策日期 | 核心议题 |
| --- | --- | --- | --- | --- |
| [ADR-0001](0001-obsidian-first-serialized-matrix.md) | 以 Obsidian `voice-mode` 作为系列化开源矩阵首作 | Accepted | 2026-11-21 | 宿主选型、为何先 Obsidian 后 SillyTavern 再扩展，而非企业 IM / VS Code / 闭源壳 |
| [ADR-0002](0002-dual-mode-wasm-and-sidecar-daemon.md) | 双模语音运行时：默认零外置 Web Worker WASM + 可选统一 `voice-daemon` | Accepted | 2026-11-21 | 破解“外置安装转化断崖”与“Electron V8 内存笼 + WASM 内存墙”两难 |
| [ADR-0003](0003-zero-dep-byok-llm-router-and-secret-storage.md) | 零依赖双协议 BYOK `llm-router` 与 Obsidian `SecretStorage` 凭证隔离 | Accepted | 2026-11-21 | 拒绝重型 AI SDK 与 `data.json` 明文密钥，统一 5 条安全红线 |
| [ADR-0004](0004-obsidian-review-bot-and-sync-budget.md) | `eslint-plugin-obsidianmd` 门禁、5 MB Sync 预算与运行时模型/GPL 隔离 | Accepted | 2026-11-21 | 官方社区目录过审合规、Vault 外模型缓存与 `espeak-ng-data` GPL-3.0 隔离 |
| [ADR-0005](0005-multi-repo-package-sharing-and-daemon-seam.md) | 跨仓共享编译包与本机语音客户端 `DaemonClient` | Accepted | 2026-11-22 | 为何 Wave 2/3 拆仓隔离 `node:*` / N-API / GPL、`dist/` 编译契约与四端共享 `DaemonClient` |
| [ADR-0006](0006-expression-capability-contract.md) | 表达力能力契约与显式降级（E1/E2） | Accepted | 2026-11-26 | 13 维度能力契约、作用域标签、不静默丢弃、引擎映射与对外披露 |
| [ADR-0007](0007-long-text-read-aloud-strategy.md) | 长文本朗读策略（背压 / 导出 / 续读） | Accepted | 2026-11-26 | 背压分批不丢尾、WAV 导出（仅 WAV 引擎）、断点续读与进度显示 |

## 编写约束

- 修改架构边界前先更新或新增 ADR，不在 ADR 中硬写易漂移的源码行号（引用包名或符号名）。
- 若真机 Spike（如 M0）证伪某项前提，须在对应 ADR 补充 `Superseded` 或修订记录，不静默修改历史结论。
