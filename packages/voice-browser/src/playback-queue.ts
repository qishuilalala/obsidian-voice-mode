/**
 * Bounded-prefetch (`prefetchDepth = 2`) audio playback queue with monotonic epoch
 * instantaneous cancellation, abort-raced pump (no head-of-line blocking), and
 * configurable overflow policy (`drop-newest` by default for long-note reading).
 */

import type { TtsSynthResult } from '@voice-mode/core'

export type PlaybackQueueState = 'idle' | 'playing' | 'disposed'
export type QueueOverflowPolicy = 'drop-oldest' | 'drop-newest'

export interface AudioSink {
  /** Play synthesized audio; must respect `signal` abort for immediate interruption. */
  play(payload: TtsSynthResult, signal: AbortSignal): Promise<void>
  /** Optional immediate synchronous halt hook (e.g., AudioBufferSourceNode.stop or SIGTERM). */
  stop?(): void
}

export type SynthesizeFn = (text: string, signal: AbortSignal) => Promise<TtsSynthResult | null>

export interface PlaybackQueueOptions {
  synthesize: SynthesizeFn
  sink: AudioSink
  /** Maximum number of sentences synthesized/buffered concurrently (default: 2). */
  prefetchDepth?: number
  /** Maximum waiting queue size (default: 200). */
  maxQueueSize?: number
  /** Overflow policy when waiting queue reaches `maxQueueSize` (default: `'drop-newest'`). */
  overflowPolicy?: QueueOverflowPolicy
  /** Fired right before `sink.play()` after passing epoch validation (never on prefetch or cancelled items). */
  onPlayStart?: (text: string) => void
  /** Fired whenever a sentence is dropped due to queue overflow. */
  onDrop?: (droppedText: string, reason: 'overflow') => void
  onStateChange?: (state: PlaybackQueueState) => void
  onError?: (error: unknown, text: string) => void
}

interface WaitingItem {
  text: string
  epoch: number
}

interface PrefetchedItem {
  text: string
  epoch: number
  controller: AbortController
  promise: Promise<TtsSynthResult | null>
  failed: boolean
}

type RaceResult<T> = { aborted: true } | { aborted: false; value: T }

