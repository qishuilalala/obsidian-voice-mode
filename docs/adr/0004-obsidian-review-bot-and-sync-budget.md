# ADR-0004：`eslint-plugin-obsidianmd` 门禁、5 MB Sync 预算与运行时模型/GPL 隔离

- **状态**：Accepted
- **日期**：2026-11-21
- **关联文档**：[SECURITY.md](../../SECURITY.md)、[docs/distribution/launch-playbook.md](../distribution/launch-playbook.md)

## 背景

要顺利通过 `obsidianmd/obsidian-releases` 官方社区插件审核并长期稳定服务双端用户，必须把审核规则与合规边界固化为机械门禁，而不是在提审前临时人工补救：

1. **`ObsidianReviewBot` 自动化拦截**：Obsidian 官方审核机器人结合 `eslint-plugin-obsidianmd` 严格检查 DOM 安全（禁止 `innerHTML` / 未清理事件）、生命周期内存释放（`registerEvent` / `registerDomEvent`）、设置文案大小写规范、Release Tag 不可带 `v` 前缀、Release 附件仅允许合规产物，以及外部网络请求与模型下载的透明披露。
2. **Obsidian Sync 5 MB 同步预算与 Vault 污染**：Obsidian Sync 对单个插件/文件同步有严格体积与流量约束（核心单文件 `main.js` 须远低于 **5 MB**）；若将 200+ MB 的语音模型下载到 `.obsidian/plugins/voice-mode/` 内部，会立刻撑爆用户的 Obsidian Sync / iCloud / Git 仓库，引发同步卡死或误提交超大二进制。
3. **第三方模型与音素数据许可证传染风险**：本仓库代码采用宽松的 **MIT** 许可证；`sherpa-onnx` 与 Kokoro 权重采用 Apache-2.0，但 Kokoro 依赖的 `espeak-ng-data`（355 个音素数据文件）上游为 **GPL-3.0**，SenseVoice 权重采用 **FunAudioLLM** 许可证。将这些文件打包进插件仓库或 Release 产物既会击穿 5 MB 预算，也会制造严重的许可证合规风险。

## 决策

1. **CI 强制接入 `eslint-plugin-obsidianmd` 与发布门禁**：
   - 将 `eslint-plugin-obsidianmd@0.6.0` 作为 `pnpm run lint` 必需检查项，与 `typecheck`、`test`、`build`、`check:release` 一起在 Ubuntu / macOS / Windows 三端矩阵运行；
   - `.github/workflows/release.yml` 强制校验无 `v` 前缀 semver Tag（`Tag == manifest.json.version == package.json.version` 且与 `versions.json` 一致），强制断言 `main.js < 5 MB`，且 Release 严格**仅上传 `main.js`、`manifest.json`、`styles.css`**。
2. **模型文件 Vault 外独立缓存与显式用户触发下载**：
   - 桌面端离线模型与 WASM 运行时一律存放在 Vault 之外的操作系统应用缓存目录（macOS `~/.cache/voice-mode/models/`、Linux `$XDG_CACHE_HOME/voice-mode/models/` 或 `~/.cache/voice-mode/models/`、Windows `%LOCALAPPDATA%\voice-mode\models\`，或用户指定的经 `realpath` 校验位于 Vault 外的绝对路径），绝不写入 `.obsidian/` 或笔记目录；
   - 严禁插件激活时静默后台拉取模型；所有下载必须由用户显式点击触发，经逐跳 HTTPS 域名白名单（模型权重：`huggingface.co` / `hf-mirror.com` 及其 LFS 子域；`sherpa-onnx@2.0.2` WASM 运行时压缩包：`registry.npmjs.org` / `registry.npmmirror.com` / `cdn.npmmirror.com`）+ 固定 SHA256 摘要校验 + tar 路径穿越与软硬链接拦截，并在 README、`SECURITY.md` 与设置界面完整披露来源域名、体积与上游许可证。
3. **严格隔离 GPL-3.0 与非 MIT 模型资产**：
   - 仓库源码、npm 依赖树与 GitHub Release 产物内**永不包含**任何模型权重、WASM 大二进制或 `espeak-ng-data` 音素文件；
   - 任何需要 `espeak-ng-data`（如 Wave 3 可选 `voice-daemon` 的 Kokoro 音色）的场景均通过独立运行时按需下载并附带独立许可证声明。

## 后果

- **正面**：首次提审 `obsidian-releases` 时大幅降低被 `ObsidianReviewBot` 或人工审核退回的概率；Obsidian Sync 同步毫秒级完成；仓库与发布产物保持纯 MIT 清洁状态。
- **代价与约束**：需要在 M0 Spike-2 中跨 macOS / Windows / Linux 实测 Vault 外缓存目录的读取与权限边界（尤其是沙盒化 Linux Flatpak/Snap 安装形态下的路径回退策略），并在设置界面提供清晰的一键打开缓存目录与一键清理按钮。
