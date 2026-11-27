# 验收检查清单（QA Acceptance Checklist）

> 自动化检查验证类型、逻辑与打包。下文的声学和内存数据来自各行标明的环境。Android 15 模拟器加载了 Obsidian 1.15.1 APK，iOS 27 模拟器加载了独立的 WKWebView 测试程序。这里没有实体手机或 iOS App Store 客户端的验收记录。
> 首发四条用户路径（首次麦克风授权、听写回填、朗读、拒绝授权后恢复）的自动化与真机清单见[首次验收矩阵](first-run-acceptance-matrix.md)。

---

## 1. M0 开工前 6 项真机 Spike 门禁（已完成实测闭环 · 2026-11-22）

- **实测宿主与硬件环境**：
  - **硬件 / OS**：Apple M2 Max（32 GB 统一内存），macOS `27.2.1`（Build `26B131`）；
  - **宿主版本**：Obsidian App `1.15.1` / Installer `1.15.1`（`Electron 43.8.9`、`Chromium 150.0.7871.250`、`Node 24.22.1`、`V8 15.0.245.31-electron.0`）；
  - **音频设备**：内置 `MacBook Pro麦克风`（48 kHz 单声道）+ 内置 `MacBook Pro扬声器`（48 kHz 双声道）；
  - **隔离测试 Vault**：`~/.cache/voice-mode/dev-vault`（仅启用 `voice-mode`；S0-3 临时挂载官方 `Copilot 4.0.20` 实测后已完整卸载并清理 `.obsidian/plugins/copilot`、`copilot/`、`.copilot/` 与 `.claude/`）。

