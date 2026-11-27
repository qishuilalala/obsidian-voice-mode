# 首次验收矩阵：首次授权、听写回填、朗读、拒绝后恢复（First-Run Acceptance Matrix）

> 基线 `077b936`。本文把首发主线的四条用户路径拆成「桌面可执行（自动化）」与「真机待验（iOS / Android）」两类，逐条给出复跑命令或手动步骤。
> 自动化只证明逻辑、状态机与注入时序；操作系统麦克风授权对话框、系统语音音色、移动 WebView 差异仍以真机记录为准。平台承诺边界见 [README](../../README.md)「平台支持与移动端降级策略」与本目录 [验收检查清单](acceptance-checklist.md) §3。

## 1. 四条路径的真实入口与现有覆盖

| 用户路径 | 真实入口（基线 `077b936`） | 设备边界 | 自动化覆盖 |
| --- | --- | --- | --- |
| 首次麦克风授权 | 命令注册 `packages/obsidian-plugin/src/main.ts:327`（`toggle-dictation`）、`:335`（`dictate-single-utterance`）→ `toggleDictation()` `main.ts:1769`；桌面离线 `startOfflineSenseVoiceDictation()` `main.ts:2056`；BYOK 云端 `startCloudOpenAiDictation()` `main.ts:1980`；本机 daemon `startDaemonDictation()` `main.ts:1885`；宿主 `SpeechRecognition` 兜底 `startBrowserSpeechRecognitionFallback()` `main.ts:2141` | `navigator.mediaDevices.getUserMedia()` `packages/voice-browser/src/dictation-session.ts:96`（由 `createBrowserMicCapture()` `:76` 调用，`:349` 进入）；云端同源 `cloud-dictation-session.ts:207` | 新增 `packages/obsidian-plugin/test/m3-plugin-qa-polish-asr.test.mjs:1653`（真实 `createBrowserMicCapture` + `NotAllowedError`，`getUserMedia` 用桩） |
| 听写回填（光标 / 选区、失败、取消） | 离线转写回调 `main.ts:1248`；云端/daemon 转写回调 `main.ts:1372`；宿主识别 `main.ts:2194` → `processAndCommitDictation()` `main.ts:2283` → `commitDictatedTextSilently()` `main.ts:2468` / `commitDictatedText()` `main.ts:2495` → `insertDictatedText()` `packages/obsidian-plugin/src/editor-bridge.ts:52`（`editor.replaceSelection`，即替换选区/写入光标）；第三方输入框经 `insertIntoFocusedInput()` `packages/voice-browser/src/focus-injector.ts:244`；取消 `abortActiveDictationSilently()` `main.ts:2441`、`stopBrowserRecognition()` `main.ts:2257`、会话 `abort()` `dictation-session.ts:458` / `cloud-dictation-session.ts:330` | 编辑器 API（`Editor.replaceSelection`）、焦点元素 | 既有 `test/daemon-integration.test.mjs:740` 覆盖「采集→断句→转写→CM6 写入」全链路；新增 `m3-plugin-qa-polish-asr.test.mjs:1794` 覆盖「空转写不插入」与「无编辑器可写时明确提示」；`test/obsidian-adapter.test.mjs:240` 覆盖选区/侧栏/Shadow DOM 焦点路由 |
| 朗读（选区 / 整篇、暂停、停止、切笔记、书签） | 命令注册 `main.ts:343`（`read-aloud`）、`:351`（`pause-resume-read-aloud`）、`:359`（`skip-read-aloud-sentence`）、`:367`（`stop-read-aloud`）、`:383`（`resume-read-aloud`）→ `readSelectionOrNoteAloud()` `main.ts:2639`（选区优先，`editor-bridge.ts:74`）→ `extractReadableText()` `editor-bridge.ts:71` → `SpeechPlayer.speakSentences()` `packages/obsidian-plugin/src/speech-player.ts:671`；暂停/继续 `speech-player.ts:705/709/713` 与 `playback-queue.ts:166/181`；跳句 `main.ts:2735` / `playback-queue.ts:204`；停止 `main.ts:2762` / `playback-queue.ts:239`；切笔记自动停读 `main.ts:303`；书签写入 `main.ts:532`、续读 `main.ts:2598`、播报进度 `main.ts:261-269` | 系统语音 `window.speechSynthesis`、AEC3 麦克风（仅外放打断） | 既有 `test/m2-plugin-tts.test.mjs:992`（进度 `(i/N)`）、`test/daemon-integration.test.mjs:340`（续读/选区不覆盖书签/切笔记/读完清书签）、`:497`（停止/切笔记设置在 VITS 就绪检查期间生效）；新增 `test/daemon-integration.test.mjs:426` 覆盖「暂停/继续命令、停止、暂停中停止、未播放时命令提示」 |
| 拒绝授权后恢复 | `isMicrophonePermissionError()` `main.ts:157`（`NotAllowedError` / `PermissionDeniedError` / 文案兜底）；离线授权失败提示与状态归位 `main.ts:1253-1263` + `handleOfflineStateChange()` `main.ts:1276`；云端/daemon 同类处理 `main.ts:1377-1390` + `handleTransportSessionStateChange()` `main.ts:1395`；恢复入口仍是同一条命令 `main.ts:1769`（会话回到 `idle` 后重新 `start()`：`dictation-session.ts:312` / `cloud-dictation-session.ts:188`） | 同上（授权结果由宿主/OS 返回） | 新增 `m3-plugin-qa-polish-asr.test.mjs:1653`：拒绝→可操作 Notice、状态 `Voice error`、不残留录音、不插入文本；授权后同命令重试→`Listening`→断句→文本上屏→`Voice idle` |

