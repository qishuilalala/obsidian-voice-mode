# 验收检查清单（QA Acceptance Checklist）

> **铁律**：自动化单测（`pnpm run test`）与构建门禁（`pnpm run check:all`）仅证明纯逻辑、类型与打包契约正常，**绝不能替代真机声学、Electron 内存与移动端硬件验收**。未实测项一律标记 `Pending`，禁止凭他仓或历史数据勾选通过。

---

## 1. M0 开工前 6 项真机 Spike 门禁（阻断 M1 业务开发）

执行环境要求：真实桌面版 Obsidian（记录 App 版本、Installer / Electron 版本、操作系统、CPU/内存与音频设备），新建空白测试 Vault。

| 编号 | Spike 主题 | 实测步骤与观测指标 | 量化通过门禁（Pass Gate） | 未通过时的回退触发 | 当前状态 | 实测记录（日期 / 环境 / 数值） |
| --- | --- | --- | --- | --- | --- | --- |
| **S0-1** | **Obsidian 桌面端（Electron 43.7.5 / 43.8.9）Web Worker WASM 基准** | 在桌面 Obsidian 插件内起独立 Web Worker，分别加载 `Silero VAD`、`SenseVoice int8` 与可选 `VITS`；连续运行 15 分钟听写会话并观察空闲卸载 | `SenseVoice int8` 冷加载 `< 2 s`、`RTF < 0.6`、单模型常驻 RSS 增量 `< 700 MB`（总内存可控）、15 分钟无持续内存爬升、卸载 Worker 后 RSS 可回落 | 切为可选本机 `voice-daemon` + BYOK 云端 ASR 默认兜底，修订 ADR-0002 | `Pending` | 待 M0 实测填写 |
| **S0-2** | **Vault 外模型缓存与 Obsidian Sync 隔离** | 将 200 MB+ 测试权重写入 OS 应用缓存目录（Vault 之外），触发文件读写、重启 Obsidian 并核查 Obsidian Sync / Git 状态 | Vault 内 `.obsidian/plugins/voice-mode/` 与笔记目录零模型文件；Obsidian Sync 无大文件扫描/报错；macOS 与 Windows 重启后稳定可读 | 为沙盒化 Linux（Flatpak/Snap）提供用户自选 Vault 外目录配置项 | `Pending` | 待 M0 实测填写 |
| **S0-3** | **主编辑器与 Copilot 等第三方侧栏聚焦注入** | 分别在 CodeMirror 6 笔记编辑区、搜索框及 Copilot（React/Svelte 侧栏输入框）连续注入 10 次含中文、英文与换行的文本 | 10/10 次准确插入光标位置，不吞字、不丢失焦点、Undo/Redo 栈正常 | 对不兼容受控框架的侧栏提供剪贴板暂存 + Notice 提示降级分支 | `Pending` | 待 M0 实测填写 |
| **S0-4** | **国产与海外 LLM API CORS / SSE 实测矩阵** | 在 Obsidian 桌面端分别通过 `fetch` 与 `requestUrl` 实测 DeepSeek、阿里云百炼 Qwen、火山方舟 Doubao、Kimi、硅基流动、OpenRouter、Anthropic 及本机 Ollama | 形成逐厂商实测表（是否支持浏览器 CORS、流式 SSE 分片格式、火山方舟是否需 `ep-xxx`、Ollama `OLLAMA_ORIGINS` 报错表现） | 遇 CORS 阻断的厂商默认路由走 Obsidian `requestUrl` 并标注非流式/流式差异 | `Pending` | 待 M0 实测填写 |
| **S0-5** | **`sherpa-onnx` WASM 算子与长会话回归** | 在最新 `sherpa-onnx` WASM 发行版上复验 `#3960`（`kokoro-int8` 全零静音）与 `#1939`（15 分钟变长句 TTS 内存增长） | 明确结论：若 `#3960` 未修则 M2 禁用 WASM Kokoro；若 VITS 长会话 RSS 稳定则开放桌面可选离线 VITS，否则 M2 仅启用系统/BYOK TTS | M2 朗读默认系统语音 + BYOK，Kokoro 留待 Wave 3 `voice-daemon` | `Pending` | 待 M0 实测填写 |
| **S0-6** | **Electron 原生 AEC3 与移动端能力探针** | 桌面外放播放音频同时采集麦克风，检查 `getSettings().echoCancellation` 与回声残差；移动端确认 `Platform.isMobile` 分支与 `SecretStorage` 可用性 | 桌面外放可区分“原生 AEC3 有效”与“须降级 `manual`”；移动端准确屏蔽重型 WASM 加载且无未捕获异常 | 外放回声残差超阈值时默认锁定 `bargeInMode=manual` 并弹出状态提示 | `Pending` | 待 M0 实测填写 |

