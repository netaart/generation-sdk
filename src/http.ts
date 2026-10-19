import {
  GenerationConfigError,
  GenerationTimeoutError,
  GenerationTransportError,
  type GenerationTransportErrorDetails,
} from "./errors.js";
import type { GenerationDebugConfig, GenerationRouterMetadata } from "./types.js";
import { compactObject } from "./utils.js";

const routerMetadataValuePattern = /^[A-Za-z0-9._-]{1,64}$/;

// neta-router 从这些请求头读取调用方身份；caller task id 要求同时给出 platform，取值还要能写成 OSS user metadata。
export function validateRouterMetadata(metadata: GenerationRouterMetadata): Record<string, string> {
  const headers: Record<string, string> = {};
  if (metadata.userUuid !== undefined) headerOrThrow(headers, "X-Neta-User-Uuid", "userUuid", metadata.userUuid);
  if (metadata.platform !== undefined) headerOrThrow(headers, "X-Neta-Platform", "platform", metadata.platform);
  if (metadata.callerTaskId !== undefined) {
    headerOrThrow(headers, "X-Neta-Caller-Task-Id", "callerTaskId", metadata.callerTaskId);
    if (metadata.platform === undefined) {
      throw new GenerationConfigError("router.callerTaskId requires router.platform");
    }
  }
  if (metadata.retry !== undefined) {
    if (!Number.isInteger(metadata.retry) || metadata.retry < 0) {
      throw new GenerationConfigError("router.retry must be a non-negative integer");
    }
    headers["X-Neta-Retry-Count"] = String(metadata.retry);
  }
  return headers;
}

function headerOrThrow(headers: Record<string, string>, name: string, field: string, value: string): void {
  if (!routerMetadataValuePattern.test(value)) {
    throw new GenerationConfigError(`router.${field} must match [A-Za-z0-9._-]{1,64}`);
  }
  headers[name] = value;
}

// 调用方自己给出的 X-Neta-* 请求头优先。
export function createRouterMetadataFetch(fetchFn: typeof fetch, headers: Record<string, string>): typeof fetch {
  if (Object.keys(headers).length === 0) return fetchFn;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [name, value] of Object.entries(headers)) {
      if (!requestHeaders.has(name)) requestHeaders.set(name, value);
    }
    if (input instanceof Request && init === undefined) {
      return fetchFn(new Request(input, { headers: requestHeaders }));
    }
    return fetchFn(input, { ...init, headers: requestHeaders });
  }) as typeof fetch;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const output: Record<string, string> = {};
    headers.forEach((value, key) => {
      output[key] = value;
    });
    return output;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [key, value]));
  return { ...headers };
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseDebugBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") return body ? "[non-string body]" : undefined;
  return parseJsonBody(body);
}

const TRACE_HEADER_PATTERN =
  /(^|[-_])(request|trace|span|correlation|cf-ray|x-tt-logid)([-_]|$)|^(x-request-id|x-trace-id|x-correlation-id|traceparent|tracestate|cf-ray|server-timing)$/i;

function pickTraceHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (TRACE_HEADER_PATTERN.test(key)) output[key] = value;
  }
  return output;
}

class DebugObserverError extends Error {
  declare cause: unknown;

  constructor(cause: unknown) {
    super("Generation debug observer failed");
    this.name = "DebugObserverError";
    this.cause = cause;
  }
}

function emitDebugRequest(debug: GenerationDebugConfig, url: string, init: RequestInit): number {
  try {
    debug.logger({
      type: "request",
      url,
      method: init.method ?? "GET",
      headers: headersToRecord(init.headers),
      body: parseDebugBody(init.body),
    });
  } catch (cause) {
    throw new DebugObserverError(cause);
  }
  return Date.now();
}

async function readDebugResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || contentType.includes("+json")) {
    return parseJsonBody(await response.clone().text());
  }
  if (contentType.startsWith("text/")) return response.clone().text();
  return "[non-text body]";
}