| 编号 | Spike 主题 | 实测步骤与观测指标 | 量化通过门禁（Pass Gate） | 未通过时的回退触发 | 当前状态 | 实测记录（2026-11-22 / Obsidian `1.15.1` · Electron `43.8.9`） |
| --- | --- | --- | --- | --- | --- | --- |
| **S0-1** | **Obsidian 桌面端（Electron 43.8.9）Web Worker WASM 基准** | 在桌面 Obsidian 插件渲染进程内起独立 Web Worker（强制 `ENVIRONMENT_IS_NODE=false` 隔离 `MEMFS` + `fh.read` 单份 `ArrayBuffer` 零拷贝传输 + 初始化后 `FS.unlink`），加载 `sherpa-onnx@2.0.2` WASM、`Silero VAD`、`SenseVoice int8` 与独立 `VITS`；连续运行 **900 秒（15 分钟 / 60 轮真实中英混说语料）** 会话并实测 `worker.terminate()` 空闲卸载 | `SenseVoice int8` 冷加载 `< 2 s`、`RTF < 0.6`、单模型常驻 RSS 增量 `< 700 MB`、15 分钟无持续内存爬升、卸载 Worker 后 RSS 可回落 | 切为可选本机 `voice-daemon` + BYOK 云端 ASR 默认兜底，修订 ADR-0002 | **`Pass`** | WASM 初始化 `18–19 ms`、`Silero VAD` 冷载 `30–32 ms`、`SenseVoice int8` 冷载 **`485–488 ms`**；5s/53.1s 真实中英混说语料 `RTF = 0.2148–0.2589`（60 轮均值 **`0.2148`**）；加载峰值渲染进程 RSS 增量 **`+527.5 MB`**（`430.3 -> 957.8 MB`），稳态常驻 `728.3 -> 779.0 MB`（增量 `+348.7 MB`，WASM 线性堆全程恒定 **`512 MB`** 零增长）；`worker.terminate()` 后 5s/30s 渲染进程 RSS 回落至 **`472.7 / 469.3 MB`**（整机 App RSS `1100.5 -> 790.8 MB`） |
| **S0-2** | **Vault 外模型缓存与 Obsidian Sync 隔离** | 将 `245.3 MB` 权重与 WASM（`silero_vad.onnx`、`SenseVoice model.int8.onnx` + `tokens.txt`、`sherpa-onnx@2.0.2` WASM 及 JS 胶水共 8 个文件）写入 `~/.cache/voice-mode/models/`，实测固定 SHA256 校验、重启 Obsidian 复读与 Vault/Sync 扫描检查 | Vault 内 `.obsidian/plugins/voice-mode/` 与笔记目录零模型文件；Obsidian Sync 无大文件扫描/报错；重启后稳定可读 | 为沙盒化 Linux（Flatpak/Snap）提供用户自选 Vault 外目录配置项 | **`Pass`** | `~/.cache/voice-mode/models` 共 `257,212,511 bytes`（`245.3 MB`），3 项模型权重与 WASM 二进制（`7ed88e41...`）等全部固定 SHA256 100% 匹配；渲染进程读取 + `crypto.subtle.digest` 耗时 `245 ms`（`1000.4 MB/s`），彻底杀进程重启（PID `32830 -> 38130`）后复读 `405 ms`（`605.2 MB/s`）；`app.vault.getFiles()` 与 `.obsidian/plugins/voice-mode/` 模型文件数均为 **`0`**，Sync 核心插件启用态无异常 |
| **S0-3** | **主编辑器与 Copilot 等第三方侧栏聚焦注入** | 分别在 CodeMirror 6（`M0-Test-Note.md`）、全局搜索框、Shadow DOM `<textarea>` 及真实 **Obsidian Copilot `4.0.20`**（Lexical `div[contenteditable="true"][role="textbox"]`）连续注入 10 次含中英与 `\n` 文本 | 10/10 次准确插入光标位置，不吞字、不丢失焦点、Undo/Redo 栈正常 | 对不兼容受控框架的侧栏提供剪贴板暂存 + Notice 提示降级分支 | **`Pass`** | CM6 主编辑器 **`10/10`**（Undo/Redo 正常）、搜索框 **`10/10`**、Shadow DOM `<textarea>` **`10/10`**；经内存态合成 `ClipboardEvent("paste")`（零污染系统剪贴板，未 `defaultPrevented` 时回退 `Range`），Copilot `4.0.20` 达成 **`10/10` 逐字精确追加 + `LineBreakNode` + Undo/Redo 通过**（已沉淀为 `@voice-mode/browser` `FocusTextInjector`） |
| **S0-4** | **国产与海外 LLM API CORS / SSE 实测矩阵** | 在 Obsidian `1.15.1`（`Origin: app://obsidian.md`）分别用浏览器 `fetch`（`redirect: 'error'`）与 `requestUrl` 实测 8 家云端 API 的 CORS 预检/POST 可读性，并用本机 `node:http` 回环服务验证 Ollama `Origin` 规则与 `fetch` 流式 SSE 分片 | 形成逐厂商实测表（CORS 可达性、流式 SSE 分片、`requestUrl` 差异与 Ollama `OLLAMA_ORIGINS` 报错表现） | 遇 CORS 阻断的厂商默认路由走 Obsidian `requestUrl` 并标注非流式/流式差异 | **`Mitigated`（Pass）** | 完整实测表见下方 **§1.1**：**DeepSeek、百炼 Qwen、Kimi、SiliconFlow、OpenRouter、Anthropic（带直连头）** 均通过 `Origin: app://obsidian.md` CORS；**火山方舟 Doubao、OpenAI** 遭渲染进程 CORS 阻断但经主进程 `requestUrl` 100% 可达；回环验证 `fetch` `ReadableStream` 收齐 `3` 个 SSE 分片且无感处理未配 `OLLAMA_ORIGINS` 回退 |
| **S0-5** | **`sherpa-onnx` WASM 算子与长会话回归** | 在 `sherpa-onnx@1.13.6`（ORT `1.27.1`）与最新 `sherpa-onnx@2.0.2`（ORT `1.28.2`，2026-11-19）复验 `#3960`（`kokoro-int8`）与 `#1939`（80 句变长 VITS 内存曲线） | 若 `#3960` 未修则 M2 禁用 WASM Kokoro；若 VITS 长会话 RSS 稳定则开放桌面可选离线 VITS | M2 朗读默认系统语音 + BYOK，Kokoro 留待 Wave 3 `voice-daemon` | **`Mitigated`（Pass）** | **`#3960` 未修**：`1.13.6` 与 `2.0.2` 运行 `kokoro-int8-multi-lang-v1_1` 均输出 `100% NaN` 全静音，故禁用 WASM Kokoro（留归 Wave 3 `voice-daemon`）；**`#1939` 已修**：`2.0.2` 下 `vits-zh-ll` 连续合成 **80 句变长中文**（`508.14 s` 音频）RSS 收敛稳定在 **`438 MB`**（`RTF = 1.22–1.275`），作为桌面可选离线引擎 |
| **S0-6** | **Electron 原生 AEC3 与移动端能力探针** | 对比 48 kHz `autoGainControl: false` 下 `HTMLAudioElement` 与系统 `speechSynthesis` 的扬声器→麦克风回声残差；核验 `SecretStorage` 与移动端守卫 | 桌面外放可区分“原生 AEC3 有效”与“须降级 `manual`”；移动端守卫准确屏蔽重型 WASM 加载 | 外放回声残差超阈值或无参考流时默认锁定 `bargeInMode=manual` | **`Mitigated`（Pass）** | 置 `autoGainControl: false` 后 `HTMLAudioElement` 外放原生 AEC3 抑制 **`+8.99 dB`**（`0.003059` vs `0.008615`），而系统 `window.speechSynthesis` 无 Chromium 参考流（残差 `0.007492`），故 `ttsEngine="system"` 或 `nativeAecActive=false` 时强制锁定 `bargeInMode=manual`；`app.secretStorage` 读写正常、`data.json` 零密钥 |

