// A1 regression: Obsidian >= 1.13 renders the settings tab ONLY from
// `getSettingDefinitions()` and never calls the legacy `display()` (official
// obsidian.d.ts: "Not called when getSettingDefinitions() returns a non-empty
// array; the tab is rendered declaratively from those definitions instead").
// Two settings promised by README.md ("settings can turn autoLanguageVoice
// off"; "maintain the pronunciation dictionary in settings") used to exist
// only in the legacy display() path, so Obsidian >= 1.13 users (including the
// 1.15.1 acceptance host) could not see, change, or search them.
//
// This file is the adapted red test from the A1 audit
// (/tmp/vm-evidence/obsidian-audit2/red-settings-parity.test.mjs, which itself
// was red: 2 failed / 1 control pass on baseline 33473d8). Assertions are not
// weakened; getControlValue/setControlValue persistence is additionally
// covered because Obsidian's declarative controls and Settings Search read and
// write through those methods.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
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
    addClass(...names) { for (const n of names) { for (const p of String(n).split(/\\s+/).filter(Boolean)) classes.add(p); } return el; },
    removeClass(...names) { for (const n of names) { for (const p of String(n).split(/\\s+/).filter(Boolean)) classes.delete(p); } return el; },
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
    addEventListener(ev, fn) { const list = listeners.get(ev) ?? []; list.push(fn); listeners.set(ev, list); },
    remove() {},
    setCssProps() {},
    isConnected: true,
  };
  return el;
}

export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = makeEl("div"); }
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
  setName(name) { this.name = name; this.settingEl.createDiv({ cls: "setting-item-name", text: name }); return this; }
  setDesc(desc) { this.desc = desc; this.settingEl.createDiv({ cls: "setting-item-description", text: desc }); return this; }
  setHeading() { return this; }
  setDisabled() { return this; }
  addText(cb) { const c = { placeholder: "", value: "", setPlaceholder(p) { this.placeholder = p; return this; }, setValue(v) { this.value = v; return this; }, onChange(fn) { this._onChange = fn; return this; } }; cb(c); this.textComp = c; return this; }
  addToggle(cb) { const c = { setValue() { return this; }, onChange() { return this; } }; cb(c); return this; }
  addDropdown(cb) { const c = { options: {}, addOption(k, l) { this.options[k] = l; return this; }, setValue() { return this; }, onChange() { return this; } }; cb(c); return this; }
  addSlider(cb) { const c = { setLimits() { return this; }, setValue() { return this; }, onChange() { return this; } }; cb(c); return this; }
  addComponent(cb) { cb(makeEl("div")); return this; }
}

export class SecretComponent {
  constructor(_app, _el) { this.value = ""; this._onChange = null; secretComponentInstances.push(this); }
  setValue(v) { this.value = v; return this; }
  onChange(fn) { this._onChange = fn; return this; }
}

export class MarkdownView {}
export class Plugin {
  constructor(app = {}, manifest = {}) { this.app = app; this.manifest = manifest; this._commands = []; this._savedData = null; }
  async loadData() { return {}; }
  async saveData(d) { this._savedData = d; }
  addCommand(c) { this._commands.push(c); return c; }
  addRibbonIcon() {}
  addSettingTab() {}
  addStatusBarItem() { return makeEl("div"); }
  registerEvent() {}
  registerDomEvent() {}
}
export const Platform = { isMobile: false, isDesktop: true, isWin: false, isLinux: false, isSafari: false };
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

const { detectRuntimeCapabilities } = await import("../src/runtime-guard.ts");
const { createDefaultSettings } = await import("../src/settings.ts");
const { VoiceModeSettingTab } = await import("../src/settings-tab.ts");

function makeHost() {
  const state = { saves: 0 };
  const host = {
    settings: createDefaultSettings(),
    capabilities: detectRuntimeCapabilities(false, "macos"),
    saveSettings: async () => {
      state.saves += 1;
    },
    getModelStatus: async () => null,
    isDownloadingModels: () => false,
  };
  return { host, saves: () => state.saves };
}

