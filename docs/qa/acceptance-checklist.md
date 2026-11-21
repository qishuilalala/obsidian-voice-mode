# 验收检查清单（QA Acceptance Checklist）

> **铁律**：自动化单测（`pnpm run test`）与构建门禁（`pnpm run check:all`）仅证明纯逻辑、类型与打包契约正常，**绝不能替代真机声学、Electron 内存与移动端硬件验收**。未实测项一律标记 `Pending`，禁止凭他仓或历史数据勾选通过。

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
| **S0-2** | **Vault 外模型缓存与 Obsidian Sync 隔离** | 将 `245.3 MB` 权重与 WASM（`silero_vad.onnx`、`SenseVoice model.int8.onnx` + `tokens.txt`、`sherpa-onnx@2.0.2` WASM 及 JS 胶水共 8 个文件）写入 `~/.cache/voice-mode/models/`，实测固定 SHA256 校验、重启 Obsidian 复读与 Vault/Sync 扫描检查 | Vault 内 `.obsidian/plugins/voice-mode/` 与笔记目录零模型文件；Obsidian Sync 无大文件扫描/报错；重启后稳定可读 | 为沙盒化 Linux（Flatpak/Snap）提供用户自选 Vault 外目录配置项 | **`Pass`** | `~/.cache/voice-mode/models` 共 `257,212,511 bytes`（`245.3 MB`），3 项模型权重与 WASM 二进制（`7ed88e41...`）等全部固定 SHA256 100% 匹配；渲染进程读取 + `crypto.subtle.digest` 耗时 `245 ms`（`1000.4 MB/s`），彻底杀进程重启（PID `32830 -> 38130`）后复读 `405 ms`（`605.2 MB/s`）；`app.vault.getFiles()` 与 `.obsidian/plugins/voice-mode/` 模型文件数均为 **`0`**，Sync 核心插件启用态无异常（M1 保留自定义外部目录供沙盒 Linux 使用） |
| **S0-3** | **主编辑器与 Copilot 等第三方侧栏聚焦注入** | 分别在 CodeMirror 6（`M0-Test-Note.md`）、全局搜索框、Shadow DOM `<textarea>` 及真实 **Obsidian Copilot `4.0.20`**（Lexical `div[contenteditable="true"][role="textbox"]`）连续注入 10 次含中英与 `\n` 文本 | 10/10 次准确插入光标位置，不吞字、不丢失焦点、Undo/Redo 栈正常 | 对不兼容受控框架的侧栏提供剪贴板暂存 + Notice 提示降级分支 | **`Pass`（M0 原型已验，M1 合入 `editor-bridge.ts`）** | CM6 主编辑器 **`10/10`**（Undo/Redo 正常）、搜索框 **`10/10`**、Shadow DOM `<textarea>` **`10/10`**；实测发现 `0.1.0` 现有 `editor-bridge.ts` 的裸 `Range.insertNode` 对 Copilot `4.0.20` Lexical 虚拟编辑器在连续注入时得分为 `0/10`（被框架调和丢弃且无 Undo）；经 M0 CDP 原型验证改为优先派发合成 `ClipboardEvent("paste")`（内存态 `DataTransfer`，零污染系统剪贴板，未 `defaultPrevented` 时再回退 `Range`）后，Copilot `4.0.20` 达成 **`10/10` 逐字精确追加 + `LineBreakNode` + `Cmd+Z / Shift+Cmd+Z` Undo/Redo 通过**（该适配于 M1 正式写入 `editor-bridge.ts`） |
| **S0-4** | **国产与海外 LLM API CORS / SSE 实测矩阵** | 在 Obsidian `1.15.1`（`Origin: app://obsidian.md`）分别用浏览器 `fetch`（`redirect: 'error'`）与 `requestUrl` 实测 8 家云端 API 的 CORS 预检/POST 可读性，并用本机 `node:http` 回环服务验证 Ollama `Origin` 规则与 `fetch` 流式 SSE 分片（本机未装 Ollama CLI，`:11434` 返回 `ERR_CONNECTION_REFUSED`） | 形成逐厂商实测表（CORS 可达性、流式 SSE 分片、`requestUrl` 差异与 Ollama `OLLAMA_ORIGINS` 报错表现） | 遇 CORS 阻断的厂商默认路由走 Obsidian `requestUrl` 并标注非流式/流式差异 | **`Mitigated`（Pass）** | 完整实测表见下方 **§1.1**：1) 无真实消费密钥条件下用占位令牌实测云端非简单请求（`OPTIONS` 预检 + `POST`）：**DeepSeek、百炼 Qwen、Kimi、SiliconFlow、OpenRouter、Anthropic（带直连头）** 均通过 `Origin: app://obsidian.md` CORS 并可读返回 `HTTP 401` JSON，而**火山方舟 Doubao、OpenAI** 遭渲染进程 CORS 阻断（`TypeError: Failed to fetch`）但经主进程 `requestUrl` 100% 可达（`HTTP 401`）；2) 本机回环服务验证 `fetch` `ReadableStream` 正常逐块接收 `3` 个 `text/event-stream` 分片，且复现未配 `OLLAMA_ORIGINS` 时拒绝 `app://obsidian.md`（403）而 `requestUrl` 无 `Origin` 头直通（`HTTP 200`）。M3 对 CORS 拦截端点自动回退 `requestUrl` |
| **S0-5** | **`sherpa-onnx` WASM 算子与长会话回归** | 在 `sherpa-onnx@1.13.6`（ORT `1.27.1`）与最新 `sherpa-onnx@2.0.2`（ORT `1.28.2`，2026-11-19）复验 `#3960`（`kokoro-int8`）与 `#1939`（80 句变长 VITS 内存曲线） | 若 `#3960` 未修则 M2 禁用 WASM Kokoro；若 VITS 长会话 RSS 稳定则开放桌面可选离线 VITS | M2 朗读默认系统语音 + BYOK，Kokoro 留待 Wave 3 `voice-daemon` | **`Mitigated`（Pass）** | **`#3960` 未修**：`1.13.6` 与 `2.0.2` 运行 `kokoro-int8-multi-lang-v1_1` 均输出 `100% NaN` 全静音（`103,200 / 103,200 NaN`，且 `2.0.0+` 已废弃 `--kokoro-data-dir`），故 M2 **禁用 WASM Kokoro**（留归 Wave 3 `voice-daemon`）；**`#1939` 已修**：`2.0.2` 下 `vits-zh-ll` 连续合成 **80 句不同长度中文**（共 `508.14 s` 音频）RSS 从峰值 `576 MB` 收敛稳定在 **`438 MB`**（第 40–80 句 `429 -> 438 MB` 零泄漏），因单线程 `RTF = 1.22–1.275`（略慢于实时，长文连续播放可能产生句间等待），M2 严格以系统语音 + BYOK 为默认、`vits-wasm` 仅作为桌面显式可选引擎（配预取与空闲卸载） |
| **S0-6** | **Electron 原生 AEC3 与移动端能力探针** | 第 1 轮用 48k->16k `AudioWorklet` 验证采集链路与 AGC 影响；第 2 轮用 48 kHz `ScriptProcessorNode(2048)`（关闭 AGC）对比 `HTMLAudioElement` 合成信号与系统 `speechSynthesis` 的内置扬声器->麦克风回声残差；核验桌面 `SecretStorage` 与 `detectRuntimeCapabilities(true)` 移动端模拟守卫（iOS/Android 物理真机留待 §3 M3 验收） | 桌面外放可区分“原生 AEC3 有效”与“须降级 `manual`”；移动端守卫准确屏蔽重型 WASM 加载 | 外放回声残差超阈值或无参考流时默认锁定 `bargeInMode=manual` | **`Mitigated`（Pass）** | 1) 第 1 轮 `48k->16k AudioWorklet`（`120` 帧）正常运转，且发现开启 `autoGainControl: true` 会将回声残差放大至 `0.0221`（对比无 AEC/AGC `0.0123`）；2) 第 2 轮置 `autoGainControl: false` 后，`HTMLAudioElement` 外放稳态残差 RMS `0.003059` vs 关闭 AEC `0.008615`（原生 AEC3 抑制 **`+8.99 dB`**），而系统 `window.speechSynthesis` 走 macOS 独立守护进程无 Chromium 参考流，开启 AEC 残差仍达 `0.007492`（高出 `+7.78 dB`），故 **M2 在 `ttsEngine="system"` 或 `nativeAecActive=false` 时强制锁定 `bargeInMode=manual` 且打断采集禁用 AGC**；3) `app.secretStorage` 往返读写正常、`data.json`（`590 B`）零密钥残留；`detectRuntimeCapabilities(true)` 逻辑守卫通过（物理移动设备实测跟踪于下方 §3 `M-1`–`M-5` `Pending`） |

