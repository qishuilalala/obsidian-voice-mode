import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractReadableText,
  insertDictatedText,
  insertIntoFocusedInput,
  isMarkdownEditorFocused,
  resolveDeepActiveElement,
} from "../src/editor-bridge.ts";
import {
  DEFAULT_LOCAL_DAEMON_URL,
  EXTERNAL_MODEL_CACHE_PATHS,
  describeExternalModelCacheDir,
  detectRuntimeCapabilities,
  resolveEffectiveAsrEngine,
  resolveEffectiveTtsEngine,
} from "../src/runtime-guard.ts";
import {
  DEFAULT_SETTINGS,
  ObsidianSecretStore,
  SECRET_ID_RE,
  createDefaultSettings,
  getLlmSecretId,
  getTtsSecretId,
  hasSecretStorage,
  isValidSecretId,
  normalizeSettings,
  setLlmSecretId,
  setTtsSecretId,
  stripSecretsFromSettings,
  toSecretId,
} from "../src/settings.ts";
import { SpeechPlayer } from "../src/speech-player.ts";

describe("toSecretId, per-preset isolation, and ObsidianSecretStore", () => {
  it("generates strictly lowercase alphanumeric + hyphen IDs matching obsidian.d.ts", () => {
    const id1 = toSecretId("llm", "deepseek");
    assert.equal(id1, "voice-mode-llm-deepseek");
    assert.match(id1, SECRET_ID_RE);
    assert.equal(isValidSecretId(id1), true);

    const id2 = toSecretId("TTS_Provider", "OpenAI Compat / v1!");
    assert.equal(id2, "voice-mode-tts-provider-openai-compat-v1");
    assert.match(id2, SECRET_ID_RE);

    const id3 = toSecretId("voice-mode-asr", "dashscope_qwen");
    assert.equal(id3, "voice-mode-asr-dashscope-qwen");
    assert.match(id3, SECRET_ID_RE);
  });

  it("rejects empty or symbol-only segments", () => {
    assert.throws(() => toSecretId("!!!", "deepseek"));
    assert.throws(() => toSecretId("llm", "   "));
    assert.equal(isValidSecretId("UpperCase"), false);
    assert.equal(isValidSecretId("with_underscore"), false);
    assert.equal(isValidSecretId("has space"), false);
    assert.equal(isValidSecretId(""), false);
  });

  it("isolates LLM and TTS secret IDs per preset and engine without cross-contamination", () => {
    const settings = createDefaultSettings();
    setLlmSecretId(settings, "deepseek", "voice-mode-llm-deepseek");
    setLlmSecretId(settings, "openai", "voice-mode-llm-openai");
    setTtsSecretId(settings, "openai-compat", "voice-mode-tts-openai-compat");
    setTtsSecretId(settings, "mimo", "voice-mode-tts-mimo");

    assert.equal(getLlmSecretId(settings, "deepseek"), "voice-mode-llm-deepseek");
    assert.equal(getLlmSecretId(settings, "openai"), "voice-mode-llm-openai");
    assert.equal(getLlmSecretId(settings, "anthropic"), "");

    assert.equal(getTtsSecretId(settings, "openai-compat"), "voice-mode-tts-openai-compat");
    assert.equal(getTtsSecretId(settings, "mimo"), "voice-mode-tts-mimo");
    assert.equal(getTtsSecretId(settings, "system"), "");

    setLlmSecretId(settings, "deepseek", "");
    assert.equal(getLlmSecretId(settings, "deepseek"), "");
    assert.equal(getLlmSecretId(settings, "openai"), "voice-mode-llm-openai");
  });

  it("normalizes empty strings to null and guards missing secretStorage on older Obsidian hosts", () => {
    const backing = new Map();
    const store = new ObsidianSecretStore({
      getSecret: (id) => backing.get(id) ?? null,
      setSecret: (id, secret) => {
        backing.set(id, secret);
      },
      listSecrets: () => Array.from(backing.keys()),
    });

    assert.equal(store.available, true);
    const validId = toSecretId("llm", "openai");
    store.setSecret(validId, "test-placeholder-value");
    assert.equal(store.getSecret(validId), "test-placeholder-value");
    assert.deepEqual(store.listSecrets(), [validId]);

    assert.throws(() => store.setSecret("Invalid_ID", "value"));
    assert.equal(store.getSecret("Invalid_ID"), null);

    // Deleting writes "" to Obsidian SecretStorage; getSecret must normalize "" to null.
    store.deleteSecret(validId);
    assert.equal(backing.get(validId), "");
    assert.equal(store.getSecret(validId), null);

    // Missing app.secretStorage guard (e.g. Obsidian < 1.11.4).
    assert.equal(hasSecretStorage({}), false);
    assert.equal(hasSecretStorage({ secretStorage: null }), false);
    const missingStore = new ObsidianSecretStore(undefined);
    assert.equal(missingStore.available, false);
    assert.equal(missingStore.getSecret(validId), null);
    assert.deepEqual(missingStore.listSecrets(), []);
    assert.throws(() => missingStore.setSecret(validId, "test-value"), /1\.11\.4/);
  });
});