## 2. 桌面可执行（自动化）

复跑单条用例：

```bash
cd packages/obsidian-plugin
node --test test/m3-plugin-qa-polish-asr.test.mjs
node --test test/daemon-integration.test.mjs
```

| 编号 | 验收项 | 用户可见预期 | 自动化位置 | 状态 |
| --- | --- | --- | --- | --- |
| **D-1** | 授权允许后的首次听写（桌面离线 WASM 引擎） | 允许系统麦克风授权后，同一条命令进入 `Listening`，提示离线听写开始（单句） | `m3-plugin-qa-polish-asr.test.mjs:1653` 第 2 段（系统授权弹窗本身属真机边界，自动化以 `getUserMedia` 桩 + 重试允许分支覆盖） | **Pass**（自动化，设备边界为桩） |
| **D-2** | 听写回填光标（含纠错词表） | 断句定稿后文本写入当前编辑器光标处，纠错词表已生效，单句结束释放麦克风 | 同上（断言 `replaceSelection` 收到替换后文本、`transcribe` 只调用一次且携带 640 ms 预卷、`mic stop` 一次） | **Pass**（自动化） |
| **D-3** | 空转写不落字 | 未检测到语音时静默结束，不插入、不弹错误 | `m3-plugin-qa-polish-asr.test.mjs:1794` | **Pass**（自动化） |
| **D-4** | 无编辑器可写时明确提示 | 焦点不在编辑器/输入框且无 Markdown 视图时，提示「No active editor or text input found for dictated text.」 | 同上 | **Pass**（自动化） |
| **D-5** | 拒绝授权 → 可操作提示 + 状态归位 | 拒绝后提示前往系统隐私设置授权 Obsidian 麦克风并重试；状态栏 `Voice error`，不卡在 `Listening`，无残留录音，不插入文本 | `m3-plugin-qa-polish-asr.test.mjs:1653` 第 1 段 | **Pass**（自动化） |
| **D-6** | 拒绝后恢复：授权后重试成功 | 同一命令重试不再弹第二次授权，直接进入 `Listening`，说完一句后上屏，状态回 `Voice idle` | `m3-plugin-qa-polish-asr.test.mjs:1653` 第 2 段 | **Pass**（自动化） |
| **D-7** | 朗读暂停/继续/停止（命令面板） | 朗读中「暂停或继续朗读」→ 状态栏 `Read-aloud paused`；再按恢复 → `Reading aloud`；暂停中停止 → 归位 `Voice idle` 并保存续读位置；未在朗读时按暂停/停止 → 明确提示而非静默 | `daemon-integration.test.mjs:426` | **Pass**（自动化） |
| **D-8** | 朗读选区/整篇、切笔记、书签 | 有选区只读选区、无选区读整篇；切笔记自动停读；「从上次位置继续朗读」续读，选区和问答不覆盖书签，读完清书签 | 既有 `daemon-integration.test.mjs:340`、`m2-plugin-tts.test.mjs:992` | **Pass**（既有自动化） |
| **D-9** | 既有套件不回归 | 三包测试数不减少、门禁阈值不下调 | `pnpm run check:all`（见 §5） | **Pass**（2026-11-27 复跑） |

