# 官方目录提审与开源发布增长手册（Launch Playbook）

> **执行状态（2026-11-22）**：M0–M4 本机桌面真机、四项发版声学必过门禁（`A-1`–`A-4`）、401/500 密钥脱敏审计、全新空 Vault 3 文件与 `BRAT 2.2.0` 双冒烟、实网 `MiMo` 云端朗读、`Android 15 AVD Emulator (Obsidian 1.15.1 APK, System WebView 124.0)` `M-1`–`M-5` 验证及 `Xcode iOS 27.0 Simulator WKWebView harness` 验证均已完成闭环；15 秒横竖屏有声演示（`release-assets/`）与全渠道即发定稿见 [launch-kit.md](launch-kit.md)。当前遵守“先不发”边界，待用户授权后打正式无 `v` Tag（`0.1.0`）并提交 `obsidianmd/obsidian-releases` PR。

---

## 1. `obsidianmd/obsidian-releases` 官方目录提审全流程自检

Obsidian 官方社区目录（截至 2026-11-21 共 10,682 插件，`voice-mode` ID 空闲）采用 **`ObsidianReviewBot` 自动化扫描 + 人工维护者复核**双审制。以下按最高频拒审点逐一排雷：

### 1.1 Manifest 与仓库结构硬检查

- [x] `manifest.json` 关键字段合规（由 `scripts/check-release-gate.mjs` 每次构建强制门禁）：
  - `"id": "voice-mode"`（与 `community-plugins.json` PR 条目完全一致，不含 `obsidian` 字样）；
  - `"name": "Voice Mode"`（不以 `Obsidian` 开头或结尾）；
  - `"description"` 简洁明了、句尾带句号、不重复插件名、不含 “for Obsidian”；
  - `"minAppVersion": "1.11.4"`（显式对齐 `app.secretStorage` 最低版本，且 `versions.json` 含对应映射）；
  - `"isDesktopOnly": false`（已在 `Android 15 AVD Emulator (Obsidian 1.15.1 APK, System WebView 124.0)`、`Xcode iOS 27.0 Simulator WKWebView harness` 及 Apple `JavaScriptCore` 完成 `M-1`–`M-5` 验证；可选口袋物理真机复核说明见验收清单）。
- [x] **Git Tag 无 `v` 前缀**：正式发布 Tag 必须为裸语义化版本号（如 `0.1.0` 或 `1.0.0`，严禁 `v0.1.0`），与 `manifest.json` `version` 逐字一致（已由 `.github/workflows/release.yml` 强制门禁）。
- [x] **GitHub Release 附件严格仅 3 个文件**：`main.js`、`manifest.json`、`styles.css`；严禁附加源码 zip、`.wasm`、模型文件或 source map；`main.js` 体积 `284.13 KB < 5 MB`（严守 `< 1 MB` 目标预算）。
- [x] **根目录 `README.md` 为英文**：Obsidian 社区商店直接渲染仓库根目录 `README.md`；中英文顶部互链，且提前完整披露所有外部网络域名、SHA256 校验与隐私边界。

### 1.2 `ObsidianReviewBot` 高频拒审点排雷表

| 高频拒审项 | 典型触发原因 | 本仓库防线 |
| --- | --- | --- |
| **不安全 DOM 操作** | 使用 `innerHTML`、`outerHTML`、`document.write` 或未转义拼接 HTML | `eslint-plugin-obsidianmd` 强制报错 + 全量改用 Obsidian `createEl` / `createDiv` / `setText` |
| **全局事件与定时泄漏** | 直接 `window.addEventListener` / `setInterval` 却未在 `onunload()` 清理 | 统一走 `this.registerEvent`、`this.registerDomEvent`、`this.registerInterval` |
| **明文保存 API Key** | 把密钥存进 `loadData()` / `saveData()`（落盘 `data.json`） | 全量走 `app.secretStorage` + `SecretComponent`（ADR-0003） |
| **设置项与命令命名不规范** | 设置标题使用 Title Case（Obsidian 规范要求 Sentence case）、命令含插件名重复前缀 | `eslint-plugin-obsidianmd` 规则 `obsidianmd/ui/sentence-case` 等入 CI |
| **未披露外部网络与模型下载** | 静默后台下载模型或未在 README 说明访问的域名、上传数据与隐私边界 | 用户显式点击才下载；`README.md` 与 `SECURITY.md` 完整列明所有域名、SHA256 与数据流 |
| **绕过插件更新机制** | 运行时从远端拉取并执行第三方 JS 代码 | 仅下载静态模型数据文件，严禁热更可执行脚本 |
| **移动端误调 Node API** | `isDesktopOnly: false` 但顶层静态 `import fs` 导致 iOS 报错 | 桌面专属文件缓存动态隔离并受 `Platform.isDesktopApp` 守卫 |
| **虚假或夸大 PR 描述** | 提审 PR 未勾选全部校验项、缺少实机截图或宣称未实现功能 | 提审前全量复跑 `pnpm run check:all` 与 `docs/qa/acceptance-checklist.md` |

