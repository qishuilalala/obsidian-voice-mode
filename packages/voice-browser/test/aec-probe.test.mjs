import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { probeTrackAec, resolveBargeInPolicy } from '../src/index.ts'

describe('aec-probe and barge-in policy', () => {
  it('enables auto barge-in only on desktop Chromium/Electron with verified native AEC3', () => {
    assert.deepEqual(
      resolveBargeInPolicy({ isEdge: false, isSafari: false, isMobile: false, nativeAecActive: true }),
      { policy: 'auto', reason: 'ok', allowHandsFreeBargeIn: true },
    )
  })

  it('honestly downgrades Edge, Safari, Mobile, and inactive native AEC to manual policy', () => {
    assert.deepEqual(
      resolveBargeInPolicy({ isEdge: true, isSafari: false, isMobile: false, nativeAecActive: true }),
      { policy: 'manual', reason: 'edge-aec-unreliable', allowHandsFreeBargeIn: false },
    )

    assert.deepEqual(
      resolveBargeInPolicy({ isEdge: false, isSafari: true, isMobile: false, nativeAecActive: true }),
      { policy: 'manual', reason: 'safari-aec-unreliable', allowHandsFreeBargeIn: false },
    )

    assert.deepEqual(
      resolveBargeInPolicy({ isEdge: false, isSafari: false, isMobile: true, nativeAecActive: true }),
      { policy: 'manual', reason: 'mobile-aec-unreliable', allowHandsFreeBargeIn: false },
    )

    assert.deepEqual(
      resolveBargeInPolicy({ isEdge: false, isSafari: false, isMobile: false, nativeAecActive: false }),
      { policy: 'manual', reason: 'native-aec-inactive', allowHandsFreeBargeIn: false },
    )
  })

  it('probes MediaStreamTrack settings safely when constraints are active, disabled, or absent', () => {
    const active = probeTrackAec(
      { getSettings: () => ({ echoCancellation: true, sampleRate: 48000, channelCount: 1 }) },
      { echoCancellation: true },
    )
    assert.deepEqual(active, {
      supportedConstraint: true,
      appliedEchoCancellation: true,
      nativeAecActive: true,
      sampleRate: 48000,
      channelCount: 1,
    })

    const missing = probeTrackAec(null, { echoCancellation: false })
    assert.equal(missing.nativeAecActive, false)
    assert.equal(missing.appliedEchoCancellation, null)
  })
})