async function emitDebugResponse(
  debug: GenerationDebugConfig,
  url: string,
  response: Response,
  startedAt: number,
): Promise<void> {
  const elapsedMs = Date.now() - startedAt;
  // 读取响应体副本的错误属于请求本身，按超时或者网络错误报告；DebugObserverError 只包装 logger 抛出的错误。
  const body = debug.includeResponseBody ? { body: await readDebugResponseBody(response) } : {};
  const headers = headersToRecord(response.headers);
  try {
    debug.logger({
      type: "response",
      url,
      status: response.status,
      statusText: response.statusText,
      headers,
      trace: pickTraceHeaders(headers),
      elapsedMs,
      ...body,
    });
  } catch (cause) {
    throw new DebugObserverError(cause);
  }
}

export function createDebugFetch(fetchFn: typeof fetch, debug: GenerationDebugConfig): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    // 官方 SDK 传入 Request 对象时，从副本读取请求体。
    const requestInit =
      init ??
      (input instanceof Request
        ? { method: input.method, headers: input.headers, body: input.body ? await input.clone().text() : null }
        : {});
    const startedAt = emitDebugRequest(debug, url, requestInit);
    const response = await fetchFn(input, init);
    await emitDebugResponse(debug, url, response, startedAt);
    return response;
  }) as typeof fetch;
}

// 请求和读取响应体共用一个超时：SDK 自己的定时器中止请求时报告超时，其他错误按网络错误报告。
async function withRequestTimeout<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    return await run(controller.signal);
  } catch (error) {
    if (error instanceof DebugObserverError) throw error.cause;
    if (controller.signal.aborted) throw new GenerationTimeoutError();
    throw new GenerationTransportError(transportErrorDetails(url, init, startedAt, error), error);
  } finally {
    clearTimeout(timeout);
  }
}

export function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return withRequestTimeout(url, init, timeoutMs, (signal) => fetchFn(url, { ...init, signal }));
}

/** Fetches a URL and reads the whole body as text; the timeout and the error mapping cover the body as well as the headers. */
export function fetchTextWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; text: string }> {
  return withRequestTimeout(url, init, timeoutMs, async (signal) => {
    const response = await fetchFn(url, { ...init, signal });
    return { response, text: await response.text() };
  });
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function transportErrorDetails(
  rawUrl: string,
  init: RequestInit,
  startedAt: number,
  error: unknown,
): GenerationTransportErrorDetails {
  const summary = transportErrorSummary(error);
  return compactObject({
    method: (init.method ?? "GET").toUpperCase(),
    ...transportErrorTarget(rawUrl),
    elapsedMs: Date.now() - startedAt,
    causeName: summary.causeName ?? summary.name,
    causeCode: summary.causeCode,
    causeSyscall: summary.causeSyscall,
    causeAddress: summary.causeAddress,
    causePort: summary.causePort,
  }) as GenerationTransportErrorDetails;
}

function transportErrorTarget(rawUrl: string): { host?: string; path: string } {
  try {
    const url = new URL(rawUrl);
    return { host: url.host, path: url.pathname };
  } catch {
    const suffixIndex = rawUrl.search(/[?#]/);
    return { path: suffixIndex === -1 ? rawUrl : rawUrl.slice(0, suffixIndex) };
  }
}

function transportErrorSummary(error: unknown) {
  const outer = error instanceof Error ? error : new Error(String(error));
  const cause = isRecord(outer.cause) ? outer.cause : undefined;
  return compactObject({
    name: outer.name,
    causeName: stringProperty(cause, "name"),
    causeCode: stringProperty(cause, "code") ?? stringProperty(outer, "code"),
    causeSyscall: stringProperty(cause, "syscall") ?? stringProperty(outer, "syscall"),
    causeAddress: stringProperty(cause, "address") ?? stringProperty(outer, "address"),
    causePort: stringOrNumberProperty(cause, "port") ?? stringOrNumberProperty(outer, "port"),
  });
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function stringOrNumberProperty(value: unknown, key: string): string | number | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "string" || typeof item === "number" ? item : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
