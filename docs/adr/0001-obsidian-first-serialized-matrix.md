# ADR-0001：以 Obsidian `voice-mode` 作为系列化开源矩阵首作

- **状态**：Accepted
- **日期**：2026-11-21
- **关联文档**：[docs/plan/master-plan.md](../plan/master-plan.md)

## 背景

在将 `dsh-voice-mode` 沉淀的离线语音识别、纠错词表、口语化分句与 AEC3 打断能力复制到更广泛的非编程生态时，我们对 24 类主流开源/商业宿主做了源码级与商店生态交叉评估，发现盲目跟风高 Star 宿主或办公 IM 存在结构性死局：

1. **官方收编与硬件封锁**：ChatGPT、Claude、豆包、Open WebUI（v0.12.0 Realtime）、AnythingLLM、Hermes Desktop、Zotero 9/10（macOS `entitlements.xml` 硬禁 `audio-input`）与 Raycast Pro 均已完成官方原生语音占坑或缺乏前端音频扩展口；VS Code 系列扩展 Webview 截至 2026-11 仍拦截 `getUserMedia`（`microsoft/vscode#323602`），退回 Node 录音会直接摧毁同页 AEC3。
2. **个人开发者制度高墙**：飞书、钉钉（含深度合成算法备案高额罚则）、企业微信、WPS 官方市场与 Microsoft 365 AppSource 均将个人开发者排除在公开应用市场之外。
3. **Obsidian 的稀缺结构空白**：截至 2026-11-21，Obsidian 官方目录共有 **10,682 款插件**，且插件 ID **`voice-mode` 空闲可用**；虽然头部 RAG 插件（`Copilot` 330 万、`Smart Connections` 120 万）已占领对话心智，但社区至今缺乏“零外部服务、开箱离线中文/中英混说听写 + Markdown 表格降噪朗读 + 零耦合兼容第三方侧栏”的通用语音 I/O 层（需手配 WebSocket 服务的 `Local Speech Recognition` 仅 181 下载）。
4. **系列化母仓价值**：Obsidian 桌面端采用 Electron（Chromium 内核），天然适合验证与打磨零依赖 `@voice-mode/core` 和 `@voice-mode/browser`，随后可在 2–3 周内高复用复刻到同样拥有无沙箱浏览器的 **SillyTavern**（Wave 2），再向上统一 **Chrome/Edge 扩展 + 本机 `voice-daemon`**（Wave 3）。

## 决策

1. 以 **`obsidian-voice-mode`（官方插件 ID `voice-mode`）** 作为跨平台 Voice Mode 系列化矩阵的首发旗舰仓库。
2. 在本仓内部从第一天起即采用三包 Monorepo 结构：
   - `packages/voice-core`（`@voice-mode/core`）：零依赖、宿主无关纯内核；
   - `packages/voice-browser`（`@voice-mode/browser`）：浏览器/Electron 音频采集、AudioWorklet 重采样、AEC3 探针与播放队列契约；
   - `packages/obsidian-plugin`（`@voice-mode/obsidian-plugin`）：极薄的 Obsidian 宿主适配层，打包输出仓库根目录 `main.js`。
3. 明确定位为**“与 Copilot / Smart Connections 和平共存的通用离线语音 I/O 层”**，不重造全库向量 RAG，而是通过 `document.activeElement` 聚焦注入赋能用户已有 AI 侧栏。
4. 明确将 Wave 2 锁定为 `sillytavern-voice-mode`、Wave 3 锁定为统一本机 `voice-daemon` + Chrome/Edge MV3 扩展 + 反哺 `dsh-voice-mode`；劝退企业 IM 商店、VS Code、Logseq、Raycast 及无前端扩展口的 AI 客户端。

## 后果

- **正面**：零企业资质摩擦、无第三方网站每周改版的 DOM 维护税；官方社区目录兼吃海外与中文 PKMer 自然流量；三包拆分让 Wave 2（SillyTavern）与 Wave 3（浏览器扩展）可直接复用 75%+ 核心语音管线。
- **代价与约束**：必须严格遵守 Obsidian 插件生态的审核规范（`eslint-plugin-obsidianmd`、单文件 `main.js` 体积预算、移动端降级与 `SecretStorage` 约束），不能把 Obsidian 私有 API 泄露进 `voice-core` 或 `voice-browser`。