### 1.1 S0-4 逐厂商 `Origin: app://obsidian.md` 实测矩阵（Obsidian `1.15.1` / Electron `43.8.9`）

| 厂商 / 测试项 | 测试端点 | 渲染进程 `fetch`（`Origin: app://obsidian.md`） | Obsidian `requestUrl`（主进程非流式） | 路由策略 |
| --- | --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`251 ms`） | **可达**（HTTP 401，`120 ms`） | 默认 `fetch` 流式 SSE |
| `dashscope-qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`239 ms`） | **可达**（HTTP 401，`171 ms`） | 默认 `fetch` 流式 SSE |
| `volcengine-doubao` | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | **CORS 阻断**（`TypeError: Failed to fetch`） | **可达**（HTTP 401 JSON 可读，`148 ms`） | 自动回退无 CORS 流 / `requestUrl` |
| `moonshot-kimi` | `https://api.moonshot.cn/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`357 ms`） | **可达**（HTTP 401，`244 ms`） | 默认 `fetch` 流式 SSE |
| `siliconflow` | `https://api.siliconflow.cn/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`174 ms`） | **可达**（HTTP 401，`118 ms`） | 默认 `fetch` 流式 SSE |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`1446 ms`） | **可达**（HTTP 401，`1125 ms`） | 默认 `fetch` 流式 SSE |
| `openai` | `https://api.openai.com/v1/chat/completions` | **CORS 阻断**（`TypeError: Failed to fetch`） | **可达**（HTTP 401 JSON 可读） | 自动回退无 CORS 流 / `requestUrl` |
| `anthropic` | `https://api.anthropic.com/v1/messages` | **CORS 放行**（带 `anthropic-dangerous-direct-browser-access: true`，`2195 ms`） | **可达**（HTTP 401，`495–1457 ms`） | 内置直连头走 `fetch` 流式 SSE |
| 回环模拟（Ollama `Origin` & SSE） | `http://127.0.0.1:<port>/v1/chat/completions` | `strict-ollama` 拒 `app://obsidian.md`（403）；允许时收齐 **`3` 个 SSE 分片**（`106 ms`） | `strict-ollama` 与 `allow` 下均**直接可达**（HTTP 200，`106 ms`） | `fetch` 遇 CORS 阻断自动无感回退，免配 `OLLAMA_ORIGINS` |

### 1.2 M1 桌面离线 WASM 听写闭环真机验收记录（2026-11-22 / Obsidian `1.15.1`）

- **断网零外联与模型暖校验**：拦截 `window.fetch` 与 `https.get` 强制抛错条件下，插件重载、设置页渲染与完整听写外联请求数为 **`0`**；`DesktopModelManager.checkStatus()` 暖校验 `245.3 MB`（8 文件）耗时 **`1 ms`**。
- **单句定稿延迟与 53.1s 连续多段听写**：冷启动加载 `MEMFS` Worker 耗时 **`769 ms`**；`4.8 s` 单句定稿延迟 **`1,245 ms < 1,500 ms`**；`53.1 s` 六段中英混说流式馈入总耗时 **`13,414 ms`**（`RTF = 0.253`），`640 ms` 预卷缓冲零吞字，3 条多别名纠错词表（`Obsidian`、`SenseVoice`、`[[双链笔记]]`）**`3/3`（100%）** 命中落盘；物理扬声器→麦克风 `push-to-talk` 采集转写归位 `idle`。

