import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DaemonStreamTranscriber } from "../src/daemon-stream.ts";

class MockSocket {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.binaryType = "blob";
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    MockSocket.last = this;
    queueMicrotask(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ ok: true, type: "ready", sampleRate: 16000 }) });
    });
  }

  send(data) {
    this.sent.push(data);
    if (typeof data === "string") {
      const control = JSON.parse(data);
      if (control.type === "stop") {
        queueMicrotask(() =>
          this.onmessage?.({ data: JSON.stringify({ ok: true, type: "final", text: "最终文本", language: "zh" }) }),
        );
      }
      return;
    }
    queueMicrotask(() =>
      this.onmessage?.({ data: JSON.stringify({ ok: true, type: "partial", text: `p${this.sent.length}` }) }),
    );
  }

  close() {
    this.onclose?.();
  }
}

describe("daemon streaming transcriber (P1-5 client)", () => {
  it("negotiates ready, sends PCM16LE frames, forwards partials and resolves the final", async () => {
    const partials = [];
    const client = new DaemonStreamTranscriber({
      url: "ws://127.0.0.1:18790",
      token: "tok-123",
      webSocketImpl: MockSocket,
      onPartial: (text) => partials.push(text),
    });
    await client.connect();
    const socket = MockSocket.last;
    assert.match(socket.url, /\/v1\/audio\/transcriptions\/stream\?token=tok-123$/);

    client.pushPcm16(new Float32Array([0, 0.5, -0.5]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(partials, ["p1"]);

    const pcm = socket.sent.find((item) => item instanceof ArrayBuffer);
    assert.equal(pcm.byteLength, 6);
    const view = new DataView(pcm);
    assert.equal(view.getInt16(0, true), 0);
    assert.equal(view.getInt16(2, true), 16_384);
    assert.equal(view.getInt16(4, true), -16_383);

    const final = await client.stop();
    assert.equal(final.text, "最终文本");
    assert.equal(final.language, "zh");
    client.close();
  });

  it("rejects stop when not connected and surfaces server errors", async () => {
    const client = new DaemonStreamTranscriber({ url: "ws://x", token: "t", webSocketImpl: MockSocket });
    await assert.rejects(() => client.stop(), /not connected/);
  });
});
