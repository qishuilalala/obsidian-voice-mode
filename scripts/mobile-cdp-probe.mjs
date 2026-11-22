// Discover local page IDs, then opt in to a reload of one Obsidian desktop vault.
// node scripts/mobile-cdp-probe.mjs --discover [--port 9229 | --serial emulator-5554]
// node scripts/mobile-cdp-probe.mjs --discover --port 9229 --target ID --emulate-mobile on|off
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const usage = "Use --selftest or --discover [--serial SERIAL | --port PORT [--target ID --emulate-mobile on|off]].";

function localPort(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw Error("Invalid loopback port");
  return Number(value);
}

function pagesAt(port, entries) {
  const pages = [];
  for (const entry of entries) {
    if (entry.type !== "page" || !entry.id || !entry.webSocketDebuggerUrl) continue;
    const ws = new URL(entry.webSocketDebuggerUrl);
    if (ws.protocol !== "ws:" || !["127.0.0.1", "localhost"].includes(ws.hostname) ||
        Number(ws.port || 80) !== port || ws.username || ws.password) continue;
    ws.hostname = "127.0.0.1";
    pages.push({ id: entry.id, url: entry.url, ws: ws.href });
  }
  return pages;
}

async function listPages(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    redirect: "error", signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw Error(`CDP discovery returned HTTP ${response.status}`);
  return pagesAt(port, await response.json());
}

// Node's WebSocket handles wire framing. Each short-lived connection has one CDP request.
async function evaluate(wsUrl, expression, { reload = false, Socket = WebSocket } = {}) {
  const ws = new Socket(wsUrl);
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      let sent = false;
      const disconnected = () => {
        if (reload && sent) resolve();
        else reject(Error("CDP disconnected"));
      };
      timer = setTimeout(() => reject(Error("CDP request timed out")), 2000);
      ws.addEventListener("error", disconnected);
      ws.addEventListener("close", disconnected);
      ws.addEventListener("message", ({ data }) => {
        try {
          const reply = JSON.parse(data);
          if (reply.id !== 1) return;
          if (reply.error || reply.result.exceptionDetails) throw Error("Renderer rejected the CDP request");
          resolve(reply.result.result.value);
        } catch (error) { reject(error); }
      });
      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
          sent = true;
        } catch (error) { reject(error); }
      }, { once: true });
    });
  } finally {
    clearTimeout(timer);
    ws.close();
  }
}

const modeState = `({
  mode: window.app?.isMobile,
  ready: Boolean(window.app?.plugins?.getPlugin('voice-mode')),
  vault: window.app?.vault?.getName(),
  timeOrigin: performance.timeOrigin
})`;

async function reconnect(check, wait = sleep) {
  let lastError;
  for (const delay of [100, 200, 400, 800, 1200, 1600, 2000, 2000, 2000]) {
    await wait(delay);
    try {
      const page = await check();
      if (page) return page;
    } catch (error) { lastError = error; }
  }
  throw Error("Obsidian did not finish reloading Voice Mode", { cause: lastError });
}

async function emulate(port, pages, id, mobile, { list = listPages, read = evaluate, wait = sleep } = {}) {
  const previous = pages.find(page => page.id === id && page.url?.startsWith("app://obsidian.md/"));
  if (!previous) throw Error("Select a listed desktop Obsidian page ID");
  const initial = await read(previous.ws, modeState);
  if (typeof initial.mode !== "boolean" || !initial.ready || !initial.vault) throw Error("Enable Voice Mode in the selected vault first");
  if (initial.mode === mobile) return previous;

  await read(previous.ws, `window.app.emulateMobile(${mobile})`, { reload: true });
  return reconnect(async () => {
    const current = await list(port);
    // Another open vault may share this URL. Never reconnect to a pre-existing sibling.
    const same = current.find(page => page.id === id && page.url === previous.url);
    const newPages = current.filter(page => page.url === previous.url && !pages.some(old => old.id === page.id));
    const page = same ?? (newPages.length === 1 ? newPages[0] : null);
    if (!page) return null;
    const state = await read(page.ws, modeState);
    return state.timeOrigin !== initial.timeOrigin && state.vault === initial.vault &&
      state.mode === mobile && state.ready ? page : null;
  }, wait);
}

function printPages(label, pages) {
  console.log(`${label}: ${JSON.stringify(pages.map(({ id, url }) => ({ id, obsidian: url?.startsWith("app://obsidian.md/") })))}`);
}

function webViews(output) {
  return [...new Set(Array.from(output.matchAll(/@(webview_devtools_remote(?:_[\w.-]+)?)\s*$/gm), match => match[1]))];
}