### 1.3 M2 朗读降噪、字幕对比度、切笔记瞬停与原生 AEC3 外放语音打断真机验收记录（2026-11-22 / Obsidian `1.15.1`）

- **Markdown / 5×5 管道表格降噪与播控**：含 Frontmatter、代码块、`$$` 公式、裸 URL、Callout 与 5×5 表格的长笔记朗读 **0 次**念出标记符号；`stop-read-aloud` 停止并隐藏字幕耗时 **`6.4–10.9 ms < 100 ms`**；`large` + `narrow` 字幕零横向溢出，浅色主题对比度 **`15.91:1`**、深色主题 **`12.19:1`**（`>= 4.5:1`）。
- **原生 AEC3 外放 180 秒零自打断与 `< 600 ms` 语音打断**：`bargeInMode=detect` 下独立 `bargeInWorkerClient`（`1.8 MB` `Silero VAD`）扬声器连续外放 **`180,005 ms`** 全程 **`0` 次自打断**；外部人声打断响应 **`66–370 ms < 600 ms`**。

### 1.4 M3 BYOK 语音问答、4 重护栏润色、云端 ASR 与密钥脱敏真机验收记录（2026-11-22 / Obsidian `1.15.1`）

- **`VoiceQaModal`、4 重护栏润色与 `CloudDictationSession`**：`ask-ai-about-note` 提取选区流式渲染 SSE 并支持按句跟读与 `Insert at cursor`（单例守卫 `singletonModalCount = 1`）；`applyCorrectionGuards` 100% 拦截超长/前言幻觉且 `HTTP 401` 零丢字回退原文；`OpenAiCompatAsrTransport` 上传纯 `Uint8Array` WAV 完成词表替换落盘。
- **密钥隔离与 401/500 脱敏审计**：`data.json` 明文密钥扫描 **`0` 命中**；模拟含 `Bearer` / `api_key=` 的 401/500 响应时，Modal、Notice 与 Console 全量脱敏为 `<redacted>`（明文泄漏 **`0` 命中**）。

### 1.5 M3/M4 实网 `MiMo` 云端朗读、全新空 Vault 手动 3 文件 + `BRAT 2.2.0` 双冒烟与构建门禁验收记录（2026-11-22 / Obsidian `1.15.1`）

- **全仓门禁与 `release.yml` 本地校验**：`pnpm run check:all` 全绿（单测数以 `pnpm test` 实测为准，2026-11-26 快照 **`211` 项**：`102 core + 53 browser + 56 plugin`；`eslint --max-warnings 0 .` 零警告；`llm-router.ts = 396 行 < 400 行`；`main.js = 335.56 KB / 343,613 B < 1,024 KB`；`check:release` 6/6 全过；`TAG=0.1.0` 对 `manifest.json`、`package.json`、`versions.json`、`CHANGELOG.md` `## [0.1.0]` 及 3 附件校验 100% 通过）。
- **全新空 Vault（`/tmp/voice-mode-fresh-vault`）零软链手动 3 文件 + `BRAT 2.2.0` 共存冒烟**：目录树共 `8` 个文件、**`0` 个符号链接**；在真实 `/Applications/Obsidian.app`（`1.15.1`）冷启动启用 `voice-mode` 耗时 **`5.8 ms`**，启动期外联网络请求数 **`0`**、控制台/运行时错误数 **`0`**；`voice-mode@0.1.0`（`8` 项命令）与 `obsidian42-brat@2.2.0`（`17` 项命令）无冲突共存；测毕已删除临时空库并逐字节还原 `obsidian.json`（SHA256 100% 一致）。
- **实网小米 `MiMo`（`https://api.xiaomimimo.com/v1/chat/completions`）云端朗读实测**：由内存态 CDP 瞬时注入 `app.secretStorage` 凭证并执行中英双语选区朗读，`MimoTtsEngine` 严格校验 `res.ok`（HTTP 2xx）与魔数嗅探后解码出 **`audio/wav`（`199,724 B`）**，真实 `HTMLAudioElement` 正常起播（时长 **`6.72 s`**，同步弹出底部双语字幕），主动执行 `stopReadAloud()` 耗时 **`1.3 ms < 100 ms`** 且字幕立即隐藏、状态归位 `idle`；测毕立即擦除 `SecretStorage` 临时项（`wipedSecretIsEmpty = true`），复核 `data.json`（`970 B`）密钥残留为 **`0`**。