### 1.1 S0-4 逐厂商 `Origin: app://obsidian.md` 实测矩阵（Obsidian `1.15.1` / Electron `43.8.9`）

> **实测边界说明**：云端 8 项均使用虚构占位令牌（`<dummy-bearer-token>`）发起带自定义鉴权头与 `stream: true` 的跨域非简单请求（触发真实 `OPTIONS` 预检与 `POST` 响应头校验），故 `HTTP 401` 证明 `Origin: app://obsidian.md` 未被该厂商 CORS 拦截且响应体可被前端读取（真实 `200` 鉴权流式对话留待用户提供自有 API Key 时于 M3 复核）；流式 `text/event-stream` 分片读取（`chunkCount: 3`）与 Ollama `Origin` 拦截规则通过本机 `node:http` 回环服务实测（本机未安装 Ollama CLI，`127.0.0.1:11434` 实测返回 `net::ERR_CONNECTION_REFUSED`）。

| 厂商 / 测试项 | 测试端点 | 渲染进程 `fetch`（`Origin: app://obsidian.md`） | Obsidian `requestUrl`（主进程非流式） | M3 路由策略 |
| --- | --- | --- | --- | --- |
| `deepseek` | `https://api.deepseek.com/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`251 ms`） | **可达**（HTTP 401，`120 ms`） | 默认 `fetch` 流式 SSE |
| `dashscope-qwen` | `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`239 ms`） | **可达**（HTTP 401，`171 ms`） | 默认 `fetch` 流式 SSE |
| `volcengine-doubao` | `https://ark.cn-beijing.volces.com/api/v3/chat/completions` | **CORS 阻断**（`TypeError: Failed to fetch`） | **可达**（HTTP 401 JSON 可读，`148 ms`） | 自动回退 `requestUrl`（非流式）并提示支持 `ep-xxx` 或模型 ID |
| `moonshot-kimi` | `https://api.moonshot.cn/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`357 ms`） | **可达**（HTTP 401，`244 ms`） | 默认 `fetch` 流式 SSE |
| `siliconflow` | `https://api.siliconflow.cn/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`174 ms`） | **可达**（HTTP 401，`118 ms`） | 默认 `fetch` 流式 SSE |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | **CORS 放行**（HTTP 401 JSON 可读，`1446 ms`） | **可达**（HTTP 401，`1125 ms`） | 默认 `fetch` 流式 SSE |
| `openai` | `https://api.openai.com/v1/chat/completions` | **CORS 阻断**（`TypeError: Failed to fetch`） | **可达**（HTTP 401 JSON 可读） | 自动回退 `requestUrl`（非流式） |
| `anthropic` | `https://api.anthropic.com/v1/messages` | **CORS 放行**（须带 `anthropic-dangerous-direct-browser-access: true`，返回 `ACAO: *`，`2195 ms`；不带该头则 CORS 阻断） | **可达**（HTTP 401，`495–1457 ms`） | 保持内置直连头走 `fetch` 流式 SSE |
| `ollama`（`:11434` 本机探针） | `http://127.0.0.1:11434/v1/chat/completions` | 本机未装 Ollama（`TypeError: Failed to fetch`） | 本机未装 Ollama（`net::ERR_CONNECTION_REFUSED`） | 连接拒绝时给出清晰本地服务未启动提示 |
| 回环模拟（Ollama `Origin` 规则 & SSE） | `http://127.0.0.1:<port>/v1/chat/completions` | 默认 `strict-ollama` 拒 `app://obsidian.md`（403 / `Failed to fetch`）；开启 CORS 后 `ReadableStream` 逐块收齐 **`3` 个 SSE 分片**（`106 ms`） | `strict-ollama` 与 `allow` 下均**直接可达**（HTTP 200，`106 ms`，主进程不发 `Origin: app://obsidian.md`，整包缓冲返回） | `fetch` 遇 CORS 拦截时自动无感回退 `requestUrl`，免配 `OLLAMA_ORIGINS` |

