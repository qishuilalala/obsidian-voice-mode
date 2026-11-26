import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { describe, it } from "node:test";

const MOCK_OBSIDIAN_MODULE_SOURCE = `
export const capturedNotices = [];
let language = "en";
export function getLanguage() { return language; }
export function setMockLanguage(value) { language = value; }

export class Notice {
  constructor(message, timeout) {
    this.message = String(message);
    this.timeout = timeout;
    capturedNotices.push(this.message);
  }
}

function makeMockEl(tag = "div") {
  const classes = new Set();
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    textContent: "",
    value: "",
    checked: false,
    disabled: false,
    type: "",
    children: [],
    get className() {
      return Array.from(classes).join(" ");
    },
    set className(raw) {
      classes.clear();
      for (const part of String(raw).split(/\\s+/).filter(Boolean)) {
        classes.add(part);
      }
    },
    addClass(...names) {
      for (const n of names) {
        for (const part of String(n).split(/\\s+/).filter(Boolean)) {
          classes.add(part);
        }
      }
      return el;
    },
    removeClass(...names) {
      for (const n of names) {
        for (const part of String(n).split(/\\s+/).filter(Boolean)) {
          classes.delete(part);
        }
      }
      return el;
    },
    hasClass(name) {
      return classes.has(name);
    },
    setText(t) {
      el.textContent = String(t);
      return el;
    },
    getText() {
      return el.textContent;
    },
    empty() {
      el.children.length = 0;
      el.textContent = "";
      return el;
    },
    createEl(childTag, opts = {}) {
      const child = makeMockEl(childTag);
      if (opts.cls) child.addClass(opts.cls);
      if (opts.text !== undefined) child.setText(opts.text);
      if (opts.type !== undefined) child.type = opts.type;
      if (opts.value !== undefined) child.value = opts.value;
      if (opts.placeholder !== undefined) attrs.set("placeholder", opts.placeholder);
      if (opts.attr) {
        for (const [k, v] of Object.entries(opts.attr)) {
          child.attrs.set(k, String(v));
        }
      }
      el.children.push(child);
      return child;
    },
    createDiv(opts = {}) {
      return el.createEl("div", opts);
    },
    createSpan(opts = {}) {
      return el.createEl("span", opts);
    },
    addEventListener(event, fn) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    trigger(event, payload = {}) {
      const list = listeners.get(event) ?? [];
      for (const fn of list) {
        fn({ preventDefault() {}, stopPropagation() {}, ...payload });
      }
    },
    focus() {
      el.focused = true;
    },
    setCssProps() {},
    isConnected: true,
    attrs,
    focused: false,
  };
  return el;
}

export class Modal {
  constructor(app) {
    this.app = app;
    this.titleEl = makeMockEl("div");
    this.contentEl = makeMockEl("div");
    this.isOpen = false;
  }
  setTitle(title) {
    this.titleEl.setText(title);
    return this;
  }
  open() {
    this.isOpen = true;
    this.onOpen();
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.onClose();
  }
  onOpen() {}
  onClose() {}
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeMockEl("div");
    this.updatedCount = 0;
  }
  display() {}
  update() {
    this.updatedCount += 1;
  }
}

export class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.name = "";
    this.desc = "";
  }
  setName(name) {
    this.name = name;
    this.settingEl.createDiv({ cls: "setting-item-name", text: name });
    return this;
  }
  setDesc(desc) {
    this.desc = desc;
    this.settingEl.createDiv({ cls: "setting-item-description", text: desc });
    return this;
  }
  setHeading() {
    this.settingEl.addClass("setting-item-heading");
    return this;
  }
  setDisabled() {
    return this;
  }
  addText(cb) {
    const comp = {
      placeholder: "",
      value: "",
      setPlaceholder(p) { this.placeholder = p; return this; },
      setValue(v) { this.value = v; return this; },
      onChange(fn) { this._onChange = fn; return this; },
    };
    cb(comp);
    this.settingEl.children.push({ tagName: "TEXT-CONTROL", comp });
    return this;
  }
  addToggle(cb) {
    const comp = {
      value: false,
      setValue(v) { this.value = v; return this; },
      onChange(fn) { this._onChange = fn; return this; },
    };
    cb(comp);
    this.settingEl.children.push({ tagName: "TOGGLE-CONTROL", comp });
    return this;
  }
  addDropdown(cb) {
    const comp = {
      options: {},
      value: "",
      addOption(k, label) { this.options[k] = label; return this; },
      setValue(v) { this.value = v; return this; },
      onChange(fn) { this._onChange = fn; return this; },
    };
    cb(comp);
    this.settingEl.children.push({ tagName: "DROPDOWN-CONTROL", comp });
    return this;
  }
  addSlider(cb) {
    const comp = {
      value: 0,
      setLimits() { return this; },
      setValue(v) { this.value = v; return this; },
      onChange(fn) { this._onChange = fn; return this; },
    };
    cb(comp);
    return this;
  }
  addComponent(cb) {
    cb(makeMockEl("div"));
    return this;
  }
}

export class SecretComponent {
  constructor() {}
  setValue() { return this; }
  onChange() { return this; }
}

export class MarkdownView {}

export class Plugin {
  constructor(app = {}, manifest = {}) {
    this.app = app;
    this.manifest = manifest;
    this._commands = [];
  }
  async loadData() {
    return {};
  }
  async saveData() {}
  addCommand(cmd) {
    this._commands.push(cmd);
    return cmd;
  }
  addRibbonIcon() {}
  addSettingTab() {}
  addStatusBarItem() {
    return makeMockEl("div");
  }
  registerEvent() {}
  registerDomEvent() {}
}

export const Platform = {
  isMobile: false,
  isDesktop: true,
  isWin: false,
  isLinux: false,
  isSafari: false,
};

export function requireApiVersion() {
  return false;
}

export function requestUrl() {
  throw new Error("unmocked obsidian requestUrl");
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") {
      return {
        url: `data:text/javascript;charset=utf-8,${encodeURIComponent(MOCK_OBSIDIAN_MODULE_SOURCE)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { capturedNotices, setMockLanguage } = await import("obsidian");
const { createObsidianFetchWithCorsFallback } = await import("../src/obsidian-http.ts");
const {
  detectRuntimeCapabilities,
  isLoopbackAsrEndpoint,
  resolveEffectiveAsrEngine,
} = await import("../src/runtime-guard.ts");
const {
  DEFAULT_SETTINGS,
  ObsidianSecretStore,
  createDefaultSettings,
  getLlmSecretId,
  normalizeSettings,
  setLlmSecretId,
  stripSecretsFromSettings,
  toSecretId,
} = await import("../src/settings.ts");
const { VoiceModeSettingTab } = await import("../src/settings-tab.ts");
const { ModelGuideModal } = await import("../src/model-guide-modal.ts");
const { default: VoiceModePlugin } = await import("../src/main.ts");
const {
  MAX_NOTE_CONTEXT_CHARS,
  VoiceQaModal,
  extractNoteQaContext,
  formatQaContextSummary,
  polishDictatedTranscript,
  resolvePluginLlmConfig,
  runVoiceQaStream,
} = await import("../src/voice-qa-modal.ts");
const { OpenAiCompatAsrTransport, createAsrReplacer } = await import("@voice-mode/core");
const { CloudDictationSession } = await import("@voice-mode/browser");

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function createMemorySecretStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return new ObsidianSecretStore({
    getSecret: (id) => map.get(id) ?? null,
    setSecret: (id, val) => {
      map.set(id, val);
    },
    listSecrets: () => Array.from(map.keys()),
  });
}