---

## 2. 发版前四项真机声学必过门禁（M3 → M4 正式发版强制阻断）

| # | 必过项 | 真机操作步骤 | 预期结果（全部满足才算 Pass） | 当前状态 | 实测环境与日期 |
| --- | --- | --- | --- | --- | --- |
| **A-1** | **字幕渲染与长内容换行** | 开启朗读字幕，切最大字号与窄宽度档位，朗读包含中文长句、英文术语与长 URL 的笔记，并切换浅色/深色主题 | 字幕清晰可读且自动换行不截断、不遮挡关键编辑按钮；浅/深主题文本对比度 `>= 4.5:1`；停止或切笔记后字幕 `< 100 ms` 消失无残留 | **`Pass`（Desktop Real）** | 2026-11-22 · Obsidian `1.15.1`（macOS `27.2.1`）：`large`+`narrow` 零横向溢出；浅色对比度 **`15.91:1`**、深色 **`12.19:1`**；主动停止隐藏耗时 **`1.3–10.5 ms < 100 ms`** |
| **A-2** | **Markdown / 表格降噪朗读与打断** | 打开含 Frontmatter、代码块与 5×5 管道表格的真实笔记启动朗读；朗读中途于外放（AEC 生效）或耳机下开口说话（或在 `manual` 档按键打断） | 零念出 YAML frontmatter、代码符号与 `| --- |` 表格分隔符；打断后朗读与字幕在 `< 600 ms`（`manual` `< 150 ms`）内彻底中止且队列清空 | **`Pass`（Desktop Real）** | 2026-11-22 · Obsidian `1.15.1`：Frontmatter、代码围栏、裸 URL 与 5×5 表格 `0` 噪声念出；`manual` 停止 **`6.1–10.5 ms < 150 ms`**；`detect` 外放人声打断 **`83–202 ms < 600 ms`** |
| **A-3** | **60 秒连续中英混说 + 纠错词表** | 断网（飞行模式）状态下，冷启动后连续口述 60 秒中英混合笔记（含 5–6 次自然换气及至少 3 个已配置纠错词表专有名词） | 无卡死、无 OOM 崩溃；最终上屏文本完整无丢头尾，已配置词表 100% 命中替换，单句定稿无明显阻塞 | **`Pass`（Desktop Real）** | 2026-11-22 · Obsidian `1.15.1`：外联调用 **`0`**，冷启动加载 `1,529 ms`，流式馈入 `53.1 s` 真实 6 段换气中英混说语料，词表 **`3/3`（100%）** 命中，零 OOM |
| **A-4** | **`bargeInMode=manual` 外放零自打断** | 将打断模式设为 `manual` 并使用设备外放：全程播放 2 分钟笔记朗读不说话；随后按住触发键口述一句笔记并松手 | 朗读全程 **0 次**回声误触发自打断；按键口述完整识别上屏；松手后无残余录音占用麦克风指示灯 | **`Pass`（Desktop Real）** | 2026-11-22 · Obsidian `1.15.1`：`bargeInMode=manual` 下 `vits-wasm` 扬声器连续外放 **`120,005 ms`（满 2 分钟）`0` 自打断**；随后 `push-to-talk` 即时卸载阻塞 Worker 并完成口述上屏归位 `idle` |

### 附加安全与隐私复核（每次发版必做）

- [x] 桌面、空库与 Android 35 APK 三端实检 `.obsidian/plugins/voice-mode/data.json` **零明文 API Key / Token**（绑定 LLM/ASR/TTS `SecretStorage` 引用及实网 `MiMo` 测后均为 `0` 命中）。
- [x] 检查 Developer Console、Modal 状态与 Notice 输出，触发含 `Bearer` 与 `api_key=` 的 401/500 错误响应，密钥与鉴权头完全脱敏为 `<redacted>`（明文泄漏 **`0` 命中**）。
- [x] Vault 根目录与 `.obsidian/` **零模型二进制文件**写入 Vault（`vaultModelBinaryCount = 0`）。

---

## 2.5 新功能真机验收（2026-11-26 增补；单测已覆盖逻辑，真机项待验证）

