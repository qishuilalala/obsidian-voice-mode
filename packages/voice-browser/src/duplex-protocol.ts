/**
 * Duplex interaction state machine (P3, endpoint layer first).
 *
 * Tracks capture/playback overlap so hosts share one barge-in/yield semantics:
 * listen while speaking, stop on confirmed speech, cancel the in-flight
 * generation, and hand the floor back when playback ends.
 *
 * Pure, DOM-free, zero-dependency; hosts wire the actions to their own IO.
 */

export type DuplexState = 'idle' | 'listening' | 'speaking' | 'overlap' | 'barge-in'

export type DuplexAction =
  | 'start-capture'
  | 'stop-capture'
  | 'start-playback'
  | 'stop-playback'
  | 'cancel-generation'
  | 'duck-playback'
  | 'flush-queue'

export type DuplexEventType =
  | 'speech-start'
  | 'speech-end'
  | 'playback-start'
  | 'playback-end'
  | 'barge-in'
  | 'yield'
  | 'reset'

export interface DuplexEvent {
  type: DuplexEventType
  /** Playback duck ratio in [0, 1] when overlapping instead of stopping. */
  duckRatio?: number
}

export interface DuplexTransition {
  from: DuplexState
  to: DuplexState
  actions: DuplexAction[]
}

export interface DuplexSnapshot {
  state: DuplexState
  speechActive: boolean
  playbackActive: boolean
}

export interface DuplexProtocolOptions {
  /** Keep playback running (ducked) while the user speaks, until barge-in confirms. */
  duckOnOverlap?: boolean
  /** Duck ratio applied on overlap (default 0.2). */
  duckRatio?: number
}

function clampRatio(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.2
  return Math.min(1, Math.max(0, value))
}

export class DuplexProtocol {
  private state: DuplexState = 'idle'
  private speechActive = false
  private playbackActive = false
  private readonly duckOnOverlap: boolean
  /** Duck ratio hosts should apply when they act on `duck-playback`. */
  readonly duckRatio: number

  constructor(options: DuplexProtocolOptions = {}) {
    this.duckOnOverlap = options.duckOnOverlap ?? true
    this.duckRatio = clampRatio(options.duckRatio)
  }

  snapshot(): DuplexSnapshot {
    return {
      state: this.state,
      speechActive: this.speechActive,
      playbackActive: this.playbackActive,
    }
  }

  reset(): void {
    this.state = 'idle'
    this.speechActive = false
    this.playbackActive = false
  }

  /**
   * Feed one event and receive the actions the host must apply. Actions are
   * ordered: stop/duck playback before cancelling generation, then capture.
   */
  feed(event: DuplexEvent): DuplexTransition {
    const from = this.state
    const actions = new Set<DuplexAction>()

    switch (event.type) {
      case 'speech-start': {
        this.speechActive = true
        if (this.playbackActive) {
          this.state = 'overlap'
          if (this.duckOnOverlap) {
            actions.add('duck-playback')
          } else {
            actions.add('stop-playback')
            actions.add('cancel-generation')
          }
        } else {
          this.state = 'listening'
        }
        break
      }
      case 'speech-end': {
        this.speechActive = false
        if (this.state === 'barge-in') {
          this.state = 'idle'
        } else if (this.playbackActive) {
          this.state = 'speaking'
        } else {
          this.state = 'idle'
        }
        break
      }
      case 'playback-start': {
        this.playbackActive = true
        if (this.speechActive) {
          this.state = 'overlap'
          if (this.duckOnOverlap) {
            actions.add('duck-playback')
          } else {
            actions.add('stop-playback')
          }
        } else {
          this.state = 'speaking'
        }
        break
      }
      case 'playback-end': {
        this.playbackActive = false
        if (this.speechActive) {
          this.state = 'listening'
        } else if (this.state === 'barge-in') {
          this.state = 'idle'
        } else {
          this.state = 'idle'
        }
        break
      }
      case 'barge-in': {
        this.speechActive = true
        this.playbackActive = false
        this.state = 'barge-in'
        actions.add('stop-playback')
        actions.add('cancel-generation')
        actions.add('flush-queue')
        actions.add('start-capture')
        break
      }
      case 'yield': {
        this.speechActive = false
        if (this.playbackActive) {
          actions.add('stop-playback')
        }
        actions.add('stop-capture')
        this.state = 'idle'
        break
      }
      case 'reset': {
        this.reset()
        break
      }
      default: {
        const exhaustive: never = event.type
        void exhaustive
      }
    }

    return { from, to: this.state, actions: [...actions] }
  }
}