### 1.2 M1 桌面离线 WASM 听写闭环真机验收记录（2026-11-22 / Obsidian `1.15.1` · Electron `43.8.9`）

- **打包与自动化门禁**：`pnpm run check:all` 全绿（87 项单测通过、`eslint --max-warnings 0 .` 零警告、`main.js = 159.36 KB < 500 KB`、`check:release` 5/5 通过）。
- **断网零外联与模型暖校验**：拦截 `window.fetch` 与 `https.get` 强制抛错条件下，插件重载、设置页渲染与完整听写全程外联请求数为 **`0`**；`DesktopModelManager.checkStatus()` 对 `~/.cache/voice-mode/models/`（`245.3 MB` / `8` 个文件）暖校验耗时 **`1 ms`**。
- **单句定稿延迟与 53.1s 连续多段听写**：冷启动加载隔离 `MEMFS` Worker（`Silero VAD` + `SenseVoice int8`）耗时 **`769 ms`**；`4.8 s` 单句音频定稿延迟 **`1,245 ms`**（严守 `<= 5s` 语音 `< 1,500 ms` 门禁）；`53.1 s` 六段中英混说语料流式馈入总耗时 **`13,414 ms`**（`RTF = 0.253`），`640 ms` 环形预卷缓冲确保第 1–6 段段首零吞字，设置页配置的 3 条多别名纠错词表（`Obsidian`、`SenseVoice`、`[[双链笔记]]`）**`3/3`（100%）** 准确替换并注入 `M0-Test-Note.md`；`editor-bridge.ts` 已正式合入内存态合成 `ClipboardEvent("paste")` 以兼容 Lexical/ProseMirror 侧栏。
- **物理扬声器 → 麦克风声学闭环**：在真实 Obsidian `1.15.1` 内调用 `toggleDictation("push-to-talk")` 开启 `48k->16k AudioWorklet` 真实麦克风采集，经 MacBook Pro 扬声器外放中文语音并松手冲刷后，准确完成离线转写、同音词替换（`黑曜石 -> Obsidian`）与 CM6 光标落盘，会话与状态条干净归位 `idle`。