describe("stripSecretsFromSettings and normalizeSettings security gates", () => {
  it("strips forbidden keys, legacy flat secret IDs, URL credentials, and array secrets", () => {
    const fakeSkKey = ["sk", "proj", "mock1234567890abcdef"].join("-");
    const fakeGskKey = ["gsk", "mock1234567890abcdef"].join("_");
    const fakeHex32 = "0123456789abcdef0123456789abcdef";

    const raw = {
      asrEngine: "system",
      llmPresetId: "deepseek",
      llmApiKeySecretId: "voice-mode-llm-deepseek", // legacy flat field must be dropped
      ttsApiKeySecretId: "voice-mode-tts-mimo", // legacy flat field must be dropped
      llmApiKeySecretIds: {
        deepseek: "voice-mode-llm-deepseek",
        openai: fakeSkKey, // raw key inside map must be stripped
        notAPreset: "voice-mode-llm-unknown", // unknown key must be stripped
      },
      ttsApiKeySecretIds: {
        "openai-compat": "voice-mode-tts-openai-compat",
        bogus: "voice-mode-tts-bogus",
      },
      apiKey: "plain-secret-key",
      llmApiKey: "plain-llm-key",
      tts_api_key: "plain-tts-key",
      accessToken: "plain-token",
      authorization: "Bearer mocktoken1234567890",
      basicHeader: "Basic dXNlcjpwYXNzMTIzNDU=",
      embeddedCredUrl: "https://alice:mockpass@example.com/v1",
      tags: ["safe-tag", fakeGskKey, fakeHex32, "https://bob:mockpw@host.test/api"],
      nested: {
        secret: "nested-secret",
        safeFlag: true,
      },
    };

    const clean = stripSecretsFromSettings(raw);
    assert.equal("llmApiKeySecretId" in clean, false);
    assert.equal("ttsApiKeySecretId" in clean, false);
    assert.deepEqual(clean.llmApiKeySecretIds, { deepseek: "voice-mode-llm-deepseek" });
    assert.deepEqual(clean.ttsApiKeySecretIds, {
      "openai-compat": "voice-mode-tts-openai-compat",
    });
    assert.equal("apiKey" in clean, false);
    assert.equal("llmApiKey" in clean, false);
    assert.equal("tts_api_key" in clean, false);
    assert.equal("accessToken" in clean, false);
    assert.equal("authorization" in clean, false);
    assert.equal("basicHeader" in clean, false);
    assert.equal("embeddedCredUrl" in clean, false);
    assert.deepEqual(clean.tags, ["safe-tag"]);
    assert.deepEqual(clean.nested, { safeFlag: true });
  });

  it("rejects non-loopback daemonUrl (including public HTTPS) and invalid endpoint URLs", () => {
    const fromPublicHttps = normalizeSettings({
      daemonUrl: "https://remote.example.com:18790",
      asrEndpointUrl: "http://remote.example.com/v1",
      ttsEndpointUrl: "ftp://example.com/tts",
      llmBaseUrl: "http://192.168.1.50:8080/v1",
    });
    assert.equal(fromPublicHttps.daemonUrl, "");
    assert.equal(fromPublicHttps.asrEndpointUrl, "");
    assert.equal(fromPublicHttps.ttsEndpointUrl, "");
    assert.equal(fromPublicHttps.llmBaseUrl, "");

    const fromValidLoopback = normalizeSettings({
      daemonUrl: "http://127.0.0.1:18790",
      asrEndpointUrl: "https://api.openai.com/v1",
      llmBaseUrl: "http://localhost:11434/v1",
    });
    assert.equal(fromValidLoopback.daemonUrl, "http://127.0.0.1:18790");
    assert.equal(fromValidLoopback.asrEndpointUrl, "https://api.openai.com/v1");
    assert.equal(fromValidLoopback.llmBaseUrl, "http://localhost:11434/v1");

    const defaults = normalizeSettings({});
    assert.equal(defaults.daemonUrl, DEFAULT_LOCAL_DAEMON_URL);
    assert.equal(defaults.ttsVoice, DEFAULT_SETTINGS.ttsVoice);
  });
});

