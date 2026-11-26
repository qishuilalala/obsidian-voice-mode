/**
 * Streaming ASR client for voice-daemon's WebSocket endpoint (P1-5).
 *
 * Protocol (docs/API.md §WS): binary PCM16LE@16k frames upstream; JSON text frames
 * `{type:"ready"}` / `{type:"partial",text}` / `{type:"final",text,language}` /
 * `{type:"error",code,message}` downstream; `{"type":"stop"}` finalizes.
 */

/** Minimal structural WebSocket surface (works without DOM lib in zero-dep hosts). */
export interface DaemonStreamSocket {
  binaryType: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onclose: ((event: unknown) => void) | null
  send(data: string | ArrayBuffer): void
  close(): void
}

export type DaemonStreamSocketConstructor = new (url: string) => DaemonStreamSocket

export interface DaemonStreamTranscriberOptions {
  /** Base ws URL, e.g. `ws://127.0.0.1:18790`. */
  url: string
  token: string
  onPartial?: (text: string) => void
  onError?: (error: Error) => void
  /** Injectable WebSocket constructor (tests / non-browser hosts). */
  webSocketImpl?: DaemonStreamSocketConstructor
  /** Ready-handshake timeout in ms (default 5000). */
  connectTimeoutMs?: number
  /** Final-frame timeout in ms (default 10000). */
  stopTimeoutMs?: number
}

export interface DaemonStreamFinal {
  text: string
  language?: string
}

interface StreamFrame {
  type?: string
  text?: string
  language?: string
  message?: string
  code?: string
  ok?: boolean
}

function floatToInt16Le(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buffer)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, Math.round(clamped * 32_767), true)
  }
  return buffer
}

export class DaemonStreamTranscriber {
  private readonly options: DaemonStreamTranscriberOptions
  private socket: DaemonStreamSocket | null = null
  private ready: Promise<void> | null = null
  private finalize: ((result: DaemonStreamFinal) => void) | null = null
  private failFinalize: ((error: Error) => void) | null = null
  private closed = false

  constructor(options: DaemonStreamTranscriberOptions) {
    this.options = options
  }

  private resolveImpl(): DaemonStreamSocketConstructor {
    const impl =
      this.options.webSocketImpl ??
      (globalThis as { WebSocket?: DaemonStreamSocketConstructor }).WebSocket
    if (!impl) {
      throw new Error('WebSocket is unavailable in this environment')
    }
    return impl
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.ready) {
      return this.ready
    }
    const WebSocketImpl = this.resolveImpl()
    const base = this.options.url.replace(/\/+$/, '').replace(/^http/, 'ws')
    const tokenParam = encodeURIComponent(this.options.token)
    const socket = new WebSocketImpl(`${base}/v1/audio/transcriptions/stream?token=${tokenParam}`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    this.ready = new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? 5_000
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('daemon streaming connect timed out'))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        socket.onerror = null
        socket.onmessage = null
        socket.onclose = null
      }
      socket.onerror = () => {
        cleanup()
        reject(new Error('daemon streaming connection failed'))
      }
      socket.onmessage = (event: { data: unknown }) => {
        const frame = this.parseFrame(event.data)
        if (!frame) {
          return
        }
        if (frame.type === 'ready') {
          cleanup()
          socket.onmessage = (later: { data: unknown }) => this.handleFrame(later.data)
          socket.onclose = () => this.handleClose()
          resolve()
        } else if (frame.type === 'error') {
          cleanup()
          reject(new Error(frame.message ?? 'daemon streaming error'))
        }
      }
    })
    this.ready.catch(() => undefined)
    if (signal?.aborted) {
      this.close()
      throw new Error('daemon streaming connect aborted')
    }
    return this.ready
  }

  pushPcm16(samples: Float32Array): void {
    if (this.closed || !this.socket || !samples || samples.length === 0) {
      return
    }
    try {
      this.socket.send(floatToInt16Le(samples))
    } catch (err) {
      this.options.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** Finalize the session and resolve with the final transcript. */
  async stop(): Promise<DaemonStreamFinal> {
    if (!this.socket || this.closed) {
      throw new Error('daemon streaming session is not connected')
    }
    const timeoutMs = this.options.stopTimeoutMs ?? 10_000
    const result = new Promise<DaemonStreamFinal>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finalize = null
        this.failFinalize = null
        reject(new Error('daemon streaming finalize timed out'))
      }, timeoutMs)
      this.finalize = (final) => {
        clearTimeout(timer)
        this.finalize = null
        this.failFinalize = null
        resolve(final)
      }
      this.failFinalize = (error) => {
        clearTimeout(timer)
        this.finalize = null
        this.failFinalize = null
        reject(error)
      }
    })
    try {
      this.socket.send(JSON.stringify({ type: 'stop' }))
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.failFinalize?.(error)
    }
    return result
  }

  close(): void {
    this.closed = true
    try {
      this.socket?.close()
    } catch {
      // Ignore close errors on teardown.
    }
    this.socket = null
    this.failFinalize?.(new Error('daemon streaming session closed'))
  }

  private parseFrame(raw: unknown): StreamFrame | null {
    try {
      const text = typeof raw === 'string' ? raw : String(raw)
      const parsed = JSON.parse(text) as unknown
      if (typeof parsed !== 'object' || parsed === null) {
        return null
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- JSON.parse yields unknown; the shape check above guarantees an object.
      return parsed as StreamFrame
    } catch {
      return null
    }
  }

  private handleFrame(raw: unknown): void {
    const frame = this.parseFrame(raw)
    if (!frame) {
      return
    }
    if (frame.type === 'partial') {
      this.options.onPartial?.(frame.text ?? '')
      return
    }
    if (frame.type === 'final') {
      this.finalize?.({
        text: frame.text ?? '',
        ...(frame.language ? { language: frame.language } : {}),
      })
      return
    }
    if (frame.type === 'error') {
      this.failFinalize?.(new Error(frame.message ?? frame.code ?? 'daemon streaming error'))
    }
  }

  private handleClose(): void {
    this.failFinalize?.(new Error('daemon streaming connection closed before final result'))
  }
}