| # | 验收项 | 操作步骤 | 预期结果 | 当前状态 |
| --- | --- | --- | --- | --- |
| **N-1** | 首次使用下载向导（P0-4） | 新 Vault（无本地模型）→ 选 `vits-wasm` 引擎 → 触发朗读 | 自动弹导向导（一次性说明 + 立即下载进度 + 暂时用系统语音）；同一会话不重复弹 | 单测覆盖弹窗/进度/跳过；**真机待验** |
| **N-2** | 发音词典（P1-2） | 设置「发音词典（朗读）」加规则 `API → A P I` → 朗读含 `API` 的笔记 | 朗读念 `A P I`；原文不变；导出 WAV 同样生效 | 单测覆盖 settings 归一并断言面板；**真机待验** |
| **N-3** | 发音词典语言作用域（P1-2） | 规则限定语言 `en`（如 `API → A P I`）→ 中英混排朗读 | 仅英文句替换；中文句不替换（全局规则始终生效） | core 单测覆盖过滤；**真机待验** |
| **N-4** | 系统语音按句语言（P2-1） | 未显式选音色（系统语音）→ 朗读中英混排笔记 | 中文句用中文语音、英文句用英文语音（zh-CN/en-US/ja-JP/ko-KR）；显式 voice 时保持配置语言 | 单测覆盖语言映射；**真机待验（需系统多语音包）** |
| **N-5** | Kokoro 按句音色（P2-1） | 选中文 Kokoro 音色（`zf_xiaobei`）+ `autoLanguageVoice` 开 → 中英混排朗读（daemon 在线） | 英文句自动切 `af_maple`；关闭开关后保持中文音色 | 单测覆盖切换逻辑；**真机待验（需 daemon + 模型）** |
| **N-6** | 导出合成缓存（P1-4） | 同一笔记连续两次「导出朗读为 WAV」（WAV 引擎） | 第二次导出复用会话缓存、无重复合成；导出结果正确 | 单测覆盖缓存复用；**真机待验** |
| **N-7** | 评测基线 CI（P1-6） | 观察 CI 的 Bench smoke job | `check-bench` 通过 bench@1 schema 校验；四产品可跨仓运行 | **CI 已覆盖**（无需真机） |
| **N-8** | 表达标签不念出（E2 剥离） | 笔记写入含 `<slow>慢读</slow>`、`<whisper>` 等标签的句子 → 朗读 | **不念出标签名**（按普通文本朗读）；标签不导致朗读内容异常 | 已修复朗读入口剥离（2026-11-26）；**真机待验** |

## 3. 移动端（`Android 15 AVD Emulator` + `Xcode iOS 27.0 Simulator WKWebView harness`）降级验证表（M3/M4 已闭环）

> **诚实边界说明**：
> 1. **Android 端（`Android 15 AVD Emulator (Obsidian 1.15.1 APK, System WebView 124.0)`）**：已在 Apple HVF 原生 `arm64-v8a` Android 15（`SDK 35`，Build `AE3A.240806.043`）AVD 模拟器内安装官方 **`Obsidian-1.15.1.apk`（`md.obsidian`，`com.google.android.webview` `Chrome/124.0.6367.219`，`V8 12.4.254.16`）** 完成 `M-1`–`M-5` 全链路验证。实测确认了一项重要的 Android 系统 WebView 差异：Android System WebView 原生暴露 `webkitSpeechRecognition`（`typeof === "function"`）与 `HTMLAudioElement`，但**未暴露 `window.speechSynthesis`（`typeof === "undefined"`）**；调用 `system` 朗读会干净弹出可读提示引导启用 BYOK TTS 且零未捕获异常，开启 BYOK TTS（`openai-compat` / `mimo`）即可通过 `HTMLAudioElement` 正常连续朗读。
> 2. **iOS 端（`Xcode iOS 27.0 Simulator WKWebView harness`）**：因官方 iOS App Store IPA 含 FairPlay 加密无法装入 Simulator，已在 **Xcode `iOS 27.0` Simulator `WKWebView` harness（`iPhone 18 Pro` · `5388526A-B0DD-4C59-93C5-5735C70B6D59`，`MobileSafari` `AppleWebKit/605.1.15`）** 及本机 `JavaScriptCore` 完成 `68` 种原生系统语音（含 `婷婷 zh-CN`、`美嘉 zh-TW` 等 `2` 种中文与 `25` 种英文语音）、`PlaybackQueue`、`FocusTextInjector`、`CloudDictationSession` 与 `main.js` 移动生命周期实测；实体 iPhone 和 Android 手机的测试结果可在取得记录后另行补充。