describe("detectRuntimeCapabilities desktop vs mobile guardrails", () => {
  it("hard-disables 200MB+ local WASM models and local daemon on mobile", () => {
    const mobile = detectRuntimeCapabilities(true);
    assert.equal(mobile.hostClass, "mobile");
    assert.equal(mobile.isMobile, true);
    assert.equal(mobile.allowLocalWasmModels, false);
    assert.equal(mobile.allowLocalDaemon, false);
    assert.equal(mobile.maxConcurrentLocalModels, 0);
    assert.equal(mobile.maxLocalModelMemoryMb, 0);
    assert.equal(mobile.defaultAsrEngine, "system");
    assert.equal(mobile.defaultTtsEngine, "system");
    assert.equal(mobile.allowedAsrEngines.includes("sensevoice-wasm"), false);
    assert.equal(mobile.allowedTtsEngines.includes("vits-wasm"), false);
    assert.equal(mobile.allowedAsrEngines.includes("daemon"), false);
    assert.ok(mobile.restrictionReason && mobile.restrictionReason.includes("500 MB"));

    assert.equal(resolveEffectiveAsrEngine("sensevoice-wasm", mobile), "system");
    assert.equal(resolveEffectiveAsrEngine("daemon", mobile), "system");
    assert.equal(resolveEffectiveTtsEngine("vits-wasm", mobile), "system");
    assert.equal(resolveEffectiveTtsEngine("kokoro-daemon", mobile), "system");
    assert.equal(resolveEffectiveTtsEngine("openai-compat", mobile), "openai-compat");
  });

  it("enables on-demand single-model WASM (700 MB budget) and loopback daemon on desktop", () => {
    const desktop = detectRuntimeCapabilities(false, "macos");
    assert.equal(desktop.hostClass, "desktop");
    assert.equal(desktop.isMobile, false);
    assert.equal(desktop.allowLocalWasmModels, true);
    assert.equal(desktop.allowLocalDaemon, true);
    assert.equal(desktop.maxConcurrentLocalModels, 1);
    assert.equal(desktop.maxLocalModelMemoryMb, 700);
    assert.equal(desktop.recommendedLocalAsr, "sensevoice-wasm");
    assert.equal(desktop.recommendedLocalTts, "vits-wasm");
    assert.equal(desktop.defaultDaemonUrl, DEFAULT_LOCAL_DAEMON_URL);
    assert.equal(desktop.externalModelCacheDir, EXTERNAL_MODEL_CACHE_PATHS.macos);
    assert.equal(desktop.restrictionReason, null);

    assert.equal(resolveEffectiveAsrEngine("sensevoice-wasm", desktop), "sensevoice-wasm");
    assert.equal(resolveEffectiveTtsEngine("vits-wasm", desktop), "vits-wasm");

    assert.equal(describeExternalModelCacheDir("windows"), EXTERNAL_MODEL_CACHE_PATHS.windows);
    assert.equal(describeExternalModelCacheDir("linux"), EXTERNAL_MODEL_CACHE_PATHS.linux);
    assert.equal(desktop.externalModelCacheDir.includes(".obsidian"), false);
  });
});

