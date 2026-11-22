/**
 * Minimal host-agnostic WinterCG Web-standard ambient declarations for `@voice-mode/core`
 * so `voice-core` compiles strictly against `lib: ["ES2022"]` with zero DOM (`window`,
 * `document`, `HTMLElement`) and zero `@types/node` (`Buffer`, `process`) globals.
 */

interface AbortEventListenerOptions {
  once?: boolean
}

interface AbortSignal {
  readonly aborted: boolean
  readonly reason?: unknown
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: boolean | AbortEventListenerOptions,
  ): void
  removeEventListener(
    type: 'abort',
    listener: () => void,
    options?: boolean | AbortEventListenerOptions,
  ): void
}

declare const AbortController: {
  prototype: AbortController
  new (): AbortController
}

interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

interface ReadableStreamReadResult<T> {
  done: boolean
  value?: T
}

interface ReadableStreamDefaultReader<R = Uint8Array> {
  read(): Promise<ReadableStreamReadResult<R>>
  releaseLock(): void
  cancel(reason?: unknown): Promise<void>
}

interface ReadableStream<R = Uint8Array> {
  getReader(): ReadableStreamDefaultReader<R>
  cancel(reason?: unknown): Promise<void>
}

declare const Headers: {
  prototype: Headers
  new (init?: HeadersInit): Headers
}

interface Headers {
  get(name: string): string | null
  has(name: string): boolean
  forEach(callbackfn: (value: string, key: string, parent: Headers) => void): void
}

type HeadersInit = [string, string][] | Record<string, string> | Headers
type BodyInit = string | ArrayBuffer | ArrayBufferView | URLSearchParams | ReadableStream<Uint8Array>
type RequestRedirect = 'error' | 'follow' | 'manual'

interface Request {
  readonly url: string
}

type RequestInfo = Request | string

interface RequestInit {
  body?: BodyInit | null
  headers?: HeadersInit
  method?: string
  redirect?: RequestRedirect
  signal?: AbortSignal | null
}

interface ResponseInit {
  headers?: HeadersInit
  status?: number
  statusText?: string
}

declare const Response: {
  prototype: Response
  new (body?: BodyInit | null, init?: ResponseInit): Response
}

interface Response {
  readonly body: ReadableStream<Uint8Array> | null
  readonly headers: Headers
  readonly ok: boolean
  readonly redirected: boolean
  readonly status: number
  readonly statusText: string
  readonly url: string
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
  text(): Promise<string>
}

declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>

declare const TextEncoder: {
  prototype: TextEncoder
  new (): TextEncoder
}

interface TextEncoder {
  readonly encoding: string
  encode(input?: string): Uint8Array
}

interface TextDecodeOptions {
  stream?: boolean
}

declare const TextDecoder: {
  prototype: TextDecoder
  new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): TextDecoder
}

interface TextDecoder {
  readonly encoding: string
  decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string
}

type AllowSharedBufferSource = ArrayBufferLike | ArrayBufferView

declare const URL: {
  prototype: URL
  new (url: string | URL, base?: string | URL): URL
}

interface URL {
  hash: string
  host: string
  hostname: string
  href: string
  readonly origin: string
  password: string
  pathname: string
  port: string
  protocol: string
  search: string
  readonly searchParams: URLSearchParams
  username: string
  toString(): string
}

declare const URLSearchParams: {
  prototype: URLSearchParams
  new (init?: string[][] | Record<string, string> | string | URLSearchParams): URLSearchParams
}

interface URLSearchParams {
  get(name: string): string | null
  set(name: string, value: string): void
  toString(): string
}

interface Crypto {
  getRandomValues<T extends ArrayBufferView>(array: T): T
}

declare const crypto: Crypto

declare function setTimeout(callback: () => void, ms?: number): number
declare function clearTimeout(id: number | undefined): void
declare function queueMicrotask(callback: () => void): void
