/**
 * Cross-platform Obsidian outbound `fetch` adapter with CORS fallback.
 *
 * Strategy (proven in M0 Spike-4 on Obsidian 1.15.1 / Origin `app://obsidian.md`):
 * 1. Primary: native `fetch` (enforces `redirect: "error"` and native `ReadableStream` SSE).
 * 2. Fallback when `fetch` fails with a CORS / network `TypeError` (e.g. OpenAI, Volcengine
 *    Ark Doubao, or local Ollama without `OLLAMA_ORIGINS`):
 *    - Desktop: zero-redirect Node `https` / loopback `http` stream wrapped in a Web `Response`
 *      (preserving both `redirect: "error"` security and real chunked SSE streaming).
 *    - Mobile (`Platform.isMobile`): Obsidian's official `requestUrl({ throw: false })` wrapped
 *      in a Web `Response`.
 */

import { validateEndpointUrl } from "@voice-mode/core";
import { requestUrl, type RequestUrlParam } from "obsidian";
import { loadDesktopModule, type LoadDesktopModuleOptions } from "./desktop-fs.ts";

const MOD_HTTPS = "https";
const MOD_HTTP = "http";
const REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

interface NodeIncomingMessageLike extends AsyncIterable<Uint8Array> {
  readonly statusCode?: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  on?(event: "error", listener: (err: Error) => void): this;
  destroy(error?: Error): void;
}

interface NodeClientRequestLike {
  on(event: "error", listener: (err: Error) => void): this;
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  destroy(error?: Error): void;
}

interface NodeHttpModuleLike {
  request(
    url: string,
    options: {
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
    },
    callback: (res: NodeIncomingMessageLike) => void,
  ): NodeClientRequestLike;
}

export interface ObsidianCorsFetchOptions extends LoadDesktopModuleOptions {
  readonly fetchImpl?: typeof fetch;
  readonly requestUrlImpl?: typeof requestUrl;
  readonly onCorsFallback?: (url: string, via: "desktop-node" | "obsidian-request-url") => void;
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") {
    return reason;
  }
  const err = new Error("Request aborted.");
  err.name = "AbortError";
  return err;
}

function headersInitToRecord(init?: HeadersInit): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) {
    return out;
  }
  if (init instanceof Headers) {
    init.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init)) {
    for (const pair of init) {
      if (Array.isArray(pair) && pair.length >= 2) {
        out[String(pair[0])] = String(pair[1]);
      }
    }
    return out;
  }
  for (const [key, value] of Object.entries(init)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function normalizeResponseHeaders(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.join(", ");
    }
  }
  return out;
}

function extractBodyPayload(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === null || body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  return undefined;
}

function isLikelyCorsOrFetchTypeError(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) {
    return false;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return false;
  }
  return err instanceof TypeError;
}

