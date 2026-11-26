# AGENTS.md — obsidian-voice-mode（母仓）

> 面向在本仓库工作的 AI 编码代理。服务器级基线见 `~/.dsh/AGENTS.md`；本文件只放本仓库特有约束。
> 单一真源：`CONTEXT.md`（架构/命令/边界）、`CODING_STANDARDS.md`、`GLOSSARY.md`、`SECURITY.md`。

## 命令

- `pnpm run check:all`：build:packages → typecheck → lint → test → build → release gate（提交前必跑）。
- `pnpm run verify:matrix --require-all /mnt`：校验五份 vendor 归档；dsh 冻结期必须带 `VOICE_MODE_MATRIX_SKIP=dsh-voice-mode`（D-0021）。
- `pnpm run bench:smoke`：评测台架链路自检（C1）。

## 硬约束

1. `core` 零第三方运行时依赖；`core`/`browser` 不得依赖 obsidian/electron/@deepseek-ai/node:/DOM（架构门禁强制）。
2. 任何 `core`/`browser` 变更必须同步五份 vendor 归档并跑 `verify:matrix`；锁定文件同步。
3. 模型权重不入仓；移动端本地 WASM 模型保持禁用；实体机验证前不宣称移动端听写已支持。
4. 表达力能力必须走 `expression-caps` 契约，不支持的能力显式降级，不静默丢弃。
5. 错误/日志一律经 `redactSecrets`；不打印密钥、URL 凭据。
6. bench 语料不入库；C2 只存 URL+SHA256。
7. 长文朗读走**背压分批入队**（不丢尾）；进度显示 `(i/N)` 与续读位置 `readAloudResume` 不得破坏顺序语义。
8. WAV 导出前置检查引擎（vits 模型就绪/daemon 可用），系统语音明确提示不可导出；导出需防重。
9. 命令/通知文案必须进 i18n 表（中文界面）；新增命令同步 README 命令说明。

## 提交前检查（2026-11-26 教训）

- 删除任何 i18n key / 常量前，必须先跑完整 `pnpm run check:all`（含 typecheck）——只跑 `pnpm run test` 会漏掉类型错误（曾导致 CI 三平台失败）。
- 推送后必须复核 CI 实际结论（用维护者私有仓的 check-ci 脚本，或 `gh run list` 逐 workflow 检查）：push 成功 ≠ CI 绿。
- 新增测试断言不得依赖本机缓存/状态（CI 是干净环境）；优先轮询条件而非固定短等待。

## 禁止

- 不 `git add -A`；提交用文件白名单。
- 不擅自打 tag/发布（发布由 maintainer 授权，见 `docs/distribution/launch-playbook.md`）。
- 不引入声音克隆/声音设计。
- 不为一次性代码做抽象；优先最小改动。