/**
 * Race an async operation against an AbortSignal, always detaching the listener on completion.
 * Prevents stalled syntheses or non-cooperative sinks from blocking newer epochs after `cancel()`.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<RaceResult<T>> {
  if (signal.aborted) return Promise.resolve({ aborted: true })
  return new Promise<RaceResult<T>>((resolve, reject) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      resolve({ aborted: true })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve({ aborted: false, value })
      },
      (err) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export class PlaybackQueue {
  private readonly synthesize: SynthesizeFn
  private readonly sink: AudioSink
  private readonly prefetchDepth: number
  private readonly maxQueueSize: number
  private readonly overflowPolicy: QueueOverflowPolicy
  private readonly onPlayStart?: (text: string) => void
  private readonly onDrop?: (droppedText: string, reason: 'overflow') => void
  private readonly onStateChange?: (state: PlaybackQueueState) => void
  private readonly onError?: (error: unknown, text: string) => void

  private currentEpoch = 0
  private currentState: PlaybackQueueState = 'idle'
  private waiting: WaitingItem[] = []
  private prefetched: PrefetchedItem[] = []
  private playingEntry: {
    epoch: number
    synthController: AbortController
    playController: AbortController
  } | null = null
  private pumpRunning = false
  private drainWaiters: Array<() => void> = []

  constructor(options: PlaybackQueueOptions) {
    this.synthesize = options.synthesize
    this.sink = options.sink
    this.prefetchDepth = Math.max(1, Math.floor(options.prefetchDepth ?? 2))
    this.maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize ?? 200))
    this.overflowPolicy = options.overflowPolicy ?? 'drop-newest'
    this.onPlayStart = options.onPlayStart
    this.onDrop = options.onDrop
    this.onStateChange = options.onStateChange
    this.onError = options.onError
  }

  get state(): PlaybackQueueState {
    return this.currentState
  }

  get epoch(): number {
    return this.currentEpoch
  }

  get pendingCount(): number {
    return this.waiting.length + this.prefetched.length + (this.playingEntry ? 1 : 0)
  }

  /**
   * Enqueue a sentence for bounded-prefetch synthesis and ordered playback.
   * Returns `true` if the sentence was accepted into the queue, `false` if skipped or dropped.
   */
  enqueue(text: string): boolean {
    if (this.currentState === 'disposed') return false
    const trimmed = text.trim()
    if (!trimmed) return false
    if (this.waiting.length >= this.maxQueueSize) {
      if (this.overflowPolicy === 'drop-oldest') {
        const dropped = this.waiting.shift()
        if (dropped) this.notifyDrop(dropped.text)
      } else {
        this.notifyDrop(trimmed)
        return false
      }
    }
    this.waiting.push({ text: trimmed, epoch: this.currentEpoch })
    this.setState('playing')
    this.fillPrefetchWindow()
    void this.ensurePump()
    return true
  }

  /**
   * Immediately interrupt active playback and drop all prefetched/queued sentences.
   * Advances the monotonic epoch so stalled syntheses/sinks from prior epochs neither
   * block nor resurrect into newer playback.
   */
  cancel(): void {
    if (this.currentState === 'disposed') return
    this.abortCurrentEpoch()
    this.setState('idle')
    this.resolveDrainWaiters()
  }

  /** Permanently dispose the queue; subsequent `enqueue` calls are ignored. */
  dispose(): void {
    if (this.currentState === 'disposed') return
    this.abortCurrentEpoch()
    this.setState('disposed')
    this.resolveDrainWaiters()
  }

  /** Resolves once the queue is empty and no synthesis or playback is active (or on cancel/dispose). */
  waitUntilDrained(): Promise<void> {
    if (this.isEmpty()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve)
    })
  }

  private isEmpty(): boolean {
    return this.waiting.length === 0 && this.prefetched.length === 0 && this.playingEntry === null
  }

  private isDisposed(): boolean {
    return this.currentState === 'disposed'
  }

  private notifyDrop(droppedText: string): void {
    try {
      this.onDrop?.(droppedText, 'overflow')
    } catch {
      // Observer errors must not break enqueue flow.
    }
  }

  private setState(next: PlaybackQueueState): void {
    if (this.currentState === next) return
    this.currentState = next
    try {
      this.onStateChange?.(next)
    } catch {
      // Observer errors must not break queue transitions.
    }
  }

  private resolveDrainWaiters(): void {
    if (this.drainWaiters.length === 0) return
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }

  private abortCurrentEpoch(): void {
    this.currentEpoch++
    this.waiting.length = 0
    const inflight = this.prefetched
    this.prefetched = []
    for (const item of inflight) {
      item.controller.abort(new Error('playback cancelled'))
    }
    const active = this.playingEntry
    this.playingEntry = null
    if (active) {
      active.synthController.abort(new Error('playback cancelled'))
      active.playController.abort(new Error('playback cancelled'))
    }
    try {
      this.sink.stop?.()
    } catch {
      // Sink stop errors are swallowed during cancellation.
    }
  }

  /**
   * Maintain backpressure: total in-window items (`playing + prefetched`) never exceed `prefetchDepth`.
   */
  private fillPrefetchWindow(): void {
    if (this.currentState === 'disposed') return
    const activeSlots = this.prefetched.length + (this.playingEntry ? 1 : 0)
    let available = this.prefetchDepth - activeSlots
    while (available > 0 && this.waiting.length > 0) {
      const next = this.waiting.shift()!
      if (next.epoch !== this.currentEpoch) continue
      const controller = new AbortController()
      const item: PrefetchedItem = {
        text: next.text,
        epoch: next.epoch,
        controller,
        failed: false,
        promise: Promise.resolve(null),
      }
      item.promise = Promise.resolve()
        .then(() => this.synthesize(next.text, controller.signal))
        .catch((err) => {
          item.failed = true
          if (item.epoch === this.currentEpoch && !controller.signal.aborted) {
            try {
              this.onError?.(err, next.text)
            } catch {
              // Ignore error hook failures.
            }
          }
          return null
        })
      this.prefetched.push(item)
      available--
    }
  }

  private async ensurePump(): Promise<void> {
    if (this.pumpRunning || this.isDisposed()) return
    this.pumpRunning = true
    try {
      while (!this.isDisposed()) {
        this.fillPrefetchWindow()
        const head = this.prefetched.shift()
        if (!head) break

        // Hold the active slot before awaiting synthesis so prefetch window stays strictly bounded.
        const playController = new AbortController()
        const playToken = {
          epoch: head.epoch,
          synthController: head.controller,
          playController,
        }
        this.playingEntry = playToken

        // Abort-race synthesis so a hung/non-abortable synthesize() never head-of-line blocks cancel().
        const synthOutcome = await raceWithAbort(head.promise, head.controller.signal)

        // Epoch guard: if cancelled/disposed while synthesizing, never notify onPlayStart or invoke sink.play().
        if (
          synthOutcome.aborted ||
          this.isDisposed() ||
          head.epoch !== this.currentEpoch ||
          this.playingEntry !== playToken
        ) {
          if (this.playingEntry === playToken) this.playingEntry = null
          continue
        }

        const payload = synthOutcome.value
        if (payload && payload.audio.byteLength > 0 && !head.failed) {
          try {
            this.onPlayStart?.(head.text)
          } catch {
            // Observer errors must not prevent playback.
          }

          // Re-check epoch in case onPlayStart synchronously triggered cancel() or dispose().
          if (
            this.isDisposed() ||
            head.epoch !== this.currentEpoch ||
            this.playingEntry !== playToken
          ) {
            if (this.playingEntry === playToken) this.playingEntry = null
            continue
          }

          try {
            const playPromise = Promise.resolve().then(() =>
              this.sink.play(payload, playController.signal),
            )
            // Guard against late unhandled rejection if cancel() resolves the race early.
            playPromise.catch(() => undefined)
            await raceWithAbort(playPromise, playController.signal)
          } catch (err) {
            if (
              head.epoch === this.currentEpoch &&
              !playController.signal.aborted &&
              !this.isDisposed()
            ) {
              try {
                this.onError?.(err, head.text)
              } catch {
                // Ignore error hook failures.
              }
            }
          }
        }

        if (this.playingEntry === playToken) {
          this.playingEntry = null
        }

        // Slot freed: pull next waiting item into prefetch immediately.
        this.fillPrefetchWindow()
      }
    } finally {
      this.pumpRunning = false
      if (!this.isDisposed()) {
        if (this.isEmpty()) {
          this.setState('idle')
          this.resolveDrainWaiters()
        } else {
          void this.ensurePump()
        }
      }
    }
  }
}