function executeDesktopZeroRedirectFetch(
  urlStr: string,
  init: RequestInit | undefined,
  httpMod: NodeHttpModuleLike,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }

    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headersInitToRecord(init?.headers);
    const payload = extractBodyPayload(init?.body);
    const forbidRedirect = init?.redirect === "error";

    let settled = false;
    let activeRes: NodeIncomingMessageLike | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

    const cleanupAbort = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };

    const req = httpMod.request(urlStr, { method, headers }, (res) => {
      activeRes = res;
      res.on?.("error", () => undefined);
      const status = res.statusCode ?? 0;

      if (forbidRedirect && REDIRECT_CODES.has(status)) {
        res.destroy();
        cleanupAbort();
        if (!settled) {
          settled = true;
          reject(new TypeError(`HTTP ${status} redirect blocked by redirect="error" policy.`));
        }
        return;
      }

      if (settled) {
        res.destroy();
        return;
      }
      settled = true;

      const iterator = res[Symbol.asyncIterator]();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) {
              streamController = null;
              cleanupAbort();
              controller.close();
              return;
            }
            const chunk = next.value;
            const copy = new Uint8Array(chunk.byteLength);
            copy.set(chunk);
            controller.enqueue(copy);
          } catch (err) {
            streamController = null;
            cleanupAbort();
            controller.error(err);
          }
        },
        cancel() {
          streamController = null;
          cleanupAbort();
          res.destroy();
        },
      });

      resolve(
        new Response(stream, {
          status: status >= 200 && status <= 599 ? status : 502,
          headers: normalizeResponseHeaders(res.headers),
        }),
      );
    });

    const onAbort = (): void => {
      const abortErr = createAbortError(signal?.reason);
      req.destroy(abortErr);
      activeRes?.destroy();
      if (streamController) {
        const ctrl = streamController;
        streamController = null;
        try {
          ctrl.error(abortErr);
        } catch {
          // Stream may already be closed or cancelled.
        }
      }
      if (!settled) {
        settled = true;
        cleanupAbort();
        reject(abortErr);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    req.on("error", (err: Error) => {
      cleanupAbort();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

async function executeObsidianRequestUrlFallback(
  urlStr: string,
  init: RequestInit | undefined,
  reqUrlFn: typeof requestUrl,
): Promise<Response> {
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }

  const headers = headersInitToRecord(init?.headers);
  const rawBody = extractBodyPayload(init?.body);
  let requestBody: string | ArrayBuffer | undefined;
  if (typeof rawBody === "string") {
    requestBody = rawBody;
  } else if (rawBody instanceof Uint8Array) {
    const copy = new Uint8Array(rawBody.byteLength);
    copy.set(rawBody);
    requestBody = copy.buffer;
  }

  const param: RequestUrlParam = {
    url: urlStr,
    method: (init?.method ?? "GET").toUpperCase(),
    headers,
    body: requestBody,
    throw: false,
  };

  let onAbort: (() => void) | null = null;
  const abortRace =
    signal !== undefined
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(createAbortError(signal.reason));
            return;
          }
          onAbort = () => reject(createAbortError(signal.reason));
          signal.addEventListener("abort", onAbort, { once: true });
        })
      : null;

  const reqPromise = reqUrlFn(param);
  if (abortRace) {
    void reqPromise.catch(() => undefined);
  }

  let res: Awaited<ReturnType<typeof requestUrl>>;
  try {
    res = abortRace ? await Promise.race([reqPromise, abortRace]) : await reqPromise;
  } finally {
    if (onAbort && signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }

  if (init?.redirect === "error" && REDIRECT_CODES.has(res.status)) {
    throw new TypeError(`HTTP ${res.status} redirect blocked by redirect="error" policy.`);
  }

  return new Response(res.arrayBuffer, {
    status: res.status >= 200 && res.status <= 599 ? res.status : 502,
    headers: res.headers,
  });
}

/**
 * Create a `typeof fetch` implementation that uses standard `fetch` first and transparently
 * falls back when `Origin: app://obsidian.md` triggers a browser CORS `TypeError`.
 */
export function createObsidianFetchWithCorsFallback(
  options: ObsidianCorsFetchOptions = {},
): typeof fetch {
  const baseFetch = options.fetchImpl ?? fetch;
  const reqUrlFn = options.requestUrlImpl ?? requestUrl;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Defense-in-depth: validate HTTPS (or loopback HTTP) and reject embedded URL credentials.
    const validatedUrl = validateEndpointUrl(urlStr);

    try {
      return await baseFetch(validatedUrl.toString(), init);
    } catch (primaryErr) {
      if (!isLikelyCorsOrFetchTypeError(primaryErr, init?.signal)) {
        throw primaryErr;
      }

      const isHttps = validatedUrl.protocol === "https:";
      const nodeTransport = loadDesktopModule<NodeHttpModuleLike>(
        isHttps ? MOD_HTTPS : MOD_HTTP,
        options,
      );

      if (nodeTransport) {
        options.onCorsFallback?.(validatedUrl.origin, "desktop-node");
        return executeDesktopZeroRedirectFetch(validatedUrl.toString(), init, nodeTransport);
      }

      options.onCorsFallback?.(validatedUrl.origin, "obsidian-request-url");
      return executeObsidianRequestUrlFallback(validatedUrl.toString(), init, reqUrlFn);
    }
  };
}