describe("editor-bridge focus routing, Shadow DOM / input insertion, and frontmatter stripping", () => {
  it("strips leading YAML frontmatter for both full notes and select-all selections", () => {
    const noteBody = [
      "---",
      "title: Sample",
      "tags: [voice]",
      "---",
      "# Heading",
      "Hello [[World|Obsidian]].",
      "",
      "| Col A | Col B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Second sentence!",
    ].join("\n");

    const fullEditor = {
      getSelection: () => "",
      getValue: () => noteBody,
      replaceSelection: () => {},
    };
    const sentences = extractReadableText(fullEditor, { tablePolicy: "skip" });
    assert.ok(sentences.some((s) => s.includes("Hello Obsidian.")));
    assert.ok(sentences.some((s) => s.includes("Second sentence!")));
    assert.equal(
      sentences.some((s) => s.includes("title: Sample") || s.includes("Col A")),
      false,
    );

    // Select-all selection containing frontmatter must also strip frontmatter.
    const selectAllEditor = {
      getSelection: () => "---\nauthor: test\n---\nSelected body line.",
      getValue: () => noteBody,
      replaceSelection: () => {},
    };
    assert.deepEqual(extractReadableText(selectAllEditor), ["Selected body line."]);
  });

  it("prioritizes CM6 MarkdownView editor over generic contenteditable fallback", () => {
    const cmContent = {
      tagName: "DIV",
      isContentEditable: true,
      closest: (selector) => (selector === ".cm-editor" ? { className: "cm-editor" } : null),
    };
    const viewContainer = {
      contains: (node) => node === cmContent,
    };
    const sidebarContentEditable = {
      tagName: "DIV",
      isContentEditable: true,
      closest: () => null,
    };

    assert.equal(isMarkdownEditorFocused(viewContainer, cmContent), true);
    assert.equal(isMarkdownEditorFocused(viewContainer, sidebarContentEditable), false);

    const calls = [];
    const editor = {
      replaceSelection: (text) => calls.push(text),
    };
    assert.equal(insertDictatedText(editor, "  hello CM6  "), true);
    assert.deepEqual(calls, ["hello CM6"]);
    assert.equal(insertDictatedText(editor, "   "), false);
  });

  it("inserts into textarea, text input, contenteditable, and Shadow DOM focused elements", () => {
    class MockTextArea {
      constructor(initialValue = "") {
        this.tagName = "TEXTAREA";
        this._value = initialValue;
        this.selectionStart = initialValue.length;
        this.selectionEnd = initialValue.length;
        this.disabled = false;
        this.readOnly = false;
        this.dispatched = [];
      }
      get value() {
        return this._value;
      }
      set value(v) {
        this._value = v;
      }
      setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
      }
      dispatchEvent(evt) {
        this.dispatched.push(evt);
        return true;
      }
    }

    class MockInput extends MockTextArea {
      constructor(type = "text", initialValue = "") {
        super(initialValue);
        this.tagName = "INPUT";
        this.type = type;
      }
    }

    const mockWindow = {
      HTMLTextAreaElement: MockTextArea,
      HTMLInputElement: MockInput,
      Event,
      getSelection: () => null,
    };

    // 1. <textarea> splice at cursor
    const textarea = new MockTextArea("Hello !");
    textarea.selectionStart = 6;
    textarea.selectionEnd = 6;
    const textareaDoc = {
      activeElement: textarea,
      defaultView: mockWindow,
    };
    textarea.ownerDocument = textareaDoc;
    assert.equal(insertIntoFocusedInput(textareaDoc, "world"), true);
    assert.equal(textarea.value, "Hello world!");
    assert.equal(textarea.selectionStart, 11);
    assert.equal(textarea.dispatched.length, 1);
    assert.equal(textarea.dispatched[0].type, "input");

    // 2. <input type="text"> succeeds, <input type="password"> is rejected
    const textInput = new MockInput("text", "query: ");
    const inputDoc = { activeElement: textInput, defaultView: mockWindow };
    textInput.ownerDocument = inputDoc;
    assert.equal(insertIntoFocusedInput(inputDoc, "voice"), true);
    assert.equal(textInput.value, "query: voice");

    const pwInput = new MockInput("password", "");
    const pwDoc = { activeElement: pwInput, defaultView: mockWindow };
    pwInput.ownerDocument = pwDoc;
    assert.equal(insertIntoFocusedInput(pwDoc, "secret"), false);
    assert.equal(pwInput.value, "");

    // 3. contenteditable without Obsidian's appendText uses standard appendChild(createTextNode)
    const appendedNodes = [];
    const editableEvents = [];
    const editable = {
      tagName: "DIV",
      isContentEditable: true,
      appendChild: (node) => appendedNodes.push(node),
      dispatchEvent: (evt) => editableEvents.push(evt),
    };
    const editableDoc = {
      activeElement: editable,
      defaultView: mockWindow,
      createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    };
    editable.ownerDocument = editableDoc;
    assert.equal(insertIntoFocusedInput(editableDoc, "sidebar reply"), true);
    assert.deepEqual(appendedNodes, [{ nodeType: 3, textContent: "sidebar reply" }]);
    assert.equal(editableEvents.length, 1);

    // 4. Shadow DOM traversal resolves inner focused textarea
    const shadowTextarea = new MockTextArea("inside ");
    const shadowHost = {
      tagName: "COPILOT-CHAT",
      shadowRoot: {
        activeElement: shadowTextarea,
      },
    };
    const shadowDoc = {
      activeElement: shadowHost,
      defaultView: mockWindow,
    };
    shadowTextarea.ownerDocument = shadowDoc;
    assert.equal(resolveDeepActiveElement(shadowDoc), shadowTextarea);
    assert.equal(insertIntoFocusedInput(shadowDoc, "shadow"), true);
    assert.equal(shadowTextarea.value, "inside shadow");
  });
});