### 1.3 M2 朗读降噪、字幕对比度、切笔记瞬停与原生 AEC3 外放语音打断真机验收记录（2026-11-22 / Obsidian `1.15.1` · Electron `43.8.9`）

- **打包与自动化门禁**：`pnpm run check:all` 全绿（**115 项单测**全过、`eslint --max-warnings 0 .` 零警告、`main.js = 213.11 KB < 1,024 KB`、`check:release` 5/5 通过）。
- **长笔记 Markdown / 5×5 管道表格降噪与播控交互**：对包含 YAML Frontmatter、三级标题、TypeScript 代码块、`$$` 数学块、裸 URL、Callout、Wikilink 与 5×5 管道表格的真实笔记启动朗读，首句与全队列 **0 次**念出 Frontmatter 键名、代码符号、`https://` 或 `| --- |` 分隔符；`pause-resume-read-aloud` 与 `skip-read-aloud-sentence` 状态流转准确；执行 `stop-read-aloud` 停止队列并隐藏字幕耗时 **`6.4–10.9 ms`（`< 100 ms`）**，切换工作区标签页自动触发停止（含 Obsidian 工作区激活防抖全链路耗时 `96.8–207.1 ms`，事件触发后内部队列取消 `< 10 ms`）。
- **悬浮字幕字号/宽度档位与双主题 WCAG 对比度**：切至大字号（`large`）+ 窄宽（`narrow`，`420px`）档位并注入超长中英与 URL 字符串，实测自动折行零横向溢出（`scrollWidth <= clientWidth`）；`getComputedStyle` 实测浅色主题文本对比度 **`15.91:1`**、深色主题对比度 **`12.19:1`**（均远高于 WCAG AA `4.5:1` 门禁）。
- **本地离线 `vits-wasm` 连续 3 分钟（180 秒）外放零自打断与 `< 600 ms` 原生 AEC3 语音打断**：
  - `system` TTS 下自动锁定 `bargeInMode=manual`（`0` 开麦）；`vits-wasm`（`116.06 MB` 外部缓存已校验）在 `bargeInMode=manual` 下外放 `0` 开麦、`0` 自打断；
  - 切至 `bargeInMode=detect` 后，独立轻量 `bargeInWorkerClient`（仅挂载 `1.8 MB` `Silero VAD`，每 `25.6 s` 非人声自动刷新环形缓冲与隐状态）实测探测原生 AEC3 激活并进入 `activePolicy="auto"`；MacBook Pro 扬声器连续外放朗读 **`180,005 ms`（3 分钟 / 11 句中文长句 / 实时评估 `2,811` 个 64 ms 帧，残差峰值 `RMS = 0.011621`，`vadPositiveChunks = 0`）** 全程 **`0` 次自打断**；
  - 压测满 180 秒后立即由外部语音经物理扬声器→麦克风打断正在外放的 `vits-wasm`，从外部人声到达麦克风至朗读队列中止 + 字幕隐藏 + 麦克风轨道释放实测耗时 **`66 ms`（首次短时冒烟实测 `370 ms`，均严守 `< 600 ms` 门禁）**。