function flattenDefinitionNames(defs) {
  const names = [];
  for (const item of defs) {
    if (item && item.type === "group") {
      names.push(...flattenDefinitionNames(item.items ?? []));
    } else if (item && typeof item.name === "string") {
      names.push(item.name);
    }
  }
  return names;
}

function findDefinition(defs, name) {
  for (const item of defs) {
    if (item && item.type === "group") {
      const nested = findDefinition(item.items ?? [], name);
      if (nested) return nested;
    } else if (item && item.name === name) {
      return item;
    }
  }
  return null;
}

function findGroup(defs, heading) {
  return defs.find((item) => item && item.type === "group" && item.heading === heading) ?? null;
}

/** Recursively collect display() rendered text (Setting names and panel titles). */
function collectRenderedTexts(el, out = new Set()) {
  if (!el) return out;
  for (const setting of el._settings ?? []) {
    if (setting.name) out.add(setting.name);
  }
  if (typeof el.getText === "function" && el.getText()) out.add(el.getText());
  for (const child of el.children ?? []) collectRenderedTexts(child, out);
  return out;
}

describe("A1: Obsidian >= 1.13 declarative settings parity (autoLanguageVoice + pronunciation dictionary)", () => {
  it("getSettingDefinitions() exposes both settings inside the Voice input group (Settings Search index)", () => {
    const { host } = makeHost();
    const tab = new VoiceModeSettingTab(host, host);
    const defs = tab.getSettingDefinitions();
    const names = flattenDefinitionNames(defs);
    const missing = ["Match voice language per sentence", "Pronunciation dictionary (read-aloud)"].filter(
      (name) => !names.includes(name),
    );
    assert.deepEqual(
      missing,
      [],
      `declarative settings definitions missing: ${missing.join(", ")} (Obsidian >= 1.13 renders from getSettingDefinitions(); display() is not called)`,
    );

    const voiceInput = findGroup(defs, "Voice input");
    assert.ok(voiceInput, "Voice input group must exist");
    const voiceInputNames = (voiceInput.items ?? []).map((item) => item.name);
    assert.ok(voiceInputNames.includes("Match voice language per sentence"));
    assert.ok(voiceInputNames.includes("Pronunciation dictionary (read-aloud)"));

    const languageToggle = findDefinition(defs, "Match voice language per sentence");
    assert.equal(languageToggle.control.type, "toggle");
    assert.equal(languageToggle.control.key, "autoLanguageVoice");
    const pronunciation = findDefinition(defs, "Pronunciation dictionary (read-aloud)");
    assert.equal(typeof pronunciation.render, "function", "pronunciation editor must render via render()");
  });

  it("getControlValue/setControlValue read and persist autoLanguageVoice (declarative controls + Settings Search)", async () => {
    const { host, saves } = makeHost();
    const tab = new VoiceModeSettingTab(host, host);
    assert.equal(
      tab.getControlValue("autoLanguageVoice"),
      host.settings.autoLanguageVoice,
      "getControlValue must return settings.autoLanguageVoice",
    );

    await tab.setControlValue("autoLanguageVoice", false);
    assert.equal(host.settings.autoLanguageVoice, false, "setControlValue must persist autoLanguageVoice");
    assert.equal(saves(), 1, "setControlValue must persist settings once");
    assert.equal(tab.getControlValue("autoLanguageVoice"), false);

    await tab.setControlValue("autoLanguageVoice", true);
    assert.equal(host.settings.autoLanguageVoice, true);
    assert.equal(saves(), 2);

    // Non-boolean values are ignored like the other toggle controls, keeping the stored value.
    await tab.setControlValue("autoLanguageVoice", "yes");
    assert.equal(host.settings.autoLanguageVoice, true);
  });

  it("(control evidence) legacy display() renders the same two settings - proving the two render paths diverged", () => {
    const { host } = makeHost();
    const tab = new VoiceModeSettingTab(host, host);
    tab.display();
    const texts = collectRenderedTexts(tab.containerEl);
    assert.ok(texts.has("Match voice language per sentence"), "display() renders the per-sentence language toggle");
    assert.ok(texts.has("Pronunciation dictionary (read-aloud)"), "display() renders the pronunciation dictionary editor");
  });
});
