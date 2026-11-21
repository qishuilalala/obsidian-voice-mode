import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  collectRequestTransferables,
  collectResponseTransferables,
  isWorkerRequest,
  isWorkerResponse,
  createWorkerError,
} from '../src/index.ts'

describe('worker-protocol: zero-copy transferable extraction and guards', () => {
  it('collects unique ArrayBuffer transferables across model weights, VAD, ASR, and TTS payloads', () => {
    const w1 = new ArrayBuffer(16)
    const w2 = new ArrayBuffer(32)
    const loadReq = {
      id: 1,
      type: 'model:load',
      target: 'asr-offline',
      files: [
        { name: 'model.int8.onnx', buffer: w1 },
        { name: 'tokens.txt', buffer: w2 },
        { name: 'dup.bin', buffer: w1 },
      ],
    }
    assert.deepEqual(collectRequestTransferables(loadReq), [w1, w2])
    assert.equal(isWorkerRequest(loadReq), true)

    // Defensive check against malformed non-array files
    assert.deepEqual(
      collectRequestTransferables({ id: 9, type: 'model:load', target: 'vad', files: null }),
      [],
    )

    const pcm = new Float32Array(512).buffer
    assert.deepEqual(
      collectRequestTransferables({ id: 2, type: 'vad:process', pcm, sampleRate: 16000 }),
      [pcm],
    )
    assert.deepEqual(
      collectRequestTransferables({
        id: 3,
        type: 'asr:stream-finish',
        sessionId: 's1',
        fullPcm: pcm,
        sampleRate: 16000,
      }),
      [pcm],
    )
    assert.deepEqual(
      collectRequestTransferables({ id: 4, type: 'asr:stream-finish', sessionId: 's1' }),
      [],
    )
    assert.deepEqual(
      collectRequestTransferables({ id: 5, type: 'tts:synthesize', text: 'hello' }),
      [],
    )

    const audio = new ArrayBuffer(64)
    const ttsRes = {
      id: 5,
      type: 'tts:result',
      audio,
      sampleRate: 24000,
      channels: 1,
      mime: 'audio/wav',
    }
    assert.deepEqual(collectResponseTransferables(ttsRes), [audio])
    assert.equal(isWorkerResponse(ttsRes), true)

    const errRes = createWorkerError(5, 'tts_failed', 'model not loaded', true)
    assert.equal(isWorkerResponse(errRes), true)
    assert.deepEqual(collectResponseTransferables(errRes), [])
    assert.equal(errRes.retryable, true)

    // Guard against invalid/non-integer/negative message IDs
    assert.equal(isWorkerRequest({ id: 0, type: 'vad:reset' }), true)
    assert.equal(isWorkerRequest({ id: -1, type: 'vad:reset' }), false)
    assert.equal(isWorkerRequest({ id: 1.5, type: 'vad:reset' }), false)
    assert.equal(isWorkerRequest({ id: Number.NaN, type: 'vad:reset' }), false)
    assert.equal(isWorkerRequest({ id: Number.POSITIVE_INFINITY, type: 'vad:reset' }), false)
    assert.equal(isWorkerResponse({ id: -1, type: 'worker:ack' }), false)
    assert.equal(isWorkerResponse({ id: 2.3, type: 'worker:ack' }), false)
    assert.equal(isWorkerResponse({ id: Number.NaN, type: 'worker:ack' }), false)
    assert.equal(isWorkerRequest({ id: 1, type: 'unknown' }), false)
    assert.equal(isWorkerResponse(null), false)
  })
})