describe("SpeechPlayer deterministic timing, onPlayStart sync, fallback, and mid-playback cancel", () => {
  it("synchronizes onSentenceStart with actual playback start (not prefetch) and cancels mid-utterance", async () => {
    const events = [];
    const pendingUtterances = [];
    let cancelCount = 0;
    let resumeCount = 0;

    class DeferredUtterance {
      constructor(text) {
        this.text = text;
        this.rate = 1;
        this.lang = "";
        this.voice = null;
        this.onend = null;
        this.onerror = null;
      }
    }

    const mockWindow = {
      SpeechSynthesisUtterance: DeferredUtterance,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      speechSynthesis: {
        paused: true,
        getVoices: () => [],
        resume: () => {
          resumeCount += 1;
          mockWindow.speechSynthesis.paused = false;
        },
        speak: (utterance) => {
          events.push(`speak:${utterance.text}`);
          pendingUtterances.push(utterance);
        },
        cancel: () => {
          cancelCount += 1;
        },
      },
      URL,
    };

    const fallbackCalls = [];
    const player = new SpeechPlayer(
      { engine: "vits-wasm", voice: "", rate: 1.0, language: "en-US" },
      {
        onSentenceStart: (sentence) => {
          events.push(`subtitle:${sentence}`);
        },
        onEngineFallback: (requested, fallback) => {
          fallbackCalls.push({ requested, fallback });
        },
      },
      () => mockWindow,
      { speechWatchdogMs: 5000 },
    );

    const queued = player.speakSentences(["First sentence.", "Second sentence.", "Third sentence."]);
    assert.equal(queued, 3);

    // Wait deterministically until the first utterance actually begins speaking.
    while (pendingUtterances.length < 1) {
      await new Promise((resolve) => queueMicrotask(resolve));
    }

    // Even though prefetchDepth=2 already synthesized sentence 2, ONLY sentence 1's subtitle
    // has been emitted because subtitles are driven by PlaybackQueue.onPlayStart.
    assert.equal(resumeCount, 1);
    assert.deepEqual(fallbackCalls, [{ requested: "vits-wasm", fallback: "system" }]);
    assert.deepEqual(events, ["subtitle:First sentence.", "speak:First sentence."]);

    // Finish first utterance -> second utterance begins speaking and updates subtitle.
    pendingUtterances[0].onend();
    while (pendingUtterances.length < 2) {
      await new Promise((resolve) => queueMicrotask(resolve));
    }
    assert.deepEqual(events, [
      "subtitle:First sentence.",
      "speak:First sentence.",
      "subtitle:Second sentence.",
      "speak:Second sentence.",
    ]);

    // Cancel mid-second-utterance -> immediately stops, drops third sentence, and drains cleanly.
    player.cancel();
    await player.waitUntilDrained();
    assert.ok(cancelCount >= 1);
    assert.equal(player.state, "idle");
    assert.equal(pendingUtterances.length, 2);

    await player.dispose();
  });
});
