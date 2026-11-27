import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { describe, it } from "node:test";

const MOCK_OBSIDIAN_SOURCE = `
export const capturedNotices = [];
export function getLanguage() { return "en"; }
export const secretComponentInstances = [];

export class Notice {
  constructor(message) {
    this.message = String(message);
    capturedNotices.push(this.message);
  }
}

function makeEl(tag = "div") {
  const classes = new Set();
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    textContent: "",
    children: [],
    addClass(...names) {
      for (const n of names) {
        for (const p of String(n).split(/\\s+/).filter(Boolean)) classes.add(p);
      }
      return el;
    },
    removeClass(...names) {
      for (const n of names) {
        for (const p of String(n).split(/\\s+/).filter(Boolean)) classes.delete(p);
      }
      return el;
    },
    setText(t) { el.textContent = String(t); return el; },
    getText() { return el.textContent; },
    empty() { el.children.length = 0; el.textContent = ""; return el; },
    createEl(childTag, opts = {}) {
      const c = makeEl(childTag);
      if (opts.cls) c.addClass(opts.cls);
      if (opts.text !== undefined) c.setText(opts.text);
      el.children.push(c);
      return c;
    },
    createDiv(opts = {}) { return el.createEl("div", opts); },
    createSpan(opts = {}) { return el.createEl("span", opts); },
    addEventListener(ev, fn) {
      const list = listeners.get(ev) ?? [];
      list.push(fn);
      listeners.set(ev, list);
    },
    remove() {},
    setCssProps() {},
    isConnected: true,
  };
  return el;
}

export class Modal {
  constructor(app) { this.app = app; this.contentEl = makeEl(); this.titleEl = makeEl(); }
  setTitle() { return this; }
  open() {}
  close() {}
}

export class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = makeEl("div");
  }
  display() {}
  update() {}
}

export class Setting {
  constructor(containerEl) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.name = "";
    this.desc = "";
    containerEl._settings = containerEl._settings ?? [];
    containerEl._settings.push(this);
  }
  setName(name) { this.name = name; return this; }
  setDesc(desc) { this.desc = desc; return this; }
  setHeading() { return this; }
  setDisabled() { return this; }
  addText(cb) {
    const c = { placeholder: "", value: "", setPlaceholder(p) { this.placeholder = p; return this; }, setValue(v) { this.value = v; return this; }, onChange(fn) { this._onChange = fn; return this; } };
    cb(c);
    this.textComp = c;
    return this;
  }
  addToggle(cb) {
    const c = { setValue() { return this; }, onChange() { return this; } };
    cb(c);
    return this;
  }
  addDropdown(cb) {
    const c = { options: {}, addOption(k, l) { this.options[k] = l; return this; }, setValue() { return this; }, onChange() { return this; } };
    cb(c);
    return this;
  }
  addSlider(cb) {
    const c = { setLimits() { return this; }, setValue() { return this; }, onChange() { return this; } };
    cb(c);
    return this;
  }
  addComponent(cb) {
    cb(makeEl("div"));
    return this;
  }
}

export class SecretComponent {
  constructor(_app, _el) {
    this.value = "";
    this._onChange = null;
    secretComponentInstances.push(this);
  }
  setValue(v) { this.value = v; return this; }
  onChange(fn) { this._onChange = fn; return this; }
}

export class MarkdownView {}

export class Plugin {
  constructor(app = {}, manifest = {}) {
    this.app = app;
    this.manifest = manifest;
    this._commands = [];
    this._savedData = null;
  }
  async loadData() { return {}; }
  async saveData(d) { this._savedData = d; }
  addCommand(c) { this._commands.push(c); return c; }
  addRibbonIcon() {}
  addSettingTab(t) { this._settingTab = t; }
  addStatusBarItem() { return makeEl("div"); }
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

export function requireApiVersion() { return false; }
export function requestUrl() { throw new Error("unmocked requestUrl"); }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") {
      return {
        url: `data:text/javascript;charset=utf-8,${encodeURIComponent(MOCK_OBSIDIAN_SOURCE)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { MarkdownView, capturedNotices, secretComponentInstances } = await import("obsidian");
const { detectRuntimeCapabilities } = await import("../src/runtime-guard.ts");
const {
  DEFAULT_SETTINGS,
  createDefaultSettings,
  normalizeSettings,
  stripSecretsFromSettings,
  toSecretId,
} = await import("../src/settings.ts");
const { VoiceModeSettingTab } = await import("../src/settings-tab.ts");
const { default: VoiceModePlugin } = await import("../src/main.ts");

function makeWavFixture() {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
  ]);
}

