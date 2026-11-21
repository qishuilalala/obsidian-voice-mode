import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PlaybackQueue } from '../src/index.ts'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flushMicrotasks = async () => {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('PlaybackQueue: bounded prefetch, onPlayStart alignment, overflow policy, and non-blocking cancel', () => {
  it('enforces prefetchDepth=2 backpressure, fires onPlayStart only at actual playback (not prefetch), and plays in FIFO order', async () => {
    const synthStarted = []
    const synthGates = new Map()
    const playStartEvents = []
    const playStarted = []
    const playGates = new Map()
    const states = []

    const queue = new PlaybackQueue({
      prefetchDepth: 2,
      synthesize: async (text) => {
        synthStarted.push(text)
        const gate = deferred()
        synthGates.set(text, gate)
        await gate.promise
        return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
      },
      sink: {
        play: async (payload) => {
          const label = new TextDecoder().decode(payload.audio)
          playStarted.push(label)
          const gate = deferred()
          playGates.set(label, gate)
          await gate.promise
        },
      },
      onPlayStart: (text) => playStartEvents.push(text),
      onStateChange: (s) => states.push(s),
    })

    assert.equal(queue.state, 'idle')
    for (const s of ['S1', 'S2', 'S3', 'S4', 'S5']) queue.enqueue(s)
    await flushMicrotasks()

    assert.equal(queue.state, 'playing')
    assert.deepEqual(synthStarted, ['S1', 'S2'])
    // Prefetching must NEVER trigger onPlayStart
    assert.deepEqual(playStartEvents, [])

    synthGates.get('S2').resolve()
    await flushMicrotasks()
    assert.deepEqual(playStarted, [])
    assert.deepEqual(playStartEvents, [])

    synthGates.get('S1').resolve()
    await flushMicrotasks()
    assert.deepEqual(playStartEvents, ['S1'])
    assert.deepEqual(playStarted, ['S1'])
    assert.deepEqual(synthStarted, ['S1', 'S2'])

    playGates.get('S1').resolve()
    await flushMicrotasks()
    assert.deepEqual(playStartEvents, ['S1', 'S2'])
    assert.deepEqual(playStarted, ['S1', 'S2'])
    assert.deepEqual(synthStarted, ['S1', 'S2', 'S3'])

    synthGates.get('S3').resolve()
    playGates.get('S2').resolve()
    await flushMicrotasks()
    assert.deepEqual(playStartEvents, ['S1', 'S2', 'S3'])
    assert.deepEqual(synthStarted, ['S1', 'S2', 'S3', 'S4'])

    synthGates.get('S4').resolve()
    playGates.get('S3').resolve()
    await flushMicrotasks()
    synthGates.get('S5').resolve()
    playGates.get('S4').resolve()
    await flushMicrotasks()
    playGates.get('S5').resolve()

    await queue.waitUntilDrained()
    assert.deepEqual(playStartEvents, ['S1', 'S2', 'S3', 'S4', 'S5'])
    assert.deepEqual(playStarted, ['S1', 'S2', 'S3', 'S4', 'S5'])
    assert.equal(queue.state, 'idle')
    assert.deepEqual(states, ['playing', 'idle'])
  })

  it('prevents head-of-line blocking when stalled synthesis OR stalled sink.play never settles after cancel()', async () => {
    const playStarts = []
    const played = []
    let stopCount = 0

    // Case 1: OLD-1 synthesis NEVER settles (ignores AbortSignal completely)
    const queue1 = new PlaybackQueue({
      prefetchDepth: 2,
      synthesize: async (text) => {
        if (text === 'STALLED-SYNTH') return new Promise(() => {})
        return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
      },
      sink: {
        play: async (payload) => {
          played.push(new TextDecoder().decode(payload.audio))
        },
        stop: () => {
          stopCount++
        },
      },
      onPlayStart: (t) => playStarts.push(t),
    })

    queue1.enqueue('STALLED-SYNTH')
    await flushMicrotasks()
    queue1.cancel()
    queue1.enqueue('NEW-1')
    await queue1.waitUntilDrained()

    assert.equal(stopCount, 1)
    assert.deepEqual(playStarts, ['NEW-1'])
    assert.deepEqual(played, ['NEW-1'])

    // Case 2: OLD-2 sink.play NEVER settles (ignores AbortSignal completely)
    const played2 = []
    const playStarts2 = []
    const queue2 = new PlaybackQueue({
      prefetchDepth: 2,
      synthesize: async (text) => ({ audio: new TextEncoder().encode(text), mime: 'audio/wav' }),
      sink: {
        play: async (payload) => {
          const label = new TextDecoder().decode(payload.audio)
          played2.push(label)
          if (label === 'STALLED-PLAY') return new Promise(() => {})
        },
      },
      onPlayStart: (t) => playStarts2.push(t),
    })

    queue2.enqueue('STALLED-PLAY')
    await flushMicrotasks()
    assert.deepEqual(played2, ['STALLED-PLAY'])
    queue2.cancel()
    queue2.enqueue('NEW-2')
    await queue2.waitUntilDrained()

    assert.deepEqual(playStarts2, ['STALLED-PLAY', 'NEW-2'])
    assert.deepEqual(played2, ['STALLED-PLAY', 'NEW-2'])
  })

  it('defaults overflowPolicy to drop-newest (protecting middle paragraphs) and supports explicit drop-oldest with onDrop', async () => {
    const synthGates = new Map()
    const droppedNewest = []
    const playedNewest = []

    const qNewest = new PlaybackQueue({
      prefetchDepth: 1,
      maxQueueSize: 2,
      synthesize: async (text) => {
        const g = deferred()
        synthGates.set(`n:${text}`, g)
        await g.promise
        return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
      },
      sink: {
        play: async (payload) => {
          playedNewest.push(new TextDecoder().decode(payload.audio))
        },
      },
      onDrop: (t, reason) => droppedNewest.push({ t, reason }),
    })

    // P1 fills active prefetch slot; P2 & P3 fill waiting (maxQueueSize=2); P4 overflows and is dropped!
    assert.equal(qNewest.enqueue('P1'), true)
    assert.equal(qNewest.enqueue('P2'), true)
    assert.equal(qNewest.enqueue('P3'), true)
    assert.equal(qNewest.enqueue('P4'), false)
    await flushMicrotasks()

    assert.deepEqual(droppedNewest, [{ t: 'P4', reason: 'overflow' }])

    for (const k of ['P1', 'P2', 'P3']) {
      synthGates.get(`n:${k}`).resolve()
      await flushMicrotasks()
    }
    await qNewest.waitUntilDrained()
    assert.deepEqual(playedNewest, ['P1', 'P2', 'P3'])

    // Explicit drop-oldest drops P2 (oldest waiting) and keeps P3, P4
    const droppedOldest = []
    const playedOldest = []
    const qOldest = new PlaybackQueue({
      prefetchDepth: 1,
      maxQueueSize: 2,
      overflowPolicy: 'drop-oldest',
      synthesize: async (text) => {
        const g = deferred()
        synthGates.set(`o:${text}`, g)
        await g.promise
        return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
      },
      sink: {
        play: async (payload) => {
          playedOldest.push(new TextDecoder().decode(payload.audio))
        },
      },
      onDrop: (t, reason) => droppedOldest.push({ t, reason }),
    })

    qOldest.enqueue('P1')
    qOldest.enqueue('P2')
    qOldest.enqueue('P3')
    qOldest.enqueue('P4')
    await flushMicrotasks()

    assert.deepEqual(droppedOldest, [{ t: 'P2', reason: 'overflow' }])
    for (const k of ['P1', 'P3', 'P4']) {
      synthGates.get(`o:${k}`).resolve()
      await flushMicrotasks()
    }
    await qOldest.waitUntilDrained()
    assert.deepEqual(playedOldest, ['P1', 'P3', 'P4'])
  })

  it('prevents stale epoch synthesis from resurrecting, isolates errors, and ignores enqueue after dispose', async () => {
    const errors = []
    const played = []
    const playStarts = []
    let activePlaySignal = null
    const playGate = deferred()

    const queue = new PlaybackQueue({
      prefetchDepth: 2,
      synthesize: async (text) => {
        if (text === 'BAD') throw new Error('synth boom')
        return { audio: new TextEncoder().encode(text), mime: 'audio/wav' }
      },
      sink: {
        play: async (payload, signal) => {
          const label = new TextDecoder().decode(payload.audio)
          played.push(label)
          if (label === 'LONG') {
            activePlaySignal = signal
            await new Promise((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true })
              playGate.promise.then(resolve)
            })
          }
        },
      },
      onPlayStart: (t) => playStarts.push(t),
      onError: (err, text) => errors.push({ err, text }),
    })

    queue.enqueue('BAD')
    queue.enqueue('GOOD')
    await queue.waitUntilDrained()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].text, 'BAD')
    assert.deepEqual(playStarts, ['GOOD'])
    assert.deepEqual(played, ['GOOD'])

    queue.enqueue('LONG')
    queue.enqueue('DROPPED')
    await flushMicrotasks()
    assert.ok(activePlaySignal)
    assert.equal(activePlaySignal.aborted, false)

    queue.cancel()
    assert.equal(activePlaySignal.aborted, true)
    await queue.waitUntilDrained()
    assert.deepEqual(played, ['GOOD', 'LONG'])
    assert.deepEqual(playStarts, ['GOOD', 'LONG'])

    queue.dispose()
    assert.equal(queue.state, 'disposed')
    queue.enqueue('AFTER-DISPOSE')
    await flushMicrotasks()
    assert.deepEqual(played, ['GOOD', 'LONG'])
  })
})