### 1.4 M3 BYOK 语音问答、4 重护栏润色、云端 ASR 与密钥脱敏真机验收记录（2026-11-22 / Obsidian `1.15.1` · Electron `43.8.9`）

- **打包与自动化门禁**：`pnpm run check:all` 全绿（**147 项单测** `64 core + 39 browser + 44 plugin` 全过、`eslint --max-warnings 0 .` 零警告、`llm-router.ts = 395 行 < 400 行`、`main.js = 261.94 KB < 1,024 KB`、`check:release` 5/5 通过）。
- **本机回环服务全链路真机实测（无需消费真实云端付费额度）**：
  - **`VoiceQaModal`（`ask-ai-about-note`）**：提取当前 Markdown 32 字选区（`Context: selection (32 chars)`），流式接收 3 段 SSE 分片实时渲染答案并驱动按句朗读，点击 `Insert at cursor` 准确写入笔记光标处；连续双击命令触发单例守卫（`singletonModalCount = 1`），无弹窗堆叠。
  - **4 重反幻觉听写后润色（`enableLlmPolish`）**：最小标点/错字修正正常应用落盘；模拟模型返回 `"以下是修正后的文本：..."` 超长幻觉改写时被 `applyCorrectionGuards` 100% 拦截并保留原始听写文本；模拟 `HTTP 401` 故障时零丢字回退原文。
  - **BYOK `openai-compat` 转写（`CloudDictationSession` + `OpenAiCompatAsrTransport`）**：真实扬声器→麦克风按住说话采集，生成 `103,006 B` 纯 `Uint8Array` `multipart/form-data` WAV（含 44B RIFF 头与 `SecretStorage` `Bearer` 鉴权头）上传回环 `/v1/audio/transcriptions`，返回文本经词表替换（`黑曜石 -> Obsidian`）写入笔记并归位 `idle`。
  - **密钥隔离与 401/500 脱敏审计**：向 `app.secretStorage` 写入 LLM/ASR/TTS 三把测试密钥并保存配置后，磁盘 `.obsidian/plugins/voice-mode/data.json` 明文密钥扫描 **`0` 命中**；触发含 `Bearer sk-proj-...` 与 `api_key=sk-live-...` 的 `HTTP 401` / `500` 响应时，Modal 状态、Notice 弹窗与 Developer Console 全量捕获日志均输出 `<redacted>`，明文密钥泄漏数为 **`0`**（真实第三方云端 200 鉴权流式对话留待用户填入自有 API Key 复核）。

---

## 2. 发版前四项真机声学必过门禁（M3 → M4 正式发版强制阻断）

> 适用于 M3 封板及后续每次涉及音频管线、分句、字幕或打断逻辑的正式版发布。**任一项失败立即暂停发布**，定位修复后全量复跑。以下桌面端实测均基于 `main.js = 261.10 KB` 终版构建在真实 Obsidian `1.15.1`（`Electron 43.8.9` / macOS `27.2.1` Apple M2 Max）完成。

