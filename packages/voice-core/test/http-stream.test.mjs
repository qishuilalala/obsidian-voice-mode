import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mergeFloat32Chunks,
  raceAbort,
  readBoundedStreamBytes,
  readRedactedHttpErrorMessage,
  resolveSecretValue,
  toError,
} from "../src/http-stream.ts";

describe("http-stream helpers", () => {
  it("resolves secret providers lazily and trims results", async () => {
    assert.equal(await resolveSecretValue("  sk-test  "), "sk-test");
    assert.equal(await resolveSecretValue(async () => " abc "), "abc");
    assert.equal(await resolveSecretValue(() => null), "");
    assert.equal(await resolveSecretValue(undefined), "");
  });

  it("normalizes unknown errors", () => {
    assert.equal(toError("boom").message, "boom");
    const err = new Error("x");
    assert.equal(toError(err), err);
    assert.equal(toError(undefined, "fallback").message, "fallback");
  });

  it("rejects a race when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(raceAbort(new Promise(() => {}), controller.signal), /aborted/);
  });

  it("reads bounded streams and enforces the byte limit", async () => {
    const make = (chunks) =>
      new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }));
    const signal = new AbortController().signal;
    const bytes = await readBoundedStreamBytes(make([new Uint8Array([1, 2]), new Uint8Array([3])]), 10, signal, () => new Error("too-large"));
    assert.deepEqual([...bytes], [1, 2, 3]);
    await assert.rejects(
      readBoundedStreamBytes(make([new Uint8Array(8), new Uint8Array(8)]), 10, signal, () => new Error("too-large")),
      /too-large/,
    );
  });

  it("redacts secrets in error bodies before truncating", async () => {
    const res = new Response("Authorization: Bearer sk-secret-1234567890 and more text", { status: 401 });
    const message = await readRedactedHttpErrorMessage(res, 4096, 200, new AbortController().signal);
    assert.match(message, /^HTTP 401: /);
    assert.ok(!message.includes("sk-secret-1234567890"));
  });

  it("merges float chunks in order", () => {
    const merged = mergeFloat32Chunks([new Float32Array([1, 2]), new Float32Array([3])], 3);
    assert.deepEqual([...merged], [1, 2, 3]);
  });
});
