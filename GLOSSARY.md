# Voice Mode

Shared domain language for offline-first voice dictation, Markdown-aware read-aloud, and optional bring-your-own-key speech and language model workflows across desktop, mobile, and browser hosts.

## Language / 术语

**Utterance**（一次发话）
A single continuous stretch of user speech bounded by speech onset and trailing silence or manual release.
_Avoid_: Audio clip, voice chunk, message

**Endpoint Policy**（语音起止判定规则）
The timing and sensitivity thresholds that govern speech onset confirmation, trailing-silence finalization, and maximum single-utterance duration.
_Avoid_: VAD config, silence settings, mic timeout

**Barge-In**（开口打断朗读）
Interrupting active read-aloud playback hands-free by speaking aloud rather than pressing a stop control.
_Avoid_: Auto-stop, voice cancel, cut-in

**Replacement Rule**（纠错替换规则）
A user-defined mapping from one or more spoken aliases or homophones to a canonical written term.
_Avoid_: Hotword, autocorrect entry, text macro

**Emotion Tag**（情感标记）
An inline prosody or pause marker embedded in text to request hushed delivery, timed silence, or paralinguistic nuance without being spoken literally.
_Avoid_: SSML tag, stage direction, voice markup

**Voice Preset**（语音预设）
A named provider and speaker profile bundling default endpoint, model, and voice selection for speech synthesis or language model requests.
_Avoid_: Account, voice template, provider profile

**Secret ID**（密钥标识符）
An opaque lowercase identifier that references a credential held in the host keychain rather than storing the credential in user settings.
_Avoid_: API key, raw token, secret value

**External Model Cache**（笔记库外的模型缓存）
Dedicated local storage outside the user's note vault that holds verified offline speech models so vault synchronization stays fast and unpolluted.
_Avoid_: Plugin folder, vault cache, asset directory

**Voice Daemon**（本机语音服务）
An optional user-run local companion service on the same machine that shares native speech recognition and synthesis models across desktop hosts.
_Avoid_: Cloud proxy, background worker, remote server

**Host Degradation**（宿主受限时的功能调整）
The deliberate narrowing of available speech capabilities on resource-constrained hosts so memory and privacy guarantees hold without crashes.
_Avoid_: Fallback bug, partial support, lite mode