function makeSseStream(chunks) {
  let idx = 0;
  return new ReadableStream({
    pull(controller) {
      if (idx >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(TEXT_ENCODER.encode(chunks[idx++]));
    },
  });
}

function findChildByClass(root, cls) {
  if (!root || !Array.isArray(root.children)) return null;
  for (const child of root.children) {
    if (typeof child.hasClass === "function" && child.hasClass(cls)) {
      return child;
    }
    const nested = findChildByClass(child, cls);
    if (nested) return nested;
  }
  return null;
}

function hasText(root, text) {
  if (root?.textContent === text) return true;
  for (const child of root?.children ?? []) {
    if (hasText(child, text)) return true;
  }
  return false;
}

function findButtonByText(root, text) {
  if (!root || !Array.isArray(root.children)) return null;
  for (const child of root.children) {
    if (child.tagName === "BUTTON" && child.textContent === text) {
      return child;
    }
    const nested = findButtonByText(child, text);
    if (nested) return nested;
  }
  return null;
}

describe("Obsidian interface language", () => {
  it("uses Simplified Chinese only for matching app locales and preserves interpolated values", async () => {
    const { isSimplifiedChinese, t } = await import("../src/i18n.ts");
    for (const locale of ["zh", "zh-CN", "zh-SG", "zh_Hans", "zh-Hans-CN"]) {
      assert.equal(isSimplifiedChinese(locale), true, locale);
    }
    for (const locale of ["en", "fr", "zh-TW", "zh-HK", "zh-Hant-CN", "zhx", ""]) {
      assert.equal(isSimplifiedChinese(locale), false, locale);
    }

    const providerError = "HTTP 503 {0} $&";
    try {
      setMockLanguage("zh-CN");
      assert.equal(t("AI request failed: {0}", providerError), "AI 请求失败：" + providerError);
      setMockLanguage("zh-TW");
      assert.equal(t("AI request failed: {0}", providerError), "AI request failed: " + providerError);
    } finally {
      setMockLanguage("en");
    }
  });

  it("uses Chinese in commands, notices, both settings views and the question dialog", async (test) => {
    setMockLanguage("zh");
    test.after(() => setMockLanguage("en"));
    const mockWindow = Object.create(globalThis);
    for (const [key, value] of Object.entries({
      window: mockWindow,
      activeWindow: mockWindow,
      activeDocument: { body: null, activeElement: null },
    })) {
      const old = Object.getOwnPropertyDescriptor(globalThis, key);
      Object.defineProperty(globalThis, key, { configurable: true, value });
      test.after(() => {
        if (old) Object.defineProperty(globalThis, key, old);
        else delete globalThis[key];
      });
    }
    const app = {
      vault: { adapter: {} },
      workspace: { on: () => ({}), getActiveViewOfType: () => null },
    };
    const plugin = new VoiceModePlugin(app, { id: "voice-mode", version: "0.1.0" });
    await plugin.onload();
    test.after(() => plugin.onunload());
    plugin.settings.dictationLanguage = "en-US";

    const commands = Object.fromEntries(plugin._commands.map((c) => [c.id, c.name]));
    assert.equal(Object.keys(commands).length, 11);
    assert.equal(commands["export-read-aloud-wav"], "将朗读导出为 WAV");
    assert.equal(commands["resume-read-aloud"], "从上次位置继续朗读");
    assert.equal(commands["copy-runtime-status"], "复制语音运行状态");
    assert.equal(commands["toggle-dictation"], "开始或停止听写");
    assert.equal(commands["ask-ai-about-note"], "就选中文本或当前笔记向 AI 提问");
    assert.ok(Object.values(commands).every((name) => /\p{Script=Han}/u.test(name)));
    await plugin.readSelectionOrNoteAloud();
    assert.equal(capturedNotices.at(-1), "请先打开要朗读的 Markdown 笔记。");

    const tab = new VoiceModeSettingTab(app, plugin);
    const groups = tab.getSettingDefinitions();
    assert.deepEqual(groups.map((group) => group.heading), ["快速开始", "语音输入", "朗读", "AI 模型", "模型与隐私"]);
    const engine = groups[1].items.find((item) => item.control?.key === "asrEngine");
    assert.equal(engine.name, "识别引擎");
    assert.equal(engine.control.options["sensevoice-wasm"], "SenseVoice WASM（桌面离线）");
    const providers = groups[3].items.find((item) => item.control?.key === "llmPresetId");
    assert.equal(providers.control.options["volcengine-doubao"], "火山方舟（豆包）");
    assert.equal(providers.control.options.openai, "OpenAI");
    assert.equal(tab.getControlValue("dictationLanguage"), "en-US");
    for (const group of groups) {
      for (const item of group.items) {
        assert.match(item.name, /\p{Script=Han}/u);
        if (item.desc) assert.match(item.desc, /\p{Script=Han}/u);
      }
    }
    tab.display();
    assert.ok(findButtonByText(tab.containerEl, "下载或校验模型"));
    assert.ok(findButtonByText(tab.containerEl, "添加规则"));
    assert.ok(hasText(tab.containerEl, "发音词典（朗读）"));
    // The language-scope input is rendered only when rules exist (placeholder lives in attrs).

    const modal = new VoiceQaModal(app, { scope: "selection", text: "abc", truncated: true }, {});
    modal.open();
    assert.equal(modal.titleEl.textContent, commands["ask-ai-about-note"]);
    assert.equal(findChildByClass(modal.contentEl, "vm-qa-context").textContent, "上下文：选中文本（3 个字符，已截断）");
    assert.ok(findButtonByText(modal.contentEl, "口述问题"));
    assert.ok(findButtonByText(modal.contentEl, "复制回答"));
    findButtonByText(modal.contentEl, "提问").trigger("click");
    assert.equal(capturedNotices.at(-1), "请先输入或口述问题。");
    modal.close();

    await plugin.startBrowserSpeechRecognitionFallback();
    assert.equal(
      capturedNotices.at(-1),
      "当前桌面版本不支持浏览器语音识别。请在设置中将识别引擎切换为 SenseVoice WASM 进行离线听写。",
    );

    const status = await plugin.collectRuntimeStatusJson();
    assert.equal(status.platform, "desktop");
    assert.equal(status.readAloudState, "idle");
    assert.equal(typeof status.ttsEngine, "string");
    assert.equal(typeof status.secretStorageAvailable, "boolean");
    assert.equal(status.version, "0.1.0");
  });
});

describe("settings.ts M3 fields (asrModel, enableLlmPolish, zero-secret guarantee)", () => {
  it("defaults asrModel to '' and enableLlmPolish to false, normalizes safely, and strips accidental secrets", () => {
    assert.deepEqual(DEFAULT_SETTINGS.pronunciationDict, []);
    assert.equal(DEFAULT_SETTINGS.asrModel, "");
    assert.equal(DEFAULT_SETTINGS.enableLlmPolish, false);

    const fresh = createDefaultSettings();
    assert.equal(fresh.asrModel, "");
    assert.equal(fresh.enableLlmPolish, false);

    const withPronunciation = normalizeSettings({
      pronunciationDict: [{ from: ["API"], to: "A P I" }],
    });
    assert.deepEqual(withPronunciation.pronunciationDict, [{ from: ["API"], to: "A P I" }]);
    const scopedPronunciation = normalizeSettings({
      pronunciationDict: [{ from: ["API"], to: "A P I", language: "en" }],
    });
    assert.deepEqual(scopedPronunciation.pronunciationDict, [
      { from: ["API"], to: "A P I", language: "en" },
    ]);
    const invalidLanguage = normalizeSettings({
      pronunciationDict: [{ from: ["x"], to: "y", language: "fr" }],
    });
    assert.deepEqual(invalidLanguage.pronunciationDict, []);

    const invalidPronunciation = normalizeSettings({ pronunciationDict: "not-an-array" });
    assert.deepEqual(invalidPronunciation.pronunciationDict, []);

    const normalized = normalizeSettings({
      asrEngine: "openai-compat",
      asrModel: "  gpt-4o-mini-transcribe  ",
      enableLlmPolish: true,
      enableVoiceQa: true,
    });
    assert.equal(normalized.asrEngine, "openai-compat");
    assert.equal(normalized.asrModel, "gpt-4o-mini-transcribe");
    assert.equal(normalized.enableLlmPolish, true);
    assert.equal(normalized.enableVoiceQa, true);

    // If a user accidentally pastes an API key into asrModel or arbitrary fields, stripSecretsFromSettings drops it.
    const leakedToken = ["sk", "proj", "LEAKEDSECRET1234567890abcdef"].join("-");
    const sanitized = stripSecretsFromSettings({
      asrModel: leakedToken,
      enableLlmPolish: true,
      asrApiKey: leakedToken,
      asrApiKeySecretId: "voice-mode-asr-openai-compat",
    });
    assert.equal("asrModel" in sanitized, false);
    assert.equal("asrApiKey" in sanitized, false);
    assert.equal(sanitized.enableLlmPolish, true);
    assert.equal(sanitized.asrApiKeySecretId, "voice-mode-asr-openai-compat");
    assert.equal(JSON.stringify(sanitized).includes("LEAKEDSECRET"), false);

    const normalizedFromLeak = normalizeSettings({
      asrModel: leakedToken,
      enableLlmPolish: "invalid-boolean",
    });
    assert.equal(normalizedFromLeak.asrModel, "");
    assert.equal(normalizedFromLeak.enableLlmPolish, false);
  });
});

describe("extractNoteQaContext & VoiceModeSettingTab M3 controls", () => {
  it("prefers selection over note body, handles empty editors, and truncates past 24,000 chars", () => {
    const fromSel = extractNoteQaContext(
      {
        getSelection: () => "  Selected paragraph  ",
        getValue: () => "Full note body that should not be used",
      },
      "Architecture",
    );
    assert.deepEqual(fromSel, {
      scope: "selection",
      text: "Selected paragraph",
      truncated: false,
      noteTitle: "Architecture",
    });
    assert.equal(formatQaContextSummary(fromSel), "Context: selection (18 chars)");

    const hugeNote = "A".repeat(MAX_NOTE_CONTEXT_CHARS + 500);
    const fromNote = extractNoteQaContext({
      getSelection: () => "   ",
      getValue: () => hugeNote,
    });
    assert.equal(fromNote.scope, "note");
    assert.equal(fromNote.text.length, MAX_NOTE_CONTEXT_CHARS);
    assert.equal(fromNote.truncated, true);
    assert.match(formatQaContextSummary(fromNote), /Context: active note \(24,000 chars, truncated\)/);

    const empty = extractNoteQaContext(null);
    assert.deepEqual(empty, { scope: "empty", text: "", truncated: false });
  });

  it("hides the offline-dictation quick-start step on mobile", async () => {
    const host = {
      settings: createDefaultSettings(),
      capabilities: detectRuntimeCapabilities(true),
      async saveSettings() {},
    };
    const tab = new VoiceModeSettingTab({}, host);
    const groups = tab.getSettingDefinitions();
    const quick = groups.find((group) => group.heading === "Quick start") ?? groups[0];
    const names = quick.items.map((item) => item.name);
    assert.ok(names.some((name) => name.includes("Dictation on mobile")));
    assert.ok(!names.some((name) => name.includes("offline dictation")));
    assert.ok(!names.some((name) => name.includes("local voice-daemon")));
  });

  it("exposes asrModel when effective ASR is openai-compat and wires enableLlmPolish dynamically", async () => {
    let saveCalls = 0;
    const host = {
      settings: createDefaultSettings(),
      capabilities: detectRuntimeCapabilities(false, "macos"),
      async saveSettings() {
        saveCalls += 1;
      },
    };

    const tab = new VoiceModeSettingTab({}, host);
    const defsBefore = tab.getSettingDefinitions();
    const voiceGroup = defsBefore[1];
    const aiGroup = defsBefore[3];
    const asrModelItem = voiceGroup.items.find((i) => i.name === "Transcription model override");
    const polishItem = aiGroup.items.find((i) => i.name === "Post-dictation LLM polish");

    assert.ok(asrModelItem);
    assert.ok(polishItem);
    assert.equal(asrModelItem.visible(), false);

    await tab.setControlValue("asrEngine", "openai-compat");
    assert.equal(host.settings.asrEngine, "openai-compat");
    assert.equal(asrModelItem.visible(), true);

    // Replace host.settings reference to verify dynamic lookup (no stale captured object)
    host.settings = {
      ...createDefaultSettings(),
      asrEngine: "openai-compat",
    };
    await tab.setControlValue("asrModel", "  whisper-large-v3-turbo  ");
    await tab.setControlValue("enableLlmPolish", true);
    assert.equal(tab.getControlValue("asrModel"), "whisper-large-v3-turbo");
    assert.equal(tab.getControlValue("enableLlmPolish"), true);
    assert.ok(saveCalls >= 3);
  });
});

describe("polishDictatedTranscript (guards, zero-data-loss fallback, redaction, mobile privacy)", () => {
  it("returns original text with 0 HTTP calls when enableLlmPolish is false or text is blank", async () => {
    let httpCalls = 0;
    const settings = createDefaultSettings();
    settings.enableLlmPolish = false;
    const store = createMemorySecretStore();

    const resDisabled = await polishDictatedTranscript("今天开会讨论语音模式", {
      settings,
      secretStore: store,
      isMobile: false,
      fetchImpl: async () => {
        httpCalls += 1;
        throw new Error("must not call network");
      },
    });
    assert.deepEqual(resDisabled, { text: "今天开会讨论语音模式", polished: false });
    assert.equal(httpCalls, 0);

    settings.enableLlmPolish = true;
    const resBlank = await polishDictatedTranscript("   ", {
      settings,
      secretStore: store,
      isMobile: false,
      fetchImpl: async () => {
        httpCalls += 1;
        throw new Error("must not call network");
      },
    });
    assert.deepEqual(resBlank, { text: "   ", polished: false });
    assert.equal(httpCalls, 0);
  });

  it("accepts minimal typo/punctuation fixes and rejects preamble, rewrite, and >3x length hallucinations", async () => {
    const secretId = toSecretId("llm", "deepseek");
    const fakeKey = ["sk", "mock", "validdeepseekkey123456"].join("-");
    const store = createMemorySecretStore({ [secretId]: fakeKey });
    const settings = createDefaultSettings();
    settings.enableLlmPolish = true;
    settings.llmPresetId = "deepseek";
    setLlmSecretId(settings, "deepseek", secretId);
    assert.equal(getLlmSecretId(settings, "deepseek"), secretId);

    let nextReply = "今天下午三点开会，讨论语音笔记插件。";
    let capturedAuth = "";

    const mockFetch = async (_url, init) => {
      capturedAuth = init?.headers?.authorization ?? init?.headers?.Authorization ?? "";
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: nextReply } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    // 1. Valid minimal punctuation & homophone fix -> accepted
    const rawValid = "今天下午三点开会讨论语音笔记插件";
    const okRes = await polishDictatedTranscript(rawValid, {
      settings,
      secretStore: store,
      isMobile: false,
      fetchImpl: mockFetch,
    });
    assert.equal(okRes.polished, true);
    assert.equal(okRes.text, "今天下午三点开会，讨论语音笔记插件。");
    assert.equal(okRes.fallbackReason, undefined);
    assert.equal(capturedAuth, `Bearer ${fakeKey}`);

    // 2. Preamble ("Here is the corrected text: ...") -> rejected by guard, returns original
    settings.dictationLanguage = "en-US";
    const rawEn = "we shipped the obsidian plugin today";
    nextReply = "Here is the corrected text: We shipped the Obsidian plugin today.";
    const preambleRes = await polishDictatedTranscript(rawEn, {
      settings,
      secretStore: store,
      isMobile: false,
      fetchImpl: mockFetch,
    });
    assert.equal(preambleRes.text, rawEn);
    assert.equal(preambleRes.polished, false);

    // 3. >3x length explosion -> rejected by guard, returns original
    nextReply =
      "We shipped the Obsidian plugin today, and furthermore here is a long unsolicited essay expanding on voice interfaces, architecture, and productivity workflows across desktop and mobile platforms!";
    const explosionRes = await polishDictatedTranscript(rawEn, {
      settings,
      secretStore: store,
      isMobile: false,
      fetchImpl: mockFetch,
    });
    assert.equal(explosionRes.text, rawEn);
    assert.equal(explosionRes.polished, false);

    // 4. Hallucinated answer / low Levenshtein similarity rewrite -> rejected by guard, returns original
    nextReply = "Sure! Quantum computing uses qubits to represent superpositions.";
    const rewriteRes = await polishDictatedTranscript(rawEn, {
      settings,
      secretStore: store,
      isMobile: false,
      fetchImpl: mockFetch,
    });
    assert.equal(rewriteRes.text, rawEn);
    assert.equal(rewriteRes.polished, false);
  });

  it("catches HTTP 401/500 with embedded sk-proj-LEAKEDSECRET token and timeouts with zero secret leak and zero data loss", async () => {
    const secretId = toSecretId("llm", "openai");
    const leakedSecret = ["sk", "proj", "LEAKEDSECRET9876543210abcdef"].join("-");
    const store = createMemorySecretStore({ [secretId]: leakedSecret });
    const settings = createDefaultSettings();
    settings.enableLlmPolish = true;
    settings.llmPresetId = "openai";
    setLlmSecretId(settings, "openai", secretId);

    const rawDictation = "这段重要口述绝对不能因为接口报错而丢失";

    // HTTP 401 echoing back the raw secret token
    const res401 = await polishDictatedTranscript(rawDictation, {
      settings,
      secretStore: store,
      isMobile: false,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${leakedSecret}. Authorization: Bearer ${leakedSecret}`,
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    });
    assert.equal(res401.text, rawDictation);
    assert.equal(res401.polished, false);
    assert.ok(res401.fallbackReason);
    assert.match(res401.fallbackReason, /401/);
    assert.equal(res401.fallbackReason.includes("LEAKEDSECRET"), false);
    assert.equal(res401.fallbackReason.includes(leakedSecret), false);

    // Network timeout -> still returns rawDictation intact
    const resTimeout = await polishDictatedTranscript(rawDictation, {
      settings,
      secretStore: store,
      isMobile: false,
      timeoutMs: 25,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal.reason ?? new Error("aborted"));
          });
        }),
    });
    assert.equal(resTimeout.text, rawDictation);
    assert.equal(resTimeout.polished, false);
    assert.match(resTimeout.fallbackReason ?? "", /timed out/i);
  });

  it("enforces mobile allowCloudFallbackOnMobile privacy gate while permitting local loopback HTTP", async () => {
    const secretId = toSecretId("llm", "openai");
    const store = createMemorySecretStore({
      [secretId]: ["sk", "mock", "mobilecloudkey12345678"].join("-"),
    });
    const settings = createDefaultSettings();
    settings.enableLlmPolish = true;
    settings.llmPresetId = "openai";
    settings.allowCloudFallbackOnMobile = false;
    setLlmSecretId(settings, "openai", secretId);

    let cloudCalls = 0;
    assert.throws(
      () =>
        resolvePluginLlmConfig({
          settings,
          secretStore: store,
          isMobile: true,
          fetchImpl: async () => new Response("{}"),
        }),
      /disabled on mobile by privacy settings/i,
    );

    const blockedMobile = await polishDictatedTranscript("移动端隐私拦截测试", {
      settings,
      secretStore: store,
      isMobile: true,
      fetchImpl: async () => {
        cloudCalls += 1;
        return new Response("{}");
      },
    });
    assert.equal(cloudCalls, 0);
    assert.equal(blockedMobile.text, "移动端隐私拦截测试");
    assert.equal(blockedMobile.polished, false);
    assert.match(blockedMobile.fallbackReason ?? "", /disabled on mobile/i);

    // Switching to loopback http://127.0.0.1:11434/v1 is allowed even when allowCloudFallbackOnMobile is false!
    settings.llmPresetId = "ollama";
    settings.llmBaseUrl = "http://127.0.0.1:11434/v1";
    let loopbackCalls = 0;
    const allowedLoopback = await polishDictatedTranscript("本地回环纠错测试", {
      settings,
      secretStore: store,
      isMobile: true,
      fetchImpl: async (url) => {
        loopbackCalls += 1;
        assert.equal(url, "http://127.0.0.1:11434/v1/chat/completions");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "本地回环纠错测试。" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    assert.equal(loopbackCalls, 1);
    assert.equal(allowedLoopback.polished, true);
    assert.equal(allowedLoopback.text, "本地回环纠错测试。");
  });
});

describe("runVoiceQaStream & VoiceQaModal (SSE + CORS fallback + SentenceSegmenter + non-SSE JSON)", () => {
  it("streams SSE deltas through desktop CORS fallback and segments spoken sentences while stripping Markdown tables", async () => {
    const secretId = toSecretId("llm", "volcengine-doubao");
    const arkKey = ["ark", "mock", "secretkey1234567890"].join("-");
    const store = createMemorySecretStore({ [secretId]: arkKey });
    const settings = createDefaultSettings();
    settings.enableVoiceQa = true;
    settings.llmPresetId = "volcengine-doubao";
    settings.llmModel = "ep-20261121-doubao";
    settings.markdownTablePolicy = "skip";
    setLlmSecretId(settings, "volcengine-doubao", secretId);

    const sseFrames = [
      'data: {"choices":[{"delta":{"content":"**第一句总结**：该项目支持离线语音听写。"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"\\n\\n| 引擎 | 平台 |\\n| --- | --- |\\n| SenseVoice | Desktop |\\n\\n"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"第二句说明：移动端默认保护隐私！"}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    const corsEvents = [];
    const mockNodeHttps = {
      request(url, opts, cb) {
        assert.equal(url, "https://ark.cn-beijing.volces.com/api/v3/chat/completions");
        assert.equal(opts.headers.authorization, `Bearer ${arkKey}`);
        let reqBody = "";
        return {
          on() {
            return this;
          },
          write(chunk) {
            reqBody += typeof chunk === "string" ? chunk : TEXT_DECODER.decode(chunk);
            return true;
          },
          end() {
            const parsed = JSON.parse(reqBody);
            assert.equal(parsed.model, "ep-20261121-doubao");
            assert.equal(parsed.stream, true);
            const res = {
              statusCode: 200,
              headers: { "content-type": "text/event-stream" },
              destroy() {},
              async *[Symbol.asyncIterator]() {
                for (const frame of sseFrames) {
                  yield TEXT_ENCODER.encode(frame);
                }
              },
            };
            queueMicrotask(() => cb(res));
          },
          destroy() {},
        };
      },
    };

    const corsFetch = createObsidianFetchWithCorsFallback({
      isDesktop: true,
      win: {
        require: (name) => (name === "https" ? mockNodeHttps : null),
      },
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch (CORS origin app://obsidian.md)");
      },
      onCorsFallback: (origin, via) => corsEvents.push({ origin, via }),
    });

    const deltas = [];
    const spokenSentences = [];
    const full = await runVoiceQaStream(
      "请总结这段笔记",
      {
        scope: "selection",
        text: "Voice Mode 插件支持桌面端 SenseVoice 离线听写与移动端隐私守护。",
        noteTitle: "Design",
      },
      {
        settings,
        secretStore: store,
        fetchImpl: corsFetch,
        isMobile: false,
        onDelta: (delta) => deltas.push(delta),
        onSentence: (sentence) => spokenSentences.push(sentence),
      },
    );

    assert.equal(deltas.length, 3);
    assert.ok(full.includes("| SenseVoice | Desktop |"));
    assert.deepEqual(corsEvents, [
      { origin: "https://ark.cn-beijing.volces.com", via: "desktop-node" },
    ]);

    // Spoken sentences must strip Markdown bold markers and skip the Markdown pipe table!
    assert.equal(spokenSentences.length, 2);
    assert.equal(spokenSentences[0], "第一句总结：该项目支持离线语音听写。");
    assert.equal(spokenSentences[1], "第二句说明：移动端默认保护隐私！");
    assert.equal(spokenSentences.some((s) => s.includes("|") || s.includes("**")), false);
  });

  it("handles non-SSE application/json fallback via Obsidian requestUrl (mobile Doubao/OpenAI CORS fallback)", async () => {
    const secretId = toSecretId("llm", "openai");
    const store = createMemorySecretStore({
      [secretId]: ["sk", "mock", "requesturlkey123456789"].join("-"),
    });
    const settings = createDefaultSettings();
    settings.enableVoiceQa = true;
    settings.allowCloudFallbackOnMobile = true;
    settings.llmPresetId = "openai";
    setLlmSecretId(settings, "openai", secretId);

    const corsEvents = [];
    const jsonPayload = JSON.stringify({
      choices: [
        {
          message: {
            content: "First concise answer sentence. Second sentence from JSON fallback!",
          },
        },
      ],
    });
    const payloadBytes = TEXT_ENCODER.encode(jsonPayload);

    const corsFetch = createObsidianFetchWithCorsFallback({
      isDesktop: false,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
      requestUrlImpl: async (param) => {
        assert.equal(param.url, "https://api.openai.com/v1/chat/completions");
        assert.equal(param.throw, false);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          arrayBuffer: payloadBytes.buffer.slice(
            payloadBytes.byteOffset,
            payloadBytes.byteOffset + payloadBytes.byteLength,
          ),
        };
      },
      onCorsFallback: (origin, via) => corsEvents.push({ origin, via }),
    });

    const sentences = [];
    const full = await runVoiceQaStream(
      "What are the two points?",
      { scope: "note", text: "Point 1 and Point 2." },
      {
        settings,
        secretStore: store,
        fetchImpl: corsFetch,
        isMobile: true,
        onSentence: (s) => sentences.push(s),
      },
    );

    assert.equal(full, "First concise answer sentence. Second sentence from JSON fallback!");
    assert.deepEqual(sentences, [
      "First concise answer sentence.",
      "Second sentence from JSON fallback!",
    ]);
    assert.deepEqual(corsEvents, [
      { origin: "https://api.openai.com", via: "obsidian-request-url" },
    ]);
  });

  it("drives VoiceQaModal UI (dictate question, stream answer, insert at cursor, onClose abort & stop read-aloud)", async () => {
    const secretId = toSecretId("llm", "deepseek");
    const store = createMemorySecretStore({
      [secretId]: ["sk", "mock", "modalkey1234567890ab"].join("-"),
    });
    const settings = createDefaultSettings();
    settings.enableVoiceQa = true;
    settings.llmPresetId = "deepseek";
    setLlmSecretId(settings, "deepseek", secretId);
    assert.equal(getLlmSecretId(settings, "deepseek"), secretId);

    const spoken = [];
    let stopReadAloudCount = 0;
    let insertedText = "";

    const modal = new VoiceQaModal(
      {},
      { scope: "selection", text: "Key architecture notes.", truncated: false },
      {
        settings,
        secretStore: store,
        isMobile: false,
        fetchImpl: async () =>
          new Response(
            makeSseStream([
              'data: {"choices":[{"delta":{"content":"Here is the grounded answer. "}}]}\n\n',
              'data: {"choices":[{"delta":{"content":"It has two spoken sentences."}}]}\n\n',
              "data: [DONE]\n\n",
            ]),
            { status: 200, headers: { "content-type": "text/event-stream" } },
          ),
        onDictateQuestion: async (onTranscript) => {
          onTranscript("What does this note cover?");
        },
        onSpeakSentence: (s) => spoken.push(s),
        onStopReadAloud: () => {
          stopReadAloudCount += 1;
        },
        onInsertAtCursor: (ans) => {
          insertedText = ans;
          return true;
        },
      },
    );

    modal.open();
    assert.equal(modal.titleEl.textContent, "Ask AI about selection or note");

    const promptEl = findChildByClass(modal.contentEl, "vm-qa-prompt");
    const dictateBtn = findButtonByText(modal.contentEl, "Dictate question");
    const askBtn = findButtonByText(modal.contentEl, "Ask");
    const answerEl = findChildByClass(modal.contentEl, "vm-qa-answer");
    assert.ok(promptEl && dictateBtn && askBtn && answerEl);

    // Trigger single-utterance dictation into modal prompt
    dictateBtn.trigger("click");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(promptEl.value, "What does this note cover?");

    // Submit question and wait for SSE stream completion
    askBtn.trigger("click");
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(
      answerEl.textContent,
      "Here is the grounded answer. It has two spoken sentences.",
    );
    assert.deepEqual(spoken, [
      "Here is the grounded answer.",
      "It has two spoken sentences.",
    ]);

    const insertBtn = findButtonByText(modal.contentEl, "Insert at cursor");
    assert.ok(insertBtn);
    insertBtn.trigger("click");
    assert.equal(insertedText, "Here is the grounded answer. It has two spoken sentences.");

    // Closing modal stops read-aloud initiated by the modal
    modal.close();
    assert.ok(stopReadAloudCount >= 1);
    assert.ok(capturedNotices.includes("Inserted answer at cursor."));
  });
});

describe("End-to-end integration: CloudDictationSession + OpenAiCompatAsrTransport + ObsidianSecretStore + createAsrReplacer + polishDictatedTranscript", () => {
  it("captures 16 kHz speech, uploads WAV multipart with SecretStore key, applies vocabulary replacements, and polishes with zero-data-loss guarantee", async () => {
    const asrSecretId = toSecretId("asr", "openai-compat");
    const llmSecretId = toSecretId("llm", "deepseek");
    const asrKey = ["sk", "asr", "secretkey1234567890abcd"].join("-");
    const llmKey = ["sk", "llm", "secretkey1234567890abcd"].join("-");

    const secretStore = createMemorySecretStore({
      [asrSecretId]: asrKey,
      [llmSecretId]: llmKey,
    });

    const settings = createDefaultSettings();
    settings.asrEngine = "openai-compat";
    settings.asrEndpointUrl = "https://api.openai.com/v1";
    settings.asrModel = "whisper-large-v3-turbo";
    settings.asrApiKeySecretId = asrSecretId;
    settings.dictationLanguage = "zh-CN";
    settings.endpointSilenceMs = 400;
    settings.asrReplacements = [{ from: ["光四点", "黑曜石笔记"], to: "Obsidian" }];
    settings.enableLlmPolish = true;
    settings.llmPresetId = "deepseek";
    setLlmSecretId(settings, "deepseek", llmSecretId);

    const networkLog = [];
    let simulatePolishFailure = false;

    const sharedFetch = createObsidianFetchWithCorsFallback({
      isDesktop: false,
      fetchImpl: async (url, init) => {
        const urlStr = String(url);
        networkLog.push(urlStr);

        if (urlStr.endsWith("/audio/transcriptions")) {
          assert.equal(init?.headers?.Authorization, `Bearer ${asrKey}`);
          const contentType = init?.headers?.["Content-Type"] ?? "";
          assert.match(contentType, /^multipart\/form-data; boundary=/);
          const bodyBytes = init?.body;
          assert.ok(bodyBytes instanceof Uint8Array);
          // Verify multipart contains model override & RIFF WAVE header
          const latin1 = Buffer.from(bodyBytes).toString("latin1");
          assert.ok(latin1.includes("whisper-large-v3-turbo"));
          assert.ok(latin1.includes("RIFF"));
          assert.ok(latin1.includes("WAVE"));

          return new Response(
            JSON.stringify({ text: "我在光四点里测试语音输入同音字纠错" }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        if (urlStr.endsWith("/chat/completions")) {
          if (simulatePolishFailure) {
            return new Response(
              `{"error":"upstream 500 with token ${llmKey}"}`,
              { status: 500, headers: { "content-type": "application/json" } },
            );
          }
          const parsedBody = JSON.parse(String(init?.body ?? "{}"));
          // Vocabulary replacement must already have transformed 光四点 -> Obsidian before polish!
          assert.equal(parsedBody.messages.at(-1).content, "我在Obsidian里测试语音输入同音字纠错");
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: "我在 Obsidian 里测试语音输入同音字纠错。" } },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        throw new Error(`Unexpected URL: ${urlStr}`);
      },
    });

    const transport = new OpenAiCompatAsrTransport({
      baseUrl: settings.asrEndpointUrl,
      model: settings.asrModel,
      language: settings.dictationLanguage,
      apiKey: () => secretStore.getSecret(settings.asrApiKeySecretId),
      fetchImpl: sharedFetch,
    });

    let pushMicChunk = null;
    const committedOutputs = [];
    const fallbackReasons = [];
    let doneResolve;
    let donePromise = new Promise((r) => {
      doneResolve = r;
    });

    const session = new CloudDictationSession({
      transport,
      endpointPolicy: { silenceMs: settings.endpointSilenceMs },
      language: settings.dictationLanguage,
      captureAudio: async ({ onChunk }) => {
        pushMicChunk = onChunk;
        return {
          nativeAecActive: true,
          stop: async () => {},
        };
      },
      onFinalTranscript: (rawText) => {
        void (async () => {
          const replaced = createAsrReplacer(settings.asrReplacements)(rawText).trim();
          const polished = await polishDictatedTranscript(replaced, {
            settings,
            secretStore,
            fetchImpl: sharedFetch,
            isMobile: false,
          });
          if (polished.fallbackReason) {
            fallbackReasons.push(polished.fallbackReason);
          }
          committedOutputs.push(polished.text);
          doneResolve();
        })();
      },
    });

    // Run 1: Full happy path (Mic PCM -> WAV upload -> ASR -> Replacer -> LLM polish)
    await session.start("single");
    assert.equal(session.state, "listening");

    // Feed 250 ms of 16 kHz speech (4,000 samples @ amplitude 0.15 > 0.008 RMS threshold)
    const speechFrame = new Float32Array(1600).fill(0.15);
    pushMicChunk(speechFrame);
    pushMicChunk(speechFrame);
    pushMicChunk(speechFrame);

    // Feed 500 ms of trailing silence (8,000 samples @ 0.0) to trigger 400 ms silence endpoint
    const silenceFrame = new Float32Array(4000);
    pushMicChunk(silenceFrame);
    pushMicChunk(silenceFrame);

    await donePromise;
    assert.equal(session.state, "idle");
    assert.deepEqual(committedOutputs, ["我在 Obsidian 里测试语音输入同音字纠错。"]);
    assert.deepEqual(fallbackReasons, []);
    assert.deepEqual(networkLog, [
      "https://api.openai.com/v1/audio/transcriptions",
      "https://api.deepseek.com/v1/chat/completions",
    ]);

    // Run 2: LLM polish HTTP 500 failure -> zero data loss + redacted fallbackReason
    simulatePolishFailure = true;
    donePromise = new Promise((r) => {
      doneResolve = r;
    });
    await session.start("single");
    pushMicChunk(speechFrame);
    pushMicChunk(speechFrame);
    pushMicChunk(speechFrame);
    pushMicChunk(silenceFrame);
    pushMicChunk(silenceFrame);

    await donePromise;
    assert.equal(committedOutputs[1], "我在Obsidian里测试语音输入同音字纠错");
    assert.equal(fallbackReasons.length, 1);
    assert.match(fallbackReasons[0], /500/);
    assert.equal(fallbackReasons[0].includes(llmKey), false);

    await transport.close();
  });

  it("verifies VoiceModePlugin BYOK ASR pre-flight check, single polish fallback Notice, and ask-ai-about-note guard", async () => {
    const nodeRequire = createRequire(import.meta.url);
    const hadWin = "window" in globalThis;
    const hadActiveWin = "activeWindow" in globalThis;
    const hadActiveDoc = "activeDocument" in globalThis;
    const mockWin = Object.assign(Object.create(globalThis), {
      require: nodeRequire,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    globalThis.window = mockWin;
    globalThis.activeWindow = mockWin;
    globalThis.activeDocument = {
      activeElement: null,
      body: null,
    };

    try {
      const secretMap = new Map();
      const app = {
        secretStorage: {
          getSecret: (id) => secretMap.get(id) ?? null,
          setSecret: (id, val) => secretMap.set(id, val),
          listSecrets: () => Array.from(secretMap.keys()),
        },
        workspace: {
          on: () => ({}),
          getActiveViewOfType: () => null,
        },
        vault: {
          adapter: {},
        },
      };

      let editorInserted = [];
      const plugin = new VoiceModePlugin(app, { id: "voice-mode", version: "0.1.0" });
      await plugin.onload();
      plugin.commitDictatedText = (text) => {
        editorInserted.push(text);
      };

      // 1. ask-ai-about-note command checks enableVoiceQa first
      const qaCmd = plugin._commands.find((c) => c.id === "ask-ai-about-note");
      assert.ok(qaCmd);
      assert.equal(qaCmd.name, "Ask AI about selection or note");

      capturedNotices.length = 0;
      qaCmd.callback();
      assert.ok(
        capturedNotices.includes(
          "Enable optional BYOK voice assistant in Voice Mode settings first.",
        ),
      );

      // 2. BYOK openai-compat dictation pre-flight check rejects missing API key BEFORE mic capture
      plugin.settings.asrEngine = "openai-compat";
      plugin.settings.asrEndpointUrl = "https://api.openai.com/v1";
      plugin.settings.asrApiKeySecretId = "";
      capturedNotices.length = 0;
      await plugin.toggleDictation();
      assert.ok(
        capturedNotices.includes(
          "Configure a transcription API key in Voice Mode settings before starting BYOK dictation.",
        ),
      );

      // 3. processAndCommitDictation notifies once on polish fallback, commits unpolished text, and resets on saveSettings()
      plugin.settings.asrReplacements = [{ from: ["光四点"], to: "Obsidian" }];
      plugin.settings.enableLlmPolish = true;
      plugin.settings.llmPresetId = "openai"; // No secret configured -> missing_config fallback!
      capturedNotices.length = 0;
      editorInserted = [];

      await plugin.processAndCommitDictation("第一个光四点片段");
      await plugin.processAndCommitDictation("第二个光四点片段");

      assert.deepEqual(editorInserted, ["第一个Obsidian片段", "第二个Obsidian片段"]);
      const skipNotices = capturedNotices.filter((m) =>
        m.startsWith("Transcript polish skipped ("),
      );
      assert.equal(skipNotices.length, 1);

      // targetOverride (used by VoiceQaModal "Dictate question") bypasses polish and routes straight to modal callback
      const modalCaptured = [];
      await plugin.processAndCommitDictation("光四点里有什么", (t) => modalCaptured.push(t));
      assert.deepEqual(modalCaptured, ["Obsidian里有什么"]);
      assert.equal(editorInserted.length, 2);

      // saveSettings() resets polishFallbackNotified so a changed configuration can surface a fresh diagnostic once
      await plugin.saveSettings();
      capturedNotices.length = 0;
      await plugin.processAndCommitDictation("第三个光四点片段");
      assert.equal(
        capturedNotices.filter((m) => m.startsWith("Transcript polish skipped (")).length,
        1,
      );

      plugin.onunload();
    } finally {
      if (!hadWin) delete globalThis.window;
      if (!hadActiveWin) delete globalThis.activeWindow;
      if (!hadActiveDoc) delete globalThis.activeDocument;
    }
  });

  it("enforces mobile loopback ASR exception (Important-2), mid-polish onunload zero-data-loss commit (Important-3), and VoiceQaModal cancel/empty-utterance safety (Blocker-1 & Minor-1)", async () => {
    // 1. Important-2: Mobile privacy guard blocks remote HTTPS openai-compat ASR when allowCloudFallbackOnMobile=false,
    //    but permits credential-free local loopback HTTP ASR (matching SECURITY.md & resolvePluginLlmConfig).
    const mobileCaps = detectRuntimeCapabilities(true);
    assert.equal(isLoopbackAsrEndpoint(""), false);
    assert.equal(isLoopbackAsrEndpoint("https://api.openai.com/v1"), false);
    assert.equal(isLoopbackAsrEndpoint("http://127.0.0.1:8000/v1"), true);
    assert.equal(isLoopbackAsrEndpoint("http://localhost:9000/v1"), true);
    assert.equal(isLoopbackAsrEndpoint("http://[::1]:8000/v1"), true);

    assert.equal(
      resolveEffectiveAsrEngine("openai-compat", mobileCaps, false, ""),
      "system",
    );
    assert.equal(
      resolveEffectiveAsrEngine("openai-compat", mobileCaps, false, "https://api.openai.com/v1"),
      "system",
    );
    assert.equal(
      resolveEffectiveAsrEngine("openai-compat", mobileCaps, false, "http://127.0.0.1:8000/v1"),
      "openai-compat",
    );

    const nodeRequire = createRequire(import.meta.url);
    const hadWin = "window" in globalThis;
    const hadActiveWin = "activeWindow" in globalThis;
    const hadActiveDoc = "activeDocument" in globalThis;
    const mockWin = Object.assign(Object.create(globalThis), {
      require: nodeRequire,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
    globalThis.window = mockWin;
    globalThis.activeWindow = mockWin;
    globalThis.activeDocument = {
      activeElement: null,
      body: null,
    };

    try {
      const secretMap = new Map();
      const llmSecretId = toSecretId("llm", "deepseek");
      secretMap.set(llmSecretId, ["sk", "mock", "deepseektest12345678"].join("-"));

      const replacedSelections = [];
      const mockEditor = {
        getSelection: () => "Original selected note paragraph that MUST NOT be overwritten",
        getValue: () => "Original selected note paragraph that MUST NOT be overwritten\nBody text.",
        getCursor: () => ({ line: 0, ch: 0 }),
        getLine: () => "",
        replaceSelection: (text) => {
          replacedSelections.push(text);
        },
        replaceRange: (text) => {
          replacedSelections.push(text);
        },
      };
      const { MarkdownView: MockMarkdownView } = await import("obsidian");
      const mockView = Object.assign(new MockMarkdownView(), {
        editor: mockEditor,
        file: { basename: "ImportantNote", path: "ImportantNote.md" },
        containerEl: { contains: () => false },
      });

      const app = {
        secretStorage: {
          getSecret: (id) => secretMap.get(id) ?? null,
          setSecret: (id, val) => secretMap.set(id, val),
          listSecrets: () => Array.from(secretMap.keys()),
        },
        workspace: {
          on: () => ({}),
          getActiveViewOfType: () => mockView,
          getMostRecentLeaf: () => ({ view: mockView }),
          getLeavesOfType: () => [{ view: mockView }],
        },
        vault: {
          adapter: {},
        },
      };

      // 2. Blocker-1 & Minor-1: Dictating into VoiceQaModal and closing while listening OR mid-upload aborts ASR
      //    with ZERO editor insertions / selection overwrites, and empty utterances reset the button label.
      const plugin = new VoiceModePlugin(app, { id: "voice-mode", version: "0.1.0" });
      await plugin.onload();
      plugin.settings.enableVoiceQa = true;
      plugin.settings.asrEngine = "openai-compat";
      plugin.settings.asrEndpointUrl = "http://127.0.0.1:18080/v1";
      plugin.settings.endpointSilenceMs = 400;

      let pushMicChunk = null;
      let nextAsrResultMode = "empty"; // "empty" | "hang"
      let abortedUploadCount = 0;

      plugin.corsFetch = async (_url, init) => {
        if (nextAsrResultMode === "empty") {
          return new Response(JSON.stringify({ text: "   " }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortedUploadCount += 1;
            reject(init.signal.reason ?? new Error("aborted"));
          });
        });
      };

      const session = plugin.ensureCloudDictationSession();
      session.captureAudio = async ({ onChunk }) => {
        pushMicChunk = onChunk;
        return {
          nativeAecActive: true,
          stop: async () => {},
        };
      };

      const qaCmd = plugin._commands.find((c) => c.id === "ask-ai-about-note");
      qaCmd.callback();
      const modal1 = plugin.activeQaModal;
      assert.ok(modal1);

      const speechFrame = new Float32Array(1600).fill(0.15);
      const silenceFrame = new Float32Array(4000);

      // Minor-1 check: single-utterance dictation returning whitespace "" resets button back to "Dictate question"
      const dictateBtn1 =
        findButtonByText(modal1.contentEl, "Dictate question") ??
        findButtonByText(modal1.contentEl, "Stop dictation");
      assert.ok(dictateBtn1);
      await modal1.handleDictateQuestionClick();
      assert.equal(dictateBtn1.textContent, "Stop dictation");
      pushMicChunk(speechFrame);
      pushMicChunk(speechFrame);
      pushMicChunk(speechFrame);
      pushMicChunk(silenceFrame);
      pushMicChunk(silenceFrame);
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(session.state, "idle");
      assert.equal(dictateBtn1.textContent, "Dictate question");
      assert.equal(replacedSelections.length, 0);

      // Blocker-1 check A: Start dictating question, speak, and close modal BEFORE silence endpoint -> silent abort, 0 editor overwrites
      nextAsrResultMode = "hang";
      capturedNotices.length = 0;
      await modal1.handleDictateQuestionClick();
      assert.equal(session.state, "listening");
      pushMicChunk(speechFrame);
      pushMicChunk(speechFrame);
      pushMicChunk(speechFrame);
      modal1.close();
      await new Promise((r) => setTimeout(r, 25));
      assert.equal(session.state, "idle");
      assert.equal(abortedUploadCount, 0); // aborted before flushing to HTTP!
      assert.equal(replacedSelections.length, 0);
      assert.equal(capturedNotices.includes("Cloud voice dictation stopped."), false);

      // Blocker-1 check B: Start dictating question, click "Stop dictation" (starting slow Cloud ASR upload),
      // then close modal mid-upload -> aborts in-flight HTTP upload, 0 editor overwrites!
      qaCmd.callback();
      const modal2 = plugin.activeQaModal;
      assert.ok(modal2);
      await modal2.handleDictateQuestionClick();
      pushMicChunk(speechFrame);
      pushMicChunk(speechFrame);
      pushMicChunk(speechFrame);
      const stopFlushPromise = modal2.handleDictateQuestionClick();
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(session.state, "transcribing");
      modal2.close();
      await stopFlushPromise;
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(abortedUploadCount, 1);
      assert.equal(session.state, "idle");
      assert.equal(replacedSelections.length, 0);

      // 3. Important-3: If onunload() fires while polishDictatedTranscript is mid-flight,
      //    already-transcribed text is silently committed to the editor with zero data loss and zero Notice!
      plugin.settings.enableLlmPolish = true;
      plugin.settings.llmPresetId = "deepseek";
      setLlmSecretId(plugin.settings, "deepseek", llmSecretId);
      plugin.corsFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal.reason ?? new Error("unload abort"));
          });
        });

      capturedNotices.length = 0;
      const polishPromise = plugin.processAndCommitDictation("卸载瞬间不能丢失的口述内容");
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(plugin.polishAbortControllers.size, 1);
      plugin.onunload();
      await polishPromise;

      assert.deepEqual(replacedSelections, ["卸载瞬间不能丢失的口述内容"]);
      assert.equal(capturedNotices.length, 0);
    } finally {
      if (!hadWin) delete globalThis.window;
      if (!hadActiveWin) delete globalThis.activeWindow;
      if (!hadActiveDoc) delete globalThis.activeDocument;
    }
  });
});

describe("ModelGuideModal (P0-4 first-run download guide)", () => {
  it("explains the one-time download, reports progress, completes and can be skipped", async () => {
    const events = [];
    const progresses = [];
    const modal = new ModelGuideModal({}, {
      kind: "vits",
      download: async (onProgress) => {
        onProgress({ percent: 42 });
        progresses.push(42);
        events.push("downloaded");
        return { ready: true };
      },
      onSkip: () => events.push("skipped"),
    });
    modal.open();
    assert.match(modal.titleEl.textContent, /Download the local speech model|下载本地语音模型/);
    assert.ok(hasText(modal.contentEl, "Download now") || hasText(modal.contentEl, "立即下载"));
    assert.ok(hasText(modal.contentEl, "Use system speech for now") || hasText(modal.contentEl, "暂时使用系统语音"));

    const downloadButton = findButtonByText(modal.contentEl, "Download now") ?? findButtonByText(modal.contentEl, "立即下载");
    downloadButton.trigger("click");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(progresses, [42]);
    assert.ok(events.includes("downloaded"));
    assert.ok(hasText(modal.contentEl, "Download complete.") || hasText(modal.contentEl, "下载完成。"));

    const skipModal = new ModelGuideModal({}, {
      kind: "dictation",
      download: async () => ({}),
      onSkip: () => events.push("skipped"),
    });
    skipModal.open();
    assert.match(skipModal.titleEl.textContent, /Download the offline dictation models|下载离线听写模型/);
    (findButtonByText(skipModal.contentEl, "Use system speech for now") ?? findButtonByText(skipModal.contentEl, "暂时使用系统语音")).trigger("click");
    assert.ok(events.includes("skipped"));
    assert.equal(skipModal.isOpen, false);
  });
});