未纳入自动化的桌面边界：操作系统/系统设置的授权对话框本身、真实麦克风与扬声器声学、系统语音音色可用性，见 §4。

## 3. 真机待验（iOS / Android）

> 下列各项均为 **Pending（真机待验）**。历史验证仅限 Android 15 AVD 模拟器（Obsidian `1.15.1` APK）与 Xcode iOS 27 Simulator 的 `WKWebView` 测试基座，**不代表实体手机**；在实体机记录补齐前，不宣称移动端听写/朗读已支持。

### 3.1 iOS 实体设备

前置：iPhone/iPad 安装 Obsidian `1.11.4+`，启用 `voice-mode` 插件（侧载或手动放入插件目录）；准备含中英混排的测试笔记。

| 编号 | 步骤 | 预期结果 | 状态 |
| --- | --- | --- | --- |
| **iOS-1** | 首次听写：运行「听写一句话」→ 系统麦克风弹窗选「允许」→ 说一句中文 | 授权弹窗仅首次出现；状态栏 `Listening`；断句后文本插入光标处；系统开关位于「设置 → 隐私与安全性 → 麦克风 → Obsidian」 | **Pending** |
| **iOS-2** | 拒绝恢复：在系统设置关闭 Obsidian 麦克风 → 再运行「听写一句话」；随后重新开启并重试同一命令 | 拒绝后出现可操作的权限提示，状态回退（不卡在 `Listening`），无文本插入；重新授权后无须重启 Obsidian 即听写成功 | **Pending** |
| **iOS-3** | 朗读播控：选中一段 → 「朗读选中文本或当前笔记」→ 逐项执行暂停/继续、跳句、停止；切换到另一篇笔记 | 暂停时状态显示 `Read-aloud paused`，恢复继续；停止立即静音；切笔记自动停读，字幕/状态归位 `Voice idle` | **Pending** |
| **iOS-4** | 续读：整篇朗读中途停止，再运行「从上次位置继续朗读」；随后朗读一个选区 | 从上次中断句继续，读完后清除续读位置；朗读选区不覆盖整篇书签 | **Pending** |
| **iOS-5** | 移动端限制：检查设置页模型项与云端开关；默认（未开「允许在移动端使用云服务回退」）触发 BYOK 识别/朗读 | 本地 WASM 模型入口显示为移动端禁用；默认不发出非回环云端请求；开启并配置端点后才走云端 | **Pending** |

### 3.2 Android 实体设备

前置：Android 手机安装 Obsidian `1.11.4+` 并启用插件；`adb` 可连接。

```bash
adb shell pm revoke md.obsidian android.permission.RECORD_AUDIO   # 模拟拒绝
adb shell pm grant  md.obsidian android.permission.RECORD_AUDIO   # 恢复授权
```

