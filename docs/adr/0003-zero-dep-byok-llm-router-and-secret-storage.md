# ADR-0003：零依赖双协议 BYOK `llm-router` 与 Obsidian `SecretStorage` 凭证隔离

- **状态**：Accepted
- **日期**：2026-11-21
- **关联文档**：[SECURITY.md](../../SECURITY.md)、[docs/plan/master-plan.md](../plan/master-plan.md)

## 背景

脱离 DSH 宿主内置 LLM 服务后，Obsidian 及后续浏览器扩展需要承载两项**可选**的 BYOK（Bring Your Own Key）能力：听写后的轻度口语纠错/去口癖，以及基于当前笔记/选区的语音问答。该层面临两个经典工程陷阱：

1. **重型 AI SDK 包体膨胀与供应链脆弱**：引入官方 `openai` SDK（单包约 87 KB）或重型多模型 SDK 会显著增加单文件 `main.js` 体积、引入多层传递依赖，并受上游破坏性发版与安全公告牵连。
2. **Obsidian `data.json` 明文密钥同步泄露顽疾**：历史上大量 Obsidian 插件把 API Key 直接保存在 `.obsidian/plugins/<id>/data.json` 中，导致用户在启用 Git 同步、iCloud 或 Obsidian Sync 时意外泄露凭据（社区多次出现真实泄露事故）。Obsidian 自 **v1.11.4+** 起已官方提供跨端安全的 `app.secretStorage`（`SecretStorage`）与设置项组件 `SecretComponent`。

## 决策

1. **在 `@voice-mode/core` 实现 `< 400 行`、零第三方运行时依赖的纯 TypeScript `llm-router`**：
   - 仅维护两套标准 `fetch` + 流式 SSE 协议适配器：
     - **`openai-compat`**：统一覆盖 DeepSeek、阿里云百炼 Qwen、火山引擎方舟 Doubao、Kimi、硅基流动 SiliconFlow、OpenRouter、OpenAI 以及本地 Ollama / LM Studio；
     - **`anthropic-messages`**：独立处理 `x-api-key`、`anthropic-version`、顶层 `system` 与直连所需请求头；
   - 继承经验证的 4 重口语纠错反幻觉护栏（长度上限门、归一化编辑距离相似度门、前言/寒暄剥离、任意网络或模型异常无阻塞回退原始转写文本）；
   - 通过注入 `SecretStore` 异步接口解耦密钥读取，确保同一套路由代码可零改动复用于 Obsidian、SillyTavern 与浏览器扩展。
2. **强制执行五条出站与凭证安全红线**：
   - **凭证隔离**：Obsidian 端强制通过 `app.secretStorage` 读写，**严禁将任何 API Key 写入 `data.json`**；在低于 v1.11.4 无 `SecretStorage` 的旧版 Obsidian 中拒绝保存明文 Key 并提示升级；
   - **按预设隔离 Key**：`apiKeys[presetId]` 独立存储，切换模型提供商不串用凭据；
   - **禁跨源重定向**：所有携带鉴权头的出站请求强制 `redirect: 'error'`，防止 307/308 重定向泄露 `Authorization` / `x-api-key`；
   - **禁 URL 内嵌凭据**：校验并拒绝包含 `user:pass@` 的 `baseUrl`；
   - **先脱敏后截断**：所有错误响应体、日志与 UI 提示在截断前先经 `redact` 规则清除令牌特征，防止半截 Key 泄漏。

## 后果

- **正面**：`@voice-mode/core` 保持绝对零运行时依赖，`main.js` 体积极小且不受上游 AI SDK 漏洞波及；彻底消除 `data.json` 随 Vault 同步泄露 API Key 的结构性风险。
- **代价与约束**：不同国产模型厂商的 CORS 头、流式字段差异须在 M0 Spike-4 中逐一实测建表；无法在不支持 `SecretStorage` 的老旧 Obsidian 客户端中持久化 BYOK 密钥（需显式告知用户升级至支持版本）。
