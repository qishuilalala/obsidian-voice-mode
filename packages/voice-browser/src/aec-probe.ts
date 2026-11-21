/**
 * Browser / Electron native AEC3 runtime probe types and honest barge-in downgrade policy.
 *
 * Edge, Safari, and Mobile WebViews frequently either ignore `echoCancellation: true`
 * or fail to cancel WebAudio playback echo reliably; downgrading to `manual` prevents
 * TTS audio from looping back into ASR as phantom user utterances.
 */

export type BargeInMode = 'detect' | 'auto' | 'manual'

export type BargeInPolicy = 'auto' | 'manual'

export type BargeInDowngradeReason =
  | 'ok'
  | 'user-selected-manual'
  | 'system-tts-bypasses-aec'
  | 'edge-aec-unreliable'
  | 'safari-aec-unreliable'
  | 'mobile-aec-unreliable'
  | 'native-aec-inactive'

export interface AecProbeResult {
  /** Whether `navigator.mediaDevices.getSupportedConstraints().echoCancellation` is true. */
  supportedConstraint: boolean
  /** Value reported by `track.getSettings().echoCancellation` (null when unavailable). */
  appliedEchoCancellation: boolean | null
  /** Effective determination that native hardware/Chromium AEC3 is active. */
  nativeAecActive: boolean
  sampleRate?: number
  channelCount?: number
}

export interface BargeInPolicyInput {
  requestedMode?: BargeInMode
  usesSystemTts?: boolean
  isEdge?: boolean
  isSafari?: boolean
  isMobile?: boolean
  nativeAecActive?: boolean
}

export interface BargeInPolicyDecision {
  policy: BargeInPolicy
  reason: BargeInDowngradeReason
  allowHandsFreeBargeIn: boolean
}

export interface TrackSettingsLike {
  echoCancellation?: boolean
  sampleRate?: number
  channelCount?: number
}

export interface MediaTrackLike {
  getSettings?: () => TrackSettingsLike
}

/**
 * Inspect an active audio MediaStreamTrack to determine whether native AEC is engaged.
 */
export function probeTrackAec(
  track: MediaTrackLike | null | undefined,
  supportedConstraints?: { echoCancellation?: boolean },
): AecProbeResult {
  const supportedConstraint = supportedConstraints?.echoCancellation === true
  const settings = track?.getSettings ? track.getSettings() : undefined
  const applied =
    typeof settings?.echoCancellation === 'boolean' ? settings.echoCancellation : null
  return {
    supportedConstraint,
    appliedEchoCancellation: applied,
    nativeAecActive: applied === true,
    sampleRate: settings?.sampleRate,
    channelCount: settings?.channelCount,
  }
}

/**
 * Determine whether hands-free barge-in (`auto`) is safe or must downgrade to `manual`.
 *
 * - `requestedMode === 'manual'` always locks to `manual` (`'user-selected-manual'`).
 * - `usesSystemTts === true` (`window.speechSynthesis` OS daemon bypasses Chromium's AEC3 reference
 *   mixer) ALWAYS locks to `manual` (`'system-tts-bypasses-aec'`), even when `requestedMode === 'auto'`.
 * - `isMobile` always downgrades to `manual` (`'mobile-aec-unreliable'`).
 * - `requestedMode === 'auto'` allows explicit user override on desktop non-system TTS; `'detect'`
 *   (default) additionally enforces Edge, Safari, and verified `nativeAecActive` checks.
 */
export function resolveBargeInPolicy(input: BargeInPolicyInput): BargeInPolicyDecision {
  const mode: BargeInMode = input.requestedMode ?? 'detect'

  if (mode === 'manual') {
    return {
      policy: 'manual',
      reason: 'user-selected-manual',
      allowHandsFreeBargeIn: false,
    }
  }

  if (input.usesSystemTts === true) {
    return {
      policy: 'manual',
      reason: 'system-tts-bypasses-aec',
      allowHandsFreeBargeIn: false,
    }
  }

  if (input.isMobile) {
    return {
      policy: 'manual',
      reason: 'mobile-aec-unreliable',
      allowHandsFreeBargeIn: false,
    }
  }

  if (mode === 'auto') {
    return {
      policy: 'auto',
      reason: 'ok',
      allowHandsFreeBargeIn: true,
    }
  }

  if (input.isEdge) {
    return {
      policy: 'manual',
      reason: 'edge-aec-unreliable',
      allowHandsFreeBargeIn: false,
    }
  }
  if (input.isSafari) {
    return {
      policy: 'manual',
      reason: 'safari-aec-unreliable',
      allowHandsFreeBargeIn: false,
    }
  }
  if (input.nativeAecActive !== true) {
    return {
      policy: 'manual',
      reason: 'native-aec-inactive',
      allowHandsFreeBargeIn: false,
    }
  }
  return {
    policy: 'auto',
    reason: 'ok',
    allowHandsFreeBargeIn: true,
  }
}