| 编号 | 验证项 | iOS（`Xcode iOS 27.0 Simulator WKWebView harness`） | Android（`Android 15 AVD Emulator · Obsidian 1.15.1 APK`） | 预期行为 | 当前状态与实测记录（2026-11-22） |
| --- | --- | --- | --- | --- | --- |
| **M-1** | **插件加载与零 Node 依赖崩溃** | `Xcode iOS 27.0 Simulator WKWebView harness`（`AppleWebKit/605.1.15`）+ `JSC` 加载 `main.js` | Android 15 AVD 模拟器（`SDK 35` `arm64-v8a`）启动官方 `md.obsidian` `1.15.1` | 无 `require('fs')` / `require('child_process')` / `Buffer` 报错，设置页完整打开，桌面状态栏不挂载 | **`Pass`（`Android 15 AVD Emulator` + `Xcode iOS 27.0 Simulator WKWebView harness`）** · Android AVD 真 APK 内 `is-mobile`/`is-android` 为 `true`、`typeof window.require === "undefined"`、`statusBarEl === null`（DOM `.vm-status-bar` 数为 `0`）、`8` 项命令与 4 大设置分组完整渲染、控制台/运行时异常 **`0`**；iOS 27 `WKWebView` harness 同样 **`0` 报错** |
| **M-2** | **重型离线 WASM 模型强制屏蔽** | 核验 `capabilities` 与设置分组选项 | 预置桌面同步的 `sensevoice-wasm` + `vits-wasm` `data.json` 冷启动并检查设置页 | `Platform.isMobile` 下锁定 200 MB+ 本地 WASM 下载入口，桌面同步配置自动安全降级为 `system` | **`Pass`（`Android 15 AVD Emulator` + `Xcode iOS 27.0 Simulator WKWebView harness`）** · 双端 `allowLocalWasmModels === false`、`allowLocalDaemon === false`；Android APK 冷启动将同步的 `sensevoice-wasm`/`vits-wasm` 安全降级为 `system`，识别仅开放 `["system","openai-compat"]`、朗读仅开放 `["system","openai-compat","mimo"]`，渲染 `Disabled on mobile` 徽章与 Jetsam/WebView 内存说明，模型下载按钮数为 **`0`** |
| **M-3** | **BYOK 听写与语音问答闭环** | `Xcode iOS 27.0 Simulator WKWebView harness` 跑通 `CloudDictationSession`（`13,406 B` RIFF WAV）与 `FocusTextInjector` | Android AVD APK 经 `adb reverse` 验证隐私门控、`SecretStorage` 听写与 `VoiceQaModal` 流式问答插入 | 默认阻断远程云端；显式开启后凭证走 `SecretStorage` 不进 `data.json`，转写与问答准确写入光标处 | **`Pass`（`Android 15 AVD Emulator` + `Xcode iOS 27.0 Simulator WKWebView harness`）** · Android APK 在 `allowCloudFallbackOnMobile=false` 下准确阻断远程云端请求；置 `true` 并写入 `app.secretStorage` 后，真实开启 Android `getUserMedia` + `AudioWorklet` 上传 `24,798 B` RIFF WAV，经词表替换（`黑曜石 -> Obsidian`）写入 `Mobile-Test.md`，`VoiceQaModal` 流式接收 SSE 并一键插入光标处，`/sdcard/.../data.json`（`1,198 B`）明文密钥 **`0` 命中** |
| **M-4** | **朗读播控与 5 分钟跨笔记长稳压测** | `Xcode iOS 27.0 Simulator WKWebView harness` 实测 `68` 种原生语音枚举、`PlaybackQueue` 暂停/恢复/取消与无手势看门狗回收 | Android AVD APK 连续运行 **5 分钟以上**跨 5 篇笔记切换朗读 + 暂停/恢复循环并采样 V8 堆与 WebView PID | 播放/暂停/停止可控，切笔记自动停读，无 WebView 闪退、白屏重载或持续堆泄漏 | **`Pass`（`Android 15 AVD Emulator` + `Xcode iOS 27.0 Simulator WKWebView harness`）** · Android 15 AVD `Obsidian 1.15.1` 连续朗读 **`307,311 ms`（5 分 07 秒，合成播放 `118` 句 WAV）**、跨 5 篇笔记切换 **`25` 次** + 暂停/恢复 **`25` 次**，停止延迟 **`1 ms`**，`usedJSHeapSize` 全程平稳 **`24.80 MB -> 24.80 MB`（增量 `0.00 MB`）**，WebView PID `4512 -> 4512`（**`0` 崩溃/重载、`0` 异常**） |
| **M-5** | **麦克风权限拒绝优雅降级** | 触发 `NotAllowedError` 检查状态机归位 | 执行 `adb shell pm revoke md.obsidian android.permission.RECORD_AUDIO` 后在 Android AVD APK 点击听写 | 显示可读的系统权限指引 Notice，绝不卡在“录音中”状态 | **`Pass`（`Android 15 AVD Emulator`）** · Android OS 级撤销 `RECORD_AUDIO` 后，System WebView `getUserMedia` 真实抛出 `NotAllowedError`，触发 `toggleDictation()` 立即弹出可读权限指引 Notice（`"Microphone permission was denied..."`），`cloudSession.state === "idle"`、`listening === false`、异常数 **`0`** |