describe("daemonTokenSecretId SecretStorage isolation and settings-tab annotations", () => {
  it("preserves valid daemonTokenSecretId while stripping raw Bearer, API, and 64-hex random tokens", () => {
    assert.equal(DEFAULT_SETTINGS.daemonTokenSecretId, "");
    const suggested = toSecretId("daemon", "local");
    assert.equal(suggested, "voice-mode-daemon-local");

    const valid = normalizeSettings({ daemonTokenSecretId: suggested });
    assert.equal(valid.daemonTokenSecretId, "voice-mode-daemon-local");

    const hex64 = "a1b2c3d4e5f60123456789abcdef0123456789abcdef0123456789abcdef0123";
    for (const rawSecret of [
      "sk-live-testsecret9876543210abcdef",
      "Bearer testtoken9876543210abcdef",
      hex64,
    ]) {
      const stripped = stripSecretsFromSettings({ daemonTokenSecretId: rawSecret });
      assert.equal(stripped.daemonTokenSecretId, "");
      assert.equal(normalizeSettings({ daemonTokenSecretId: rawSecret }).daemonTokenSecretId, "");
    }
  });

  it("exposes Daemon auth token, Kokoro speaker hint, and S0-4 Provider preset CORS compatibility annotations", async () => {
    const secrets = new Map();
    const app = {
      secretStorage: {
        getSecret: (id) => secrets.get(id) ?? null,
        setSecret: (id, v) => secrets.set(id, v),
        listSecrets: () => Array.from(secrets.keys()),
      },
    };
    const host = {
      settings: createDefaultSettings(),
      capabilities: detectRuntimeCapabilities(false, "macos"),
      saveSettings: async () => {},
    };

    const tab = new VoiceModeSettingTab(app, host);

    // Initially neither asrEngine=daemon nor ttsEngine=kokoro-daemon -> Daemon auth token hidden
    const initialDefs = tab.getSettingDefinitions();
    const modelsGroup = initialDefs.find((g) => g.heading === "Models and privacy");
    const daemonTokenDef = modelsGroup.items.find((i) => i.name === "Daemon auth token");
    assert.ok(daemonTokenDef, "Daemon auth token definition must exist");
    assert.equal(daemonTokenDef.visible(), false);

    // S0-4 Provider preset CORS compatibility annotation check
    const aiGroup = initialDefs.find((g) => g.heading === "AI model");
    const providerDef = aiGroup.items.find((i) => i.name === "Provider preset");
    assert.ok(providerDef);
    for (const expected of [
      "DeepSeek",
      "Qwen",
      "Kimi",
      "SiliconFlow",
      "OpenRouter",
      "Anthropic",
      "Volcengine",
      "OpenAI",
      "Ollama",
    ]) {
      assert.ok(
        providerDef.desc.includes(expected),
        `Provider preset desc missing ${expected}: ${providerDef.desc}`,
      );
    }

    // Switch ttsEngine to kokoro-daemon -> Daemon auth token visible + Kokoro speaker hint rendered
    host.settings.ttsEngine = "kokoro-daemon";
    assert.equal(daemonTokenDef.visible(), true);
    assert.ok(daemonTokenDef.desc.includes("voice-mode-daemon-local"));

    const kokoroDefs = tab.getSettingDefinitions();
    const readAloudGroup = kokoroDefs.find((g) => g.heading === "Read aloud");
    const voiceDef = readAloudGroup.items.find((i) => i.name === "Preferred voice name");
    assert.ok(voiceDef.desc.includes("zf_001"));
    assert.ok(voiceDef.desc.includes("zf_xiaobei"));
    assert.ok(voiceDef.desc.includes("zm_010"));
    assert.ok(voiceDef.desc.includes("af_maple"));
    assert.ok(voiceDef.desc.includes("0..102"));

    // Verify display() also binds SecretComponent cleanly
    secretComponentInstances.length = 0;
    tab.display();
    const renderedSettings = tab.containerEl._settings ?? [];
    const renderedDaemonToken = renderedSettings.find((s) => s.name === "Daemon auth token");
    assert.ok(renderedDaemonToken);
    const lastSecretComp = secretComponentInstances[secretComponentInstances.length - 1];
    await lastSecretComp._onChange("voice-mode-daemon-local");
    assert.equal(host.settings.daemonTokenSecretId, "voice-mode-daemon-local");
  });
});