### 1.3 提审步骤与 `community-plugins.json` 标准条目

1. 完成 iOS/Android 移动物理设备最终复核并在干净测试 Vault 验证 3 文件（`main.js`、`manifest.json`、`styles.css`）离线手动安装与 BRAT 安装；
2. 确认 `CHANGELOG.md` 具备与目标版本号一致的 `## [<version>]` 章节，推送首个无 `v` 前缀正式 Tag（如 `0.1.0` 或 `1.0.0`），确认 `.github/workflows/release.yml` 成功生成仅含 3 个附件的 GitHub Release；
3. Fork `obsidianmd/obsidian-releases`，在 `community-plugins.json` **文件末尾**追加以下与 `manifest.json` 严格对齐的条目（不重排他人条目）：

```json
  {
    "id": "voice-mode",
    "name": "Voice Mode",
    "author": "qishuilalala",
    "description": "Offline-first bilingual voice dictation, Markdown-aware read-aloud, and optional BYOK voice Q&A.",
    "repo": "qishuilalala/obsidian-voice-mode"
  }
```

4. 提交 PR，等待 `ObsidianReviewBot` 首次自动评论；如出现任何 Warning/Required 项，24 小时内通过新小版本 Tag（如 `0.1.1` / `1.0.1`）修复并在 PR 中回复核验说明。

---

## 2. 15 秒有声爆款 Demo 分镜脚本

> **核心原则**：15 秒讲透竞品做不到的 4 个硬卖点——**真离线 + 中英混说词表零错字 + 表格降噪朗读 + 零耦合赋能 Copilot 侧栏**。使用真实 Obsidian 界面交互与真实语音合成音轨同步呈现，导出 1080p 60fps 横屏（YouTube/B 站/GitHub）与 9:16 竖屏（小红书/Shorts）两版。

| 时间轴 | 画面焦点（Visual） | 真实音频（Audio） | 屏幕醒目字幕（On-Screen Caption） | 验证的差异化痛点 |
| --- | --- | --- | --- | --- |
| **0:00 – 0:02** | 特写系统状态栏点击开启**飞行模式 / 断网图标**，切回 Obsidian 空白笔记，按下快捷键麦克风状态条亮起 | 清脆提示音（无背景杂音） | `Offline · Zero External Server` / `完全断网 · 零外置服务` | 一秒击穿“必须装 Python/WebSocket 服务”与“隐私上云”焦虑 |
| **0:02 – 0:06** | 对着麦克风自然中英混说含专有名词的句子（含 1 个事先配好的词表术语，如 `Obsidian` / `Zettelkasten` / `SenseVoice`），文字带完整中英文标点与纠错命中实时落入光标处 | 真实人声口述（中英混说，语速自然） | `Bilingual Dictation + Custom Dictionary` / `中英混说自动标点 · 专属词表零错字` | 直击中文 + 英文混说标点乱、同音专有名词总写错的刚需 |
| **0:06 – 0:11** | 切到一篇含代码块与 4×4 Markdown 管道表格的真实笔记，点击「朗读」：朗读高亮自动跳过 `| --- |` 表格与代码块，底部清晰滚动双语字幕 | 流畅自然朗读声（实机录制） | `Skips Tables & Code · Live Captions` / `跳过 Markdown 表格与代码 · 同步字幕朗读` | 瞬间与机械念出“竖线杠杠杠竖线”的普通 TTS 插件拉开代差 |
| **0:11 – 0:15** | 将光标点进右侧已安装的 **Copilot** 侧栏输入框，按同一快捷键口述一句“帮我总结这篇笔记的三个核心观点”，文字直接注入侧栏并回车出结果；结尾定格 `Voice Mode for Obsidian (MIT)` + GitHub Repo | 人声口述 + 轻快结束音 | `Works Inside Copilot Sidebar · MIT Open Source` / `直接给 Copilot 语音提问 · MIT 开源` | 不抢占已有 AI 插件心智，借助 330 万 Copilot 用户盘实现顺风借势 |

---

## 3. 国内外首发渠道排期与差异化标题文案

坚持“**先在 GitHub + BRAT 小范围验证稳定性 → 官方目录过审当天集中引爆 → 3 天后按中文深度教程长尾收口**”的三段式节奏，避免未过审先引流导致普通用户因不会手动安装而流失。