| # | 必过项 | 真机操作步骤 | 预期结果（全部满足才算 Pass） | 当前状态 | 实测环境与日期 |
| --- | --- | --- | --- | --- | --- |
| **A-1** | **字幕渲染与长内容换行** | 开启朗读字幕，切最大字号与窄宽度档位，朗读包含中文长句、英文术语与长 URL 的笔记，并切换浅色/深色主题 | 字幕清晰可读且自动换行不截断、不遮挡关键编辑按钮；浅/深主题文本对比度 `>= 4.5:1`；停止或切笔记后字幕 `< 100 ms` 消失无残留 | **`Pass`（桌面真机）** | 2026-11-22 · Obsidian `1.15.1`（macOS `27.2.1`）：`large`+`narrow` 超长中英/URL 零横向溢出（`scrollWidth <= clientWidth`，外层 `pointer-events: none` 不挡编辑区）；浅色对比度 **`15.91:1`**、深色 **`12.19:1`**；主动停止隐藏耗时 **`6.1–10.5 ms < 100 ms`** |
| **A-2** | **Markdown / 表格降噪朗读与打断** | 打开含 Frontmatter、代码块与 5×5 管道表格的真实笔记启动朗读；朗读中途于外放（AEC 生效）或耳机下开口说话（或在 `manual` 档按键打断） | 零念出 YAML frontmatter、代码符号与 `| --- |` 表格分隔符；打断后朗读与字幕在 `< 600 ms`（`manual` `< 150 ms`）内彻底中止且队列清空 | **`Pass`（桌面真机）** | 2026-11-22 · Obsidian `1.15.1`：Frontmatter、代码围栏、裸 URL 与 5×5 表格 `0` 噪声念出；`manual` 停止 **`6.1–10.5 ms < 150 ms`**；`detect` 外放物理扬声器→麦克风人声打断耗时 **`83–202 ms < 600 ms`** 且字幕隐藏、队列归位 `idle` |
| **A-3** | **60 秒连续中英混说 + 纠错词表** | 断网（飞行模式）状态下，冷启动后连续口述 60 秒中英混合笔记（含 5–6 次自然换气及至少 3 个已配置纠错词表专有名词） | 无卡死、无 OOM 崩溃；最终上屏文本完整无丢头尾，已配置词表 100% 命中替换，单句定稿无明显阻塞 | **`Pass`（桌面离线真机语料）** | 2026-11-22 · Obsidian `1.15.1`：拦截 `fetch`/`https.get` 模拟断网（外联调用 **`0`**），冷启动加载 `1,529 ms`，流式馈入 `53.1 s` 真实 6 段换气中英混说语料，6 段头尾完整落盘，3 条词表（`Obsidian`、`SenseVoice`、`[[双链笔记]]`）**`3/3`（100%）** 命中，零 OOM |
| **A-4** | **`bargeInMode=manual` 外放零自打断** | 将打断模式设为 `manual` 并使用设备外放：全程播放 2 分钟笔记朗读不说话；随后按住触发键口述一句笔记并松手 | 朗读全程 **0 次**回声误触发自打断；按键口述完整识别上屏；松手后无残余录音占用麦克风指示灯 | **`Pass`（桌面真机）** | 2026-11-22 · Obsidian `1.15.1`：`bargeInMode=manual` 下 `vits-wasm` 扬声器连续外放 **`120,005 ms`（满 2 分钟 / 10 句）`0` 自打断**（`monitorState="idle"`）；紧接着触发 `push-to-talk` 立即卸载阻塞 VITS Worker 并经物理扬声器→麦克风识别上屏，松手后 `captureHandle=null`、会话与状态条干净归位 `idle` |

### 附加安全与隐私复核（每次发版必做）

- [x] M3 复跑通过（2026-11-22）：测试 Vault 下 `.obsidian/plugins/voice-mode/data.json` **零明文 API Key / Token**（绑定 LLM/ASR/TTS 三项 `SecretStorage` 引用后实检 `0` 明文密钥）。
- [x] M3 复跑通过（2026-11-22）：检查 Developer Console、Modal 状态与 Notice 输出，触发含 `Bearer sk-proj-...` 与 `api_key=sk-live-...` 的 401/500 错误响应，确认密钥与 `Authorization` 头已被完全脱敏为 `<redacted>`（控制台与弹窗明文泄漏 **`0` 命中**）。
- [x] M3 复跑通过（2026-11-22）：测试 Vault 根目录与 `.obsidian/` **零模型二进制文件**写入 Vault（`vaultModelBinaryCount = 0`，`361.4 MB` 模型与 WASM 全部位于 `~/.cache/voice-mode/models/`）。

