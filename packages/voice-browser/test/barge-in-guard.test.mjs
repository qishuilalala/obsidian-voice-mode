import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createBargeInGuard } from '../src/index.ts'

function createGuardRig({ manual = false } = {}) {
  const ops = []
  const engineFlags = []
  const guard = createBargeInGuard({
    shouldArm: (engineIsSystem) => {
      engineFlags.push(engineIsSystem)
      return !engineIsSystem && !manual
    },
    arm: () => ops.push('arm'),
    disarm: () => ops.push('disarm'),
  })
  return { guard, ops, engineFlags }
}

describe('createBargeInGuard: per-utterance AEC3 arm/disarm decisions', () => {
  it('arms once for a non-system utterance and de-duplicates repeated updates for the same target', () => {
    const { guard, ops } = createGuardRig()
    guard.update(false)
    guard.update(false)
    guard.update(false)
    assert.deepEqual(ops, ['arm'])
  })

  it('switches system -> non-system to arm and non-system -> system to disarm, following the actual engine', () => {
    const { guard, ops } = createGuardRig()
    guard.update(true)
    guard.update(false)
    guard.update(true)
    guard.update(false)
    assert.deepEqual(ops, ['arm', 'disarm', 'arm'])
  })

  it('reset() disarms when armed and clears the cached target so the next non-system utterance re-arms', () => {
    const { guard, ops } = createGuardRig()
    guard.update(false)
    guard.reset()
    assert.deepEqual(ops, ['arm', 'disarm'])
    guard.update(false)
    assert.deepEqual(ops, ['arm', 'disarm', 'arm'])
  })

  it('reset() while already disarmed performs no disarm and keeps repeated system updates inert', () => {
    const { guard, ops } = createGuardRig()
    guard.update(true)
    guard.reset()
    guard.reset()
    assert.deepEqual(ops, [])
  })

  it('manual barge-in mode (shouldArm returns false) never arms even for non-system utterances', () => {
    const { guard, ops } = createGuardRig({ manual: true })
    guard.update(false)
    guard.update(false)
    guard.reset()
    assert.deepEqual(ops, [])
  })

  it('passes the actual engineIsSystem flag through to shouldArm on every update', () => {
    const { guard, engineFlags } = createGuardRig()
    guard.update(true)
    guard.update(false)
    guard.update(false)
    guard.reset()
    assert.deepEqual(engineFlags, [true, false, false])
  })
})