describe("VoiceModePlugin kokoro-daemon TTS and daemon ASR integration with < 1s offline fallback", () => {
  function setupWindowEnv() {
    const nodeRequire = createRequire(import.meta.url);
    const spokenSystemSentences = [];
    const playedBinaryUrls = [];

    class MockUtterance {
      constructor(text) {
        this.text = text;
        this.rate = 1;
        this.lang = "zh-CN";
        this.onend = null;
        this.onerror = null;
      }
    }

    class MockAudio {
      constructor(url) {
        this.src = url;
        this.currentTime = 0;
        this.onended = null;
        this.onerror = null;
      }
      play() {
        playedBinaryUrls.push(this.src);
        queueMicrotask(() => this.onended?.());
        return Promise.resolve();
      }
      pause() {}
    }

    const mockWin = Object.assign(Object.create(globalThis), {
      require: nodeRequire,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      SpeechSynthesisUtterance: MockUtterance,
      Audio: MockAudio,
      URL: {
        createObjectURL: () => "blob:mock-audio",
        revokeObjectURL: () => {},
      },
      speechSynthesis: {
        paused: false,
        getVoices: () => [],
        resume: () => {},
        cancel: () => {},
        speak: (u) => {
          spokenSystemSentences.push(u.text);
          queueMicrotask(() => u.onend?.());
        },
      },
    });

    globalThis.window = mockWin;
    globalThis.activeWindow = mockWin;
    globalThis.activeDocument = { activeElement: null, body: null };

    return { spokenSystemSentences, playedBinaryUrls };
  }

  it("resumes interrupted whole-note speech, preserves the bookmark during selections and clears it after completion", async () => {
    setupWindowEnv();
    let selected = "";
    let utterance;
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    window.speechSynthesis.speak = (current) => { utterance = current; };
    const view = {
      file: { path: "A.md" },
      editor: { getValue: () => "甲。甲。丙。", getSelection: () => selected },
    };
    const events = {};
    const plugin = new VoiceModePlugin({
      workspace: {
        getActiveViewOfType: () => view,
        on: (event, callback) => { events[event] = callback; },
      },
      vault: { adapter: {} },
    }, { id: "voice-mode" });
    try {
      await plugin.onload();
      plugin.settings.enableSubtitleOverlay = false;
      const run = (id) => plugin._commands.find((command) => command.id === id).callback();
      const bookmark = (index) => ({ path: "A.md", sentenceIndex: index });
      run("read-aloud");
      await turn();
      assert.equal(utterance.text, "甲。");
      run("stop-read-aloud");
      await turn();
      assert.deepEqual(plugin._savedData.readAloudResume, bookmark(0));

      selected = "选区。";
      run("read-aloud");
      await turn();
      assert.equal(utterance.text, selected);
      utterance.onend();
      await turn();
      assert.deepEqual(plugin.settings.readAloudResume, bookmark(0));

      run("resume-read-aloud");
      // Skip the first sentence while synthesis is pending, before the first start event.
      run("skip-read-aloud-sentence");
      await turn();
      assert.equal(utterance.text, "甲。");
      assert.deepEqual(plugin.settings.readAloudResume, bookmark(1));
      utterance.onerror({ error: "interrupted" });
      await turn();
      assert.deepEqual(plugin._savedData.readAloudResume, bookmark(1));

      run("resume-read-aloud");
      await turn();
      assert.equal(utterance.text, "甲。");
      utterance.onend();
      await turn();
      assert.equal(utterance.text, "丙。");
      events["file-open"]({ path: "B.md" });
      await turn();
      assert.deepEqual(plugin._savedData.readAloudResume, bookmark(2));
      run("resume-read-aloud");
      await turn();
      assert.equal(utterance.text, "丙。");
      utterance.onend();
      await turn();
      assert.equal(plugin._savedData.readAloudResume, null);

      run("resume-read-aloud");
      await turn();
      run("skip-read-aloud-sentence");
      run("stop-read-aloud");
      await turn();
      assert.deepEqual(plugin._savedData.readAloudResume, bookmark(1));
      run("resume-read-aloud");
      await turn();
      run("skip-read-aloud-sentence");
      await turn();
      assert.equal(utterance.text, "丙。");
      run("skip-read-aloud-sentence");
      await turn();
      assert.equal(plugin._savedData.readAloudResume, null);
    } finally {
      plugin.onunload();
      delete globalThis.window;
      delete globalThis.activeWindow;
      delete globalThis.activeDocument;
    }
  });

  it("pauses and resumes read-aloud from the command palette and clears all read-aloud state on stop", async () => {
    setupWindowEnv();
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    let utterance;
    window.speechSynthesis.speak = (current) => { utterance = current; };
    const view = {
      file: { path: "A.md" },
      editor: { getValue: () => "甲。乙。", getSelection: () => "" },
    };
    const plugin = new VoiceModePlugin({
      workspace: { getActiveViewOfType: () => view, on: () => ({}) },
      vault: { adapter: {} },
    }, { id: "voice-mode" });
    try {
      await plugin.onload();
      plugin.settings.enableSubtitleOverlay = false;
      const run = (id) => plugin._commands.find((command) => command.id === id).callback();

      // Pause/skip without active playback must explain instead of silently doing nothing.
      capturedNotices.length = 0;
      run("pause-resume-read-aloud");
      run("skip-read-aloud-sentence");
      assert.deepEqual(capturedNotices, [
        "Read-aloud is not currently active.",
        "Read-aloud is not currently active.",
      ]);

      run("read-aloud");
      await turn();
      assert.equal(utterance.text, "甲。");
      assert.equal(plugin.currentStatus, "speaking");
      assert.equal(plugin.statusLabelEl.textContent, "Reading aloud");

      // Pause from the command palette: playback suspends and the status bar tells the user why.
      run("pause-resume-read-aloud");
      await turn();
      assert.equal(plugin.speechPlayer.state, "paused");
      assert.equal(plugin.currentStatus, "speaking");
      assert.equal(plugin.statusLabelEl.textContent, "Read-aloud paused");

      // Pressing the same command resumes and the label returns to the reading state.
      run("pause-resume-read-aloud");
      await turn();
      assert.equal(plugin.speechPlayer.state, "playing");
      assert.equal(plugin.statusLabelEl.textContent, "Reading aloud");

      // Stopping while paused must still tear down playback, the bookmark context and the status;
      // a second stop is a harmless no-op with actionable guidance instead of silence.
      run("pause-resume-read-aloud");
      await turn();
      assert.equal(plugin.speechPlayer.state, "paused");
      capturedNotices.length = 0;
      run("stop-read-aloud");
      await turn();
      assert.equal(plugin.speechPlayer.isActive, false);
      assert.equal(plugin.currentStatus, "idle");
      assert.equal(plugin.statusLabelEl.textContent, "Voice idle");
      assert.ok(capturedNotices.includes("Read-aloud stopped."));
      assert.deepEqual(plugin.settings.readAloudResume, { path: "A.md", sentenceIndex: 0 });

      capturedNotices.length = 0;
      run("stop-read-aloud");
      assert.deepEqual(capturedNotices, ["Read-aloud is not currently playing."]);
    } finally {
      plugin.onunload();
      delete globalThis.window;
      delete globalThis.activeWindow;
      delete globalThis.activeDocument;
    }
  });

  it("honors stop and note-switch settings during a pending VITS readiness check", async () => {
    setupWindowEnv();
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    const events = {};
    const view = {
      file: { path: "A.md" },
      editor: { getValue: () => "甲。", getSelection: () => "" },
    };
    const plugin = new VoiceModePlugin({
      workspace: {
        getActiveViewOfType: () => view,
        on: (event, callback) => { events[event] = callback; },
      },
      vault: { adapter: {} },
    }, { id: "voice-mode" });
    try {
      await plugin.onload();
      plugin.settings.ttsEngine = "vits-wasm";
      plugin.settings.enableSubtitleOverlay = false;
      const queued = [];
      plugin.speechPlayer.speakSentences = (sentences) => queued.push(...sentences);
      const run = (id) => plugin._commands.find((command) => command.id === id).callback();
      for (const action of ["stop", "file-open", "active-leaf-change", "keep-reading"]) {
        const gate = Promise.withResolvers();
        plugin.ensureDesktopModelManager = () => ({ checkStatus: () => gate.promise });
        view.file.path = "A.md";
        run("read-aloud");
        if (action === "stop") {
          run("stop-read-aloud");
        } else {
          plugin.settings.stopReadAloudOnNoteSwitch = action !== "keep-reading";
          view.file.path = "B.md";
          events[action === "keep-reading" ? "file-open" : action]({ path: "B.md" });
        }
        gate.resolve({ vitsReady: true });
        await turn();
        assert.deepEqual(queued, action === "keep-reading" ? ["甲。"] : [], action);
        assert.deepEqual(plugin.settings.readAloudResume, action === "keep-reading"
          ? { path: "A.md", sentenceIndex: 0 } : null, action);
      }
    } finally {
      plugin.onunload();
      delete globalThis.window;
      delete globalThis.activeWindow;
      delete globalThis.activeDocument;
    }
  });

  it("serializes a delayed settings save with a new note bookmark and flushes it on unload", async () => {
    setupWindowEnv();
    const turn = () => new Promise((resolve) => setImmediate(resolve));
    window.speechSynthesis.speak = () => {};
    const view = {
      file: { path: "A.md" },
      editor: { getValue: () => "甲。乙。", getSelection: () => "" },
    };
    const plugin = new VoiceModePlugin({
      workspace: { getActiveViewOfType: () => view, on: () => ({}) },
      vault: { adapter: {} },
    }, { id: "voice-mode" });
    let unloaded = false;
    try {
      await plugin.onload();
      plugin.settings.enableSubtitleOverlay = false;
      const run = (id) => plugin._commands.find((command) => command.id === id).callback();
      const saved = [];
      const gate = Promise.withResolvers();
      plugin.saveData = async (data) => {
        if (!saved.length) await gate.promise;
        saved.push(data.readAloudResume?.path);
      };
      run("read-aloud");
      const settingsSaved = plugin.saveSettings();
      await turn();
      view.file.path = "B.md";
      run("read-aloud");
      await turn();
      plugin.onunload();
      unloaded = true;
      assert.deepEqual(saved, []);
      gate.resolve();
      await settingsSaved;
      await turn();
      assert.equal(saved[0], "A.md");
      assert.equal(saved.at(-1), "B.md");
    } finally {
      if (!unloaded) plugin.onunload();
      delete globalThis.window;
      delete globalThis.activeWindow;
      delete globalThis.activeDocument;
    }
  });

  it("synthesizes kokoro-daemon WAV with SecretStorage token and falls back in < 1s to vits-wasm or system TTS", async () => {
    const env = setupWindowEnv();
    try {
      const secrets = new Map([["voice-mode-daemon-local", "test-daemon-secret-tok"]]);
      const mockEditor = {
        getSelection: () => "守护进程朗读测试。",
        getValue: () => "守护进程朗读测试。",
        replaceSelection: () => {},
      };
      const mockView = Object.assign(new MarkdownView(), {
        editor: mockEditor,
        file: { basename: "Note", path: "Note.md" },
        containerEl: { contains: () => false },
      });

      const app = {
        secretStorage: {
          getSecret: (id) => secrets.get(id) ?? null,
          setSecret: (id, v) => secrets.set(id, v),
          listSecrets: () => Array.from(secrets.keys()),
        },
        workspace: {
          on: () => ({}),
          getActiveViewOfType: () => mockView,
          getLeavesOfType: () => [{ view: mockView }],
        },
        vault: { adapter: {} },
      };

      const plugin = new VoiceModePlugin(app, { id: "voice-mode", version: "0.1.0" });
      await plugin.onload();
      plugin.settings.ttsEngine = "kokoro-daemon";
      plugin.settings.ttsVoice = "zm_010";
      plugin.settings.daemonTokenSecretId = "voice-mode-daemon-local";

      // 1. Online https:// loopback daemon synthesis via native browser fetch (NOT corsFetch!) with SecretStorage token
      plugin.settings.daemonUrl = "https://127.0.0.1:18790";
      let corsFetchCalled = 0;
      plugin.corsFetch = async () => {
        corsFetchCalled += 1;
        throw new Error("DaemonClient must use native browser fetch, not corsFetch");
      };
      let seenSpeechAuth = "";
      let seenSpeechVoice;
      let daemonMode = "online"; // "online" | "unauth"
      globalThis.activeWindow.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith("/v1/health")) {
          if (daemonMode !== "online") {
            return new Response("unauthorized", { status: 401 });
          }
          return new Response(
            JSON.stringify({ ok: true, service: "voice-daemon", version: "0.1.0" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        assert.equal(u, "https://127.0.0.1:18790/v1/audio/speech");
        seenSpeechAuth = init?.headers?.Authorization ?? "";
        seenSpeechVoice = JSON.parse(init.body).voice;
        if (daemonMode === "online") {
          return new Response(makeWavFixture(), {
            status: 200,
            headers: { "Content-Type": "audio/wav" },
          });
        }
        return new Response("unauthorized", { status: 401 });
      };
      await plugin.saveSettings();

      const readCmd = plugin._commands.find((c) => c.id === "read-aloud");
      await readCmd.callback();
      await plugin.speechPlayer.waitUntilDrained();
      assert.equal(corsFetchCalled, 0);
      assert.equal(seenSpeechAuth, "Bearer test-daemon-secret-tok");
      assert.equal(env.playedBinaryUrls.length, 1);

      mockEditor.getSelection = () => "This sentence is in English.";
      plugin.settings.ttsVoice = "zf_xiaobei";
      plugin.settings.autoLanguageVoice = false;
      await plugin.saveSettings();
      await readCmd.callback();
      await plugin.speechPlayer.waitUntilDrained();
      assert.equal(seenSpeechVoice, "zf_xiaobei");
      plugin.settings.autoLanguageVoice = true;
      await plugin.saveSettings();
      await readCmd.callback();
      await plugin.speechPlayer.waitUntilDrained();
      assert.equal(seenSpeechVoice, "af_maple");
      mockEditor.getSelection = () => "守护进程朗读测试。";

      // 2. Offline/401 fallback in < 1s to VITS WASM when vitsReady === true
      daemonMode = "unauth";
      let vitsInstalled = true;
      plugin.getModelStatus = async () => ({
        cacheDir: "/tmp/models",
        ready: true,
        vadReady: true,
        senseVoiceReady: true,
        wasmReady: true,
        vitsReady: vitsInstalled,
        vitsVerifiedBytes: 100,
        verifiedFiles: [],
        missingOrCorruptFiles: [],
        totalVerifiedBytes: 100,
        elapsedMs: 1,
      });
      plugin.vitsTtsEngine = {
        kind: "vits-wasm",
        mime: "audio/wav",
        updateVoice() {},
        synthesize: async () => ({ audio: makeWavFixture(), mime: "audio/wav" }),
        close: async () => {},
      };
      capturedNotices.length = 0;
      const tVits = Date.now();
      await readCmd.callback();
      await plugin.speechPlayer.waitUntilDrained();
      assert.ok(Date.now() - tVits < 900);
      assert.ok(
        capturedNotices.some((m) =>
          m.includes("Local voice daemon is offline or unauthorized; falling back to VITS WASM"),
        ),
      );
      assert.equal(env.playedBinaryUrls.length, 4);

      // 3. Offline/401 fallback in < 1s to system TTS when VITS is not installed (reset cooldown via saveSettings)
      vitsInstalled = false;
      await plugin.saveSettings();
      capturedNotices.length = 0;
      const tSys = Date.now();
      await readCmd.callback();
      await plugin.speechPlayer.waitUntilDrained();
      assert.ok(Date.now() - tSys < 900);
      assert.ok(
        capturedNotices.some((m) =>
          m.includes(
            "Local voice daemon is offline or unauthorized; falling back to system speech synthesis",
          ),
        ),
      );
      assert.deepEqual(env.spokenSystemSentences, ["守护进程朗读测试。"]);

      plugin.onunload();
    } finally {
      delete globalThis.window;
      delete globalThis.activeWindow;
      delete globalThis.activeDocument;
    }
  });

  it("drives daemon ASR via probeHealth + CloudDictationSession and falls back in < 1s when offline", async () => {
    setupWindowEnv();
    try {
      const secrets = new Map([["voice-mode-daemon-local", "test-daemon-asr-tok"]]);
      const inserted = [];
      const mockEditor = {
        getSelection: () => "",
        getValue: () => "",
        replaceSelection: (t) => inserted.push(t),
      };
      const mockView = Object.assign(new MarkdownView(), {
        editor: mockEditor,
        file: { basename: "Dictate", path: "Dictate.md" },
        containerEl: { contains: () => false },
      });

      const app = {
        secretStorage: {
          getSecret: (id) => secrets.get(id) ?? null,
          setSecret: (id, v) => secrets.set(id, v),
          listSecrets: () => Array.from(secrets.keys()),
        },
        workspace: {
          on: () => ({}),
          getActiveViewOfType: () => mockView,
          getLeavesOfType: () => [{ view: mockView }],
        },
        vault: { adapter: {} },
      };

      const plugin = new VoiceModePlugin(app, { id: "voice-mode", version: "0.1.0" });
      await plugin.onload();
      plugin.settings.asrEngine = "daemon";
      plugin.settings.dictationMode = "single";
      plugin.settings.endpointSilenceMs = 400;
      plugin.settings.daemonTokenSecretId = "voice-mode-daemon-local";

      let daemonHealthy = true;
      let transcribeShouldFailMidSession = false;
      let pushChunk = null;
      globalThis.activeWindow.fetch = async (url, init) => {
        const u = String(url);
        if (u.endsWith("/v1/health")) {
          if (!daemonHealthy) {
            return new Response("offline", { status: 503 });
          }
          assert.equal(init?.headers?.Authorization, "Bearer test-daemon-asr-tok");
          return new Response(
            JSON.stringify({
              ok: true,
              service: "voice-daemon",
              version: "0.1.0",
              capabilities: ["asr"],
              voices: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (u.endsWith("/v1/audio/transcriptions")) {
          if (transcribeShouldFailMidSession) {
            return new Response("daemon crashed mid-session", { status: 502 });
          }
          assert.equal(init?.headers?.Authorization, "Bearer test-daemon-asr-tok");
          return new Response(JSON.stringify({ text: "守护进程口述上屏" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected daemon URL ${u}`);
      };
      plugin.corsFetch = async (url) => {
        if (String(url).endsWith("/audio/transcriptions")) {
          return new Response(JSON.stringify({ text: "会话中途云端回退上屏" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected cloud URL ${String(url)}`);
      };
      await plugin.saveSettings();

      const daemonSession = plugin.ensureDaemonDictationSession();
      daemonSession.captureAudio = async ({ onChunk }) => {
        pushChunk = onChunk;
        return { nativeAecActive: true, stop: async () => {} };
      };

      // 1. Online daemon dictation end-to-end
      await plugin.toggleDictation("single");
      const speech = new Float32Array(1600).fill(0.2);
      const silence = new Float32Array(4000);
      pushChunk(speech);
      pushChunk(speech);
      pushChunk(speech);
      pushChunk(silence);
      pushChunk(silence);
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(inserted, ["守护进程口述上屏"]);

      // 1b. Mid-session daemon crash after healthy probe falls back seamlessly to fallbackAsr without losing utterance!
      plugin.getModelStatus = async () => null;
      secrets.set("voice-mode-asr-openai-compat", "sk-test-asr-placeholder12345678");
      plugin.settings.asrApiKeySecretId = "voice-mode-asr-openai-compat";
      transcribeShouldFailMidSession = true;
      await plugin.toggleDictation("single");
      pushChunk(speech);
      pushChunk(speech);
      pushChunk(speech);
      pushChunk(silence);
      pushChunk(silence);
      await new Promise((r) => setTimeout(r, 40));
      assert.deepEqual(inserted, ["守护进程口述上屏", "会话中途云端回退上屏"]);
      transcribeShouldFailMidSession = false;

      // 2. Offline daemon falls back in < 1s to SenseVoice WASM when cached
      daemonHealthy = false;
      let senseVoiceStarted = 0;
      plugin.getModelStatus = async () => ({
        cacheDir: "/tmp/models",
        ready: true,
        vadReady: true,
        senseVoiceReady: true,
        wasmReady: true,
        vitsReady: false,
        vitsVerifiedBytes: 0,
        verifiedFiles: [],
        missingOrCorruptFiles: [],
        totalVerifiedBytes: 100,
        elapsedMs: 1,
      });
      plugin.startOfflineSenseVoiceDictation = async () => {
        senseVoiceStarted += 1;
      };
      capturedNotices.length = 0;
      const t0 = Date.now();
      await plugin.toggleDictation("single");
      assert.ok(Date.now() - t0 < 900);
      assert.equal(senseVoiceStarted, 1);
      assert.ok(
        capturedNotices.some((m) =>
          m.includes("Local voice daemon is offline or unauthorized; falling back to SenseVoice WASM"),
        ),
      );

      // 3. Offline daemon falls back in < 1s to OpenAI-compatible ASR when models are not cached but BYOK ASR is ready
      plugin.getModelStatus = async () => null;
      secrets.set("voice-mode-asr-openai-compat", "sk-test-asr-placeholder12345678");
      plugin.settings.asrApiKeySecretId = "voice-mode-asr-openai-compat";
      let cloudOpenAiStarted = 0;
      plugin.startCloudOpenAiDictation = async () => {
        cloudOpenAiStarted += 1;
      };
      capturedNotices.length = 0;
      const t1 = Date.now();
      await plugin.toggleDictation("single");
      assert.ok(Date.now() - t1 < 900);
      assert.equal(cloudOpenAiStarted, 1);
      assert.ok(
        capturedNotices.some((m) =>
          m.includes("Local voice daemon is offline or unauthorized; falling back to OpenAI-compatible"),
        ),
      );

      // 4. Offline daemon with neither cached WASM nor BYOK ASR shows actionable Notice in < 1s without hanging
      plugin.settings.asrApiKeySecretId = "";
      capturedNotices.length = 0;
      await plugin.toggleDictation("single");
      assert.equal(plugin.startingDictation, false);
      assert.ok(
        capturedNotices.some((m) => m.includes("Local voice daemon is offline or unauthorized")),
      );

      plugin.onunload();
    } finally {
      delete globalThis.window;
      delete globalThis.activeWindow;
      delete globalThis.activeDocument;
    }
  });
});