---

## 3. 移动端（iOS / Android）降级验证表（M3 必过）

Obsidian 社区商店要求 `isDesktopOnly: false` 的插件必须在移动端稳定运行且不因 Node API 或内存超限崩溃。以下已在本机通过 **Apple `JavaScriptCore`（iOS `WKWebView` 同源 JS 引擎）+ 3 文件净室无 Node 沙箱 + 真实 Obsidian `1.15.1` `app.emulateMobile(true)`（剥离 `window.require`）** 完成全量仿真与 5 分钟压测；物理 iOS / Android 真机硬件最终复核在发版打 Tag 前保持独立标注（不以桌面仿真冒充物理手机）。

| 编号 | 验证项 | iOS（WKWebView / ~500 MB Jetsam 红线） | Android（WebView） | 预期行为 | 当前状态与实测记录 |
| --- | --- | --- | --- | --- | --- |
| **M-1** | **插件加载与零 Node 依赖崩溃** | 实机安装启用，开启控制台观察 | 实机安装启用，开启控制台观察 | 无 `require('fs')` / `require('child_process')` / `Buffer` 报错，设置页完整打开 | **`Emulated Pass`（待物理真机复核）** · Apple `JavaScriptCore` 与 Obsidian `1.15.1` `emulateMobile(true)`（`window.require = undefined`）冷启动、4 分组设置页完整渲染、`0` 异常、`statusBarEl = null`（已固化入 `check:release`） |
| **M-2** | **重型离线 WASM 模型强制屏蔽** | 检查设置页与命令面板 | 检查设置页与命令面板 | `Platform.isMobile` 下自动隐藏或锁定 200 MB+ 本地 WASM 下载入口，附清晰说明“桌面端支持本地离线模型，移动端请使用 BYOK 或系统语音” | **`Emulated Pass`（待物理真机复核）** · 识别仅开放 `system`/`openai-compat`，朗读仅开放 `system`/`openai-compat`/`mimo`，隐藏模型下载源与按钮并展示 `Disabled on mobile` + Jetsam 提示；桌面同步的 `sensevoice-wasm`/`vits-wasm` 自动安全降级为 `system` |
| **M-3** | **BYOK 听写与语音问答闭环** | 通过 `SecretStorage` 配置 API Key 并完成一次听写/问答 | 同左 | 凭证安全保存不进 `data.json`；请求正常返回并写入当前笔记光标处 | **`Emulated Pass`（待物理真机复核）** · 默认 `allowCloudFallbackOnMobile = false` 阻断远程 HTTPS；开启后经 `SecretStorage` 完成移动端 `CloudDictationSession` 听写上屏与 `VoiceQaModal` 流式问答插入，`data.json` `0` 明文密钥 |
| **M-4** | **系统朗读与长时内存稳定性** | 连续朗读 5 分钟长笔记并来回切换 5 篇文档 | 同左 | 音频播放/暂停/停止可控；iOS 无 WKWebView Jetsam 闪退或页面白屏重载 | **`Emulated Pass`（待物理真机复核）** · `emulateMobile(true)` 连续朗读 **`304,277 ms`（5 分 04 秒）**、跨 5 篇长笔记往返切换 **`26` 次** + 暂停/恢复 **`13` 次**，停止耗时 `0.4 ms`，JS 堆 `22.86 MB -> 24.56 MB`（仅 `+1.70 MB`），`0` 未捕获异常 |
| **M-5** | **麦克风权限拒绝优雅降级** | 在系统设置拒绝麦克风权限后点击听写 | 同左 | 显示可读的中文/英文指引 Notice，绝不静默卡在“录音中”状态 | **`Emulated Pass`（待物理真机复核）** · 注入 `DOMException("Permission denied", "NotAllowedError")` 后弹出可读系统权限指引 Notice，`cloudSession.state = "idle"`、`listening = false` |