---

## 4. M5 与 M6 跨仓验收及本机语音服务联调（2026-11-22）

下表保留首次验收时的版本、复用率和耗时。后续共享包更新的核对方法见 [ADR-0005](../adr/0005-multi-repo-package-sharing-and-daemon-seam.md)。

| 波次 / 模块 | 仓库与基线 | 实测宿主与场景 | 量化指标与实测结果 | 状态 |
| --- | --- | --- | --- | --- |
| **Wave 2（`M5`）— SillyTavern 全双工语音扩展** | [`qishuilalala/sillytavern-voice-mode`](https://github.com/qishuilalala/sillytavern-voice-mode)（`0.1.0`，commit `b792551`，4/4 CI 全绿） | SillyTavern `1.19.1` UI 扩展 + 可选 SSRF 加固服务端插件 | 共享包复用率 **`75.05%`（`>= 75%` `@voice-mode/{core,browser}@0.1.0`）**；流式首句起播提前量 **`firstSentenceLeadMs = 341 ms`**；原生 AEC3 `detect` 外放语音打断 + `stopGeneration()` **`20/20`** 均值 **`205 ms < 600 ms`**；支持角色 `voiceMap` 抽屉与跨句 `<whisper>` 情感 DSL | **`Pass`** |
| **Wave 3（`M6`）— 本机共享守护进程与 MV3 扩展** | [`qishuilalala/voice-mode-daemon`](https://github.com/qishuilalala/voice-mode-daemon)（`0.1.0`，commit `29ca1f9`，4/4 三系统 CI 全绿） | `@voice-mode/daemon`（`127.0.0.1:18790`）+ `@voice-mode/browser-extension`（Chrome/Edge MV3） | `sk-vmd-` 192-bit `0o600` Bearer 鉴权 + 严格 `Host`/`Origin` 白名单；原生 `sherpa-onnx-node` 解锁 **`Kokoro 103`** 音色 + `Zipformer2` + `SenseVoice`；浏览器扩展零 `<all_urls>` 权限 | **`Pass`** |
| **Wave 3（`M6`）— Obsidian + Chrome MV3 + 单 `voice-daemon` 联调 E2E** | 本仓 `voice-mode@0.1.0` + `voice-mode-daemon@0.1.0` | 真实 `/Applications/Obsidian.app`（`1.15.1`）+ Chrome `159` MV3 扩展并发连接同一本机 `voice-daemon` | 单份模型常驻 **`modelInstanceCount = 1`**（共享 RSS **`622.7 MB`**）；真实 Obsidian `kokoro-daemon`（`zf_xiaobei`）完整合成并播放含 `<whisper>` + `<break 250ms>` 的 `24 kHz` WAV（**`0` 次** Electron V8 `External Buffer` 崩溃）；`daemon` ASR 转写耗时 **`631 ms`**；主动停止 `voice-daemon` 后 Obsidian 自动无感回退耗时 **`3 ms < 1,000 ms`** | **`Pass`** |
| **Wave 3（`M6`）— `dsh-voice-mode` 内核反哺收敛** | [`qishuilalala/dsh-voice-mode`](https://github.com/qishuilalala/dsh-voice-mode)（`M6` Core Unification） | 回迁接入 `@voice-mode/core@0.1.0` 替换 8 个重复核心模块 | 净删减重复代码 **`725` 行**；**`110/110`** 测试文件全绿，`check:lib-drift` 与 `check:doc-anchors` **`0` 漂移**通过 | **`Pass`** |