---

## 2. 发版前四项真机声学必过门禁（M3 → M4 正式发版强制阻断）

> 适用于 M3 封板及后续每次涉及音频管线、分句、字幕或打断逻辑的正式版发布。**任一项失败立即暂停发布**，定位修复后全量复跑。

| # | 必过项 | 真机操作步骤 | 预期结果（全部满足才算 Pass） | 当前状态 | 实测环境与日期 |
| --- | --- | --- | --- | --- | --- |
| **A-1** | **字幕渲染与长内容换行** | 开启朗读字幕，切最大字号与窄宽度档位，朗读包含中文长句、英文术语与长 URL 的笔记，并切换浅色/深色主题 | 字幕清晰可读且自动换行不截断、不遮挡关键编辑按钮；浅/深主题文本对比度 `>= 4.5:1`；停止或切笔记后字幕 `< 100 ms` 消失无残留 | `Pending` | 待 M2/M3 实测 |
| **A-2** | **Markdown / 表格降噪朗读与打断** | 打开含 Frontmatter、代码块与 5×5 管道表格的真实笔记启动朗读；朗读中途于外放（AEC 生效）或耳机下开口说话（或在 `manual` 档按键打断） | 零念出 YAML frontmatter、代码符号与 `| --- |` 表格分隔符；打断后朗读与字幕在 `< 600 ms`（`manual` `< 150 ms`）内彻底中止且队列清空 | `Pending` | 待 M2/M3 实测 |
| **A-3** | **60 秒连续中英混说 + 纠错词表** | 断网（飞行模式）状态下，冷启动后连续口述 60 秒中英混合笔记（含 5–6 次自然换气及至少 3 个已配置纠错词表专有名词） | 无卡死、无 OOM 崩溃；最终上屏文本完整无丢头尾，已配置词表 100% 命中替换，单句定稿无明显阻塞 | `Pending` | 待 M1/M3 实测 |
| **A-4** | **`bargeInMode=manual` 外放零自打断** | 将打断模式设为 `manual` 并使用设备外放：全程播放 2 分钟笔记朗读不说话；随后按住触发键口述一句笔记并松手 | 朗读全程 **0 次**回声误触发自打断；按键口述完整识别上屏；松手后无残余录音占用麦克风指示灯 | `Pending` | 待 M2/M3 实测 |

### 附加安全与隐私复核（每次发版必做）

- [ ] 检查测试 Vault 下 `.obsidian/plugins/voice-mode/data.json`：**零明文 API Key / Token**。
- [ ] 检查 Developer Console 与日志输出：触发一次 401/500 错误响应，确认密钥与 `Authorization` 头已被完全脱敏。
- [ ] 检查测试 Vault 根目录与 `.obsidian/`：确认**零模型二进制文件**写入 Vault，Obsidian Sync 状态正常。

---

## 3. 移动端（iOS / Android）降级验证表（M3 必过）

Obsidian 社区商店要求 `isDesktopOnly: false` 的插件必须在移动端稳定运行且不因 Node API 或内存超限崩溃。

| 编号 | 验证项 | iOS（WKWebView / ~500 MB Jetsam 红线） | Android（WebView） | 预期行为 | 当前状态 |
| --- | --- | --- | --- | --- | --- |
| **M-1** | **插件加载与零 Node 依赖崩溃** | 实机安装启用，开启控制台观察 | 实机安装启用，开启控制台观察 | 无 `require('fs')` / `require('child_process')` / `Buffer` 报错，设置页完整打开 | `Pending` |
| **M-2** | **重型离线 WASM 模型强制屏蔽** | 检查设置页与命令面板 | 检查设置页与命令面板 | `Platform.isMobile` 下自动隐藏或锁定 200 MB+ 本地 WASM 下载入口，附清晰说明“桌面端支持本地离线模型，移动端请使用 BYOK 或系统语音” | `Pending` |
| **M-3** | **BYOK 听写与语音问答闭环** | 通过 `SecretStorage` 配置 API Key 并完成一次听写/问答 | 同左 | 凭证安全保存不进 `data.json`；请求正常返回并写入当前笔记光标处 | `Pending` |
| **M-4** | **系统朗读与长时内存稳定性** | 连续朗读 5 分钟长笔记并来回切换 5 篇文档 | 同左 | 音频播放/暂停/停止可控；iOS 无 WKWebView Jetsam 闪退或页面白屏重载 | `Pending` |
| **M-5** | **麦克风权限拒绝优雅降级** | 在系统设置拒绝麦克风权限后点击听写 | 同左 | 显示可读的中文/英文指引 Notice，绝不静默卡在“录音中”状态 | `Pending` |