| 编号 | 步骤 | 预期结果 | 状态 |
| --- | --- | --- | --- |
| **Android-1** | 首次听写：运行「听写一句话」→ 允许系统录音权限 → 说一句中文 | 授权仅首次弹出；文本插入光标处；结束后麦克风指示灯/录音提示消失，状态回 `Voice idle` | **Pending** |
| **Android-2** | 拒绝恢复：`pm revoke` 后运行「听写一句话」，再 `pm grant` 后重试 | 首次出现可读的权限指引提示且状态不卡在 `Listening`；恢复授权后同一命令听写成功 | **Pending** |
| **Android-3** | 朗读：运行「朗读选中文本或当前笔记」，再执行暂停/继续、跳句、停止，并切换笔记 | 若 System WebView 未暴露 `window.speechSynthesis`（历史模拟器实测如此），应弹出可读提示引导启用 BYOK TTS 且无未捕获异常；BYOK 朗读经 `HTMLAudioElement` 正常播放；播控与切笔记行为符合 §2 D-7/D-8 | **Pending** |
| **Android-4** | 长读稳压：连续跨 3–5 篇笔记朗读并暂停/恢复 10 次以上 | 无白屏/重载/闪退；内存无持续爬升 | **Pending** |
| **Android-5** | 移动端限制同上（iOS-5） | 同 iOS-5 | **Pending** |

## 4. 已知不可自动化 / 未覆盖

| 项 | 原因 | 处置 |
| --- | --- | --- |
| 桌面宿主原生 `SpeechRecognition` 授权错误分支（`main.ts:2201-2216`） | 标准桌面 Obsidian Electron 不暴露 `SpeechRecognition`，该分支只在移动 WebView/浏览器出现 | 归入 §3 真机待验（移动宿主识别路径） |
| 系统语音引擎音色与按句语言 | 依赖 OS 语音包 | 真机人工核对（见 N-4 既有清单） |
| 真实 AEC3 外放打断、声学延迟 | 需真实扬声器/麦克风 | 沿用既有 A-1–A-4 真机记录，不在本轮范围 |
| BYOK 云端真实调用 | 需用户密钥、不测第三方计费 | 既有 M3 真机记录 + 用户自测 |
| 授权对话框、OS 权限持久化 | 宿主/OS 行为 | 真机手动步骤（§3） |

## 5. 复跑命令与门禁

```bash
# 全量门禁（build:packages → typecheck → lint → test → build → check:release）
pnpm run check:all

# 只跑本矩阵新增/相关的自动化用例
cd packages/obsidian-plugin && node --test test/m3-plugin-qa-polish-asr.test.mjs
cd packages/obsidian-plugin && node --test test/daemon-integration.test.mjs

# 覆盖率复测（参考，不作发布门禁）
cd packages/obsidian-plugin && node --test --experimental-test-coverage
```

2026-11-27 复跑基线（`pnpm run check:all` 全绿）：三包测试 **113 core + 53 browser + 67 plugin = 233 项**（新增 3 项，无一减少）；`main.ts` 行覆盖由 `59.57%` 提升到 `65.72%`（分支 `65.02%` → `66.67%`；授权/离线听写入口与朗读播控分支由未覆盖转为覆盖）。

## 6. 能力承诺核对（本轮结论：无需改 README）

逐条对照 README 与本轮四条路径的实现：

- 「桌面离线听写……首次使用需下载模型」「先试朗读；使用系统语音时无需下载插件模型」：离线入口 `main.ts:2056` 与 `showModelGuide()` `main.ts:707` 行为一致。
- 「长笔记朗读采用**背压分批入队**，队列推进时自动补批，超长笔记不再丢尾」：`speech-player.ts:688-703` 以 `QUEUE_BATCH = 200` / `QUEUE_LOW_WATER = 80` 补批，队列实际峰值约 `280` 句；`maxQueueSize: 2000` 的溢出提示分支（`main.ts:281-288`）在正常入口不可达，承诺成立，无需收窄措辞。
- 「从上次位置继续朗读……读完后清除书签；朗读选区或问答不会覆盖书签」：`main.ts:532`、`:2598`、`:2719` 与既有自动化用例（`daemon-integration.test.mjs:340`）一致。
- 移动端「实体手机尚待验证」：与 §3 一致；本轮不新增任何移动端能力宣称。

结论：本轮未发现 README 能力承诺与实现不符，未改动 README。
