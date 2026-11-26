import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DuplexProtocol } from '../src/index.ts'

describe('duplex protocol: state machine', () => {
  it('starts idle and enters listening on speech', () => {
    const p = new DuplexProtocol()
    assert.deepEqual(p.snapshot(), { state: 'idle', speechActive: false, playbackActive: false })
    const t = p.feed({ type: 'speech-start' })
    assert.equal(t.to, 'listening')
    assert.equal(p.snapshot().speechActive, true)
  })

  it('ducks playback on overlap when configured', () => {
    const p = new DuplexProtocol({ duckOnOverlap: true, duckRatio: 0.15 })
    p.feed({ type: 'playback-start' })
    const t = p.feed({ type: 'speech-start' })
    assert.equal(t.to, 'overlap')
    assert.ok(t.actions.includes('duck-playback'))
    assert.ok(!t.actions.includes('stop-playback'))
  })

  it('stops playback and cancels generation on overlap when ducking is disabled', () => {
    const p = new DuplexProtocol({ duckOnOverlap: false })
    p.feed({ type: 'playback-start' })
    const t = p.feed({ type: 'speech-start' })
    assert.deepEqual(t.actions, ['stop-playback', 'cancel-generation'])
  })

  it('handles explicit barge-in: stop playback, cancel generation, flush queue, arm capture', () => {
    const p = new DuplexProtocol()
    p.feed({ type: 'playback-start' })
    const t = p.feed({ type: 'barge-in' })
    assert.equal(t.to, 'barge-in')
    assert.deepEqual(t.actions, ['stop-playback', 'cancel-generation', 'flush-queue', 'start-capture'])
    assert.equal(p.snapshot().playbackActive, false)
  })

  it('returns to idle after interrupted speech ends', () => {
    const p = new DuplexProtocol()
    p.feed({ type: 'playback-start' })
    p.feed({ type: 'barge-in' })
    p.feed({ type: 'speech-end' })
    assert.equal(p.snapshot().state, 'idle')
  })

  it('returns to listening when playback ends while the user is still speaking', () => {
    const p = new DuplexProtocol()
    p.feed({ type: 'speech-start' })
    p.feed({ type: 'playback-start' })
    const t = p.feed({ type: 'playback-end' })
    assert.equal(t.to, 'listening')
  })

  it('yield stops playback and capture, returning to idle', () => {
    const p = new DuplexProtocol()
    p.feed({ type: 'playback-start' })
    const t = p.feed({ type: 'yield' })
    assert.equal(t.to, 'idle')
    assert.deepEqual(t.actions, ['stop-playback', 'stop-capture'])
  })

  it('reset clears all flags', () => {
    const p = new DuplexProtocol()
    p.feed({ type: 'speech-start' })
    p.feed({ type: 'playback-start' })
    p.feed({ type: 'reset' })
    assert.deepEqual(p.snapshot(), { state: 'idle', speechActive: false, playbackActive: false })
  })
})