async function android(serial) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), ".local", "android", "sdk");
  const binary = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  const adb = (...args) => execFileSync(existsSync(binary) ? binary : "adb", args, {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  let devices;
  try {
    devices = adb("devices").split(/\r?\n/).filter(line => /\sdevice$/.test(line)).map(line => line.split(/\s/)[0]);
  } catch (error) {
    if (serial || error.code !== "ENOENT") throw error;
    return console.log("Android: adb unavailable");
  }
  if (serial && !devices.includes(serial)) throw Error("Selected Android device is offline or unauthorized");
  if (!devices.length) console.log("Android: no connected device");
  for (const device of serial ? [serial] : devices) {
    const run = (...args) => adb("-s", device, ...args);
    let sockets;
    try {
      sockets = webViews(run("shell", "grep", "-a", "webview_devtools_remote", "/proc/net/unix"));
    } catch (error) {
      if (error.status !== 1 || error.stderr?.trim()) throw error;
      sockets = []; // grep returns 1 when this device has no debuggable WebViews.
    }
    if (!sockets.length) console.log(`${device}: no debuggable WebViews`);
    for (const socket of sockets) {
      const port = localPort(run("forward", "tcp:0", `localabstract:${socket}`));
      try {
        printPages(`${device}/${socket}`, await listPages(port));
      } finally {
        run("forward", "--remove", `tcp:${port}`);
      }
    }
  }
}

async function selftest() {
  const ws = "ws://127.0.0.1:9229/devtools/page/one";
  const target = { id: "one", type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: ws };
  assert.deepEqual(pagesAt(9229, [target, { ...target, type: "worker" },
    { ...target, webSocketDebuggerUrl: ws.replace("9229", "9230") }]), [{ id: "one", url: target.url, ws }]);
  assert.deepEqual(webViews("@webview_devtools_remote_123\n@webview_devtools_remote_123\n@other"), ["webview_devtools_remote_123"]);
  class TestSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(frame) {
      const { id, method, params } = JSON.parse(frame);
      assert.equal(method, "Runtime.evaluate");
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: '{"method":"Runtime.executionContextsCleared"}' }));
        if (params.expression === "reload") this.dispatchEvent(new Event("close"));
        else this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { result: { value: true } } }) }));
      });
    }
    close() {}
  }
  assert.equal(await evaluate(ws, "ready", { Socket: TestSocket }), true);
  await evaluate(ws, "reload", { Socket: TestSocket, reload: true });
  await assert.rejects(evaluate(ws, "reload", { Socket: TestSocket }), /disconnected/);
  const original = { id: "one", ws, url: target.url };
  const sibling = { ...original, id: "other", ws: "other" };
  const replacement = { ...original, id: "two", ws: "replacement" };
  const targets = [[sibling], [original, sibling], [sibling, replacement], [sibling, replacement]];
  const initial = { ready: true, vault: "test", mode: false, timeOrigin: 1 };
  const states = [initial, { ...initial, mode: true }, { ...initial, vault: "other", mode: true, timeOrigin: 2 },
    { ...initial, mode: true, timeOrigin: 2 }];
  const delays = [];
  const result = await emulate(9229, [original, sibling], "one", true, {
    list: () => targets.shift(), wait: ms => delays.push(ms),
    read: (socket, expression, options) => {
      assert.notEqual(socket, sibling.ws);
      if (options?.reload) return assert.equal(expression, "window.app.emulateMobile(true)");
      return states.shift();
    },
  });
  assert.equal(result, replacement);
  assert.deepEqual(delays, [100, 200, 400, 800]);
  await assert.rejects(reconnect(() => null, () => {}), /did not finish/);
  console.log("PASS: local targets, Android sockets, CDP frames, reload disconnect, reconnect backoff and timeout");
}

async function main() {
  const { values } = parseArgs({ options: {
    selftest: { type: "boolean" }, discover: { type: "boolean" }, port: { type: "string" },
    serial: { type: "string" }, target: { type: "string" }, "emulate-mobile": { type: "string" },
  } });
  if (values.selftest && Object.keys(values).length === 1) return selftest();
  const mode = values["emulate-mobile"];
  if (!values.discover || values.selftest || (values.serial && (values.port || values.target)) ||
      Boolean(values.target) !== (mode !== undefined) || (mode !== undefined && !["on", "off"].includes(mode))) throw Error(usage);
  if (!values.serial) {
    const port = localPort(values.port ?? "9229");
    try {
      const pages = await listPages(port);
      printPages(`desktop:${port}`, pages);
      if (values.target) {
        const page = await emulate(port, pages, values.target, mode === "on");
        console.log(`Voice Mode ready on ${page.id}; mobile emulation ${mode}`);
      }
    } catch (error) {
      if (values.port || values.target) throw error;
      console.log(`desktop:${port}: unavailable (${error.message})`);
    }
  }
  if (!values.port && !values.target) await android(values.serial ?? process.env.ANDROID_SERIAL);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
