# ADR-0007：长文本朗读策略（背压 / 导出 / 续读）

- **状态**：Accepted
- **日期**：2026-11-26
- **关联文档**：[ADR-0006](0006-expression-capability-contract.md)、内部长文本决策纪要（不公开）

## 背景

Obsidian 笔记和 SillyTavern 聊天可以非常长（数百到数千句）。早期实现把整篇句子一次性塞进 `PlaybackQueue`（`maxQueueSize: 2000`），超长时触发 `drop-newest` 丢尾，用户听到的是"读到一半突然结束"；同时大量用户希望把朗读结果保存为音频（离线收听/分享），而系统语音没有可导出的 PCM。

## 决策

1. **背压分批入队**：`speech-player` 维护 `pendingSentences`，按批（200 句/低水位 80）在播放推进时补充；队列水位保持在安全范围，超长笔记**不再丢尾**（回归测试锁定 300 句全部播放）。
2. **WAV 导出**：`SpeechPlayer.exportSentences` 逐句合成 WAV 引擎音频 → `@voice-mode/core` 的 `mergeMonoPcm16WavChunks` 解码拼接 → 单文件写入 Vault；非 WAV 引擎（系统/MP3）**明确提示不可导出**；导出前检查 VITS 模型就绪并防重（连点提示"已有导出任务进行中"）。
3. **断点续读**：`readAloudResume {path, sentenceIndex}` 随播放进度记录（防抖保存），`Resume read-aloud` 命令从同笔记上次位置继续；不同笔记提示后从头开始（索引越界 clamp）。
4. **进度可见**：字幕标题显示 `(i/N)`（多句时），`onSentenceStart(sentence, index, total)` 与播放顺序严格一致。
5. **SillyTavern 对齐**：`TtsHub.exportUtterances` 复用同一套 core 合并函数，设置抽屉提供"最后一条/最近 10 条回复"导出（默认仅导出最近回复）。

## 后果

- **体验**：长笔记/长聊天可完整朗读、可保存、可续读；队列不再因溢出丢尾。
- **复用**：WAV 合并逻辑下沉 `@voice-mode/core`（`mergeMonoPcm16WavChunks`），两宿主共享，避免重复实现。
- **边界**：导出仅限 WAV 能力引擎；MP3 引擎（部分 BYOK）不拼接（格式复杂，明确提示）。续读按**句子索引**而非时间戳，笔记大幅编辑后位置可能偏移（clamp 到有效范围）。