| 窗口 | 目标渠道 | 调性与受众 | 建议标题 / 切入角度 | 内容重点 |
| --- | --- | --- | --- | --- |
| **D-7（过审前公测）** | **Obsidian 中文论坛 / PKMer 社群 / GitHub Discussions** | 种子极客、BRAT 尝鲜用户 | 《测试征集：免装外部服务的 Obsidian 离线中英语音插件（支持表格降噪朗读与词表纠错）》 | 提供 BRAT 链接、诚实标注待测项、收集真实 OS/声卡/Copilot 兼容性反馈 |
| **D0（上架当天·海外主阵地）** | **Reddit `r/ObsidianMD`** | 全球核心 Obsidian 重度用户 | `I built an open-source, offline-first Voice Mode for Obsidian — bilingual dictation, Markdown/table-aware read-aloud, and zero-coupling Copilot sidebar input (no external server)` | 顶部直嵌 15 秒有声视频；明确写清模型大小、Vault 外缓存、`SecretStorage` 隐私边界与移动端降级 |
| **D0（上架当天·海外技术向）** | **Hacker News (Show HN)** | 架构与隐私敏感型开发者 | `Show HN: Obsidian Voice Mode – Local WASM speech pipeline with zero-dep BYOK router and Obsidian SecretStorage` | 聚焦工程硬核点：Electron V8 Memory Cage 规避、WASM 实测基准、`<400` 行零依赖 `llm-router`、GPL-3.0 `espeak-ng-data` 运行时隔离 |
| **D0–D+1（视频沉淀）** | **YouTube / B 站** | 搜索长尾 + 演示直观转化 | YouTube：`Offline Voice Mode for Obsidian (No Server, Skips Tables, Works with Copilot)`<br/>B 站：《断网也能用！我给 Obsidian 做了个零外置服务的开源语音插件：中英混说+表格降噪朗读》 | 15 秒开场暴击 + 2 分钟配置实操（展示 `hf-mirror.com` 国内直连下载与词表纠错） |
| **D+1（国内高转化图文）** | **少数派 / PKMer / V2EX (`/go/create`)** | 效率工具付费意愿高人群 & 独立开发者 | 少数派：《在 Obsidian 里实现真离线中英语音听写与朗读：为什么我放弃外置服务，重新写了一套开源语音层》<br/>V2EX：《开源了一个 Obsidian 离线语音插件 voice-mode：无需部署后端，内置纠错词表，直接给 Copilot 语音输入》 | 讲清痛点对比（181 下载的外部服务门槛 vs 一键安装）、隐私安全设计与开源矩阵路线 |
| **D+2（短视频破圈）** | **小红书** | 大众知识管理 / 科研 / 写作者 | 《Obsidian 终于能断网直接语音写笔记了！中英混说零错字，还能直接对 Copilot 说话》 | 9:16 竖屏 15 秒 Demo + 3 张配置图卡片（评论区放开源仓库与社区插件搜索词 `Voice Mode`） |
| **D+3 – D+7（开源聚合长尾）** | **阮一峰《科技爱好者周刊》Issue / HelloGitHub 提报** | 高质量中文开发者长尾流量 | 简洁客观提报：MIT 开源、三包架构（`@voice-mode/core` 零依赖复用）、实测基准与真离线隐私架构 | 附 15 秒 GIF/截图、明确声明支持范围与已知限制，杜绝营销腔 |

---

## 4. 跨仓库开源系列矩阵协同导流策略

避免每个仓库孤立冷启动，在 GitHub Profile、各仓库 README 底部与 Release Notes 中建立统一的 **Voice Mode Open-Source Matrix** 互链导航：

1. **已发布前置锚点 → `dsh-voice-mode`**：
   - 在 `dsh-voice-mode` README 的“相关开源项目”区链接 `obsidian-voice-mode`，说明本仓将其沉淀的语音引擎抽离为宿主无关 `@voice-mode/core`，承接非编程知识库写作场景。
2. **Wave 1 主爆点 → `obsidian-voice-mode`（本仓）**：
   - 依托 Obsidian 官方社区目录的长尾自然搜索（`voice`、`dictation`、`speech`、`read aloud`、`offline`），沉淀首批核心 Star 与 Issue 社区；
   - 在 README 路线图区串联 Wave 2（[`sillytavern-voice-mode`](https://github.com/qishuilalala/sillytavern-voice-mode) 全双工情感语音）与 Wave 3（[`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon) 统一本机守护进程 + MV3 扩展），引导关注 GitHub Release 与 Discussions。
3. **Wave 2 双爆点 → [`sillytavern-voice-mode`](https://github.com/qishuilalala/sillytavern-voice-mode)**：
   - 复用 `75.05%` `@voice-mode/core` + `@voice-mode/browser`，借 SillyTavern 垂直社群（Reddit `r/SillyTavernAI`、Discord、B 站酒馆圈）引爆第二波 Star，反向为 `@voice-mode/core` 与本仓导流。
4. **Wave 3 基础设施留存 → 统一 [`voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon) + Chrome/Edge 扩展**：
   - 当用户同时使用 Obsidian、SillyTavern、浏览器扩展或 `dsh-voice-mode` 时，通过可选一键安装 `voice-daemon` 实现**“下载一次模型，四端共享缓存 + 解锁 Kokoro 103 音色”**，把单次尝鲜流量沉淀为跨软件长期留存用户。
