import { describe, expect, it, vi } from "vitest";
import {
  createDebugFetch,
  createRouterMetadataFetch,
  fetchTextWithTimeout,
  fetchWithTimeout,
  validateRouterMetadata,
} from "../src/http.js";
import {
  createGenerationClient,
  GenerationConfigError,
  GenerationTimeoutError,
  GenerationTransportError,
} from "../src/index.js";

describe("router metadata headers", () => {
  it("requires a platform for a caller task id", () => {
    expect(() => validateRouterMetadata({ callerTaskId: "task-1" })).toThrow(
      new GenerationConfigError("router.callerTaskId requires router.platform"),
    );
  });

  it.each(["task 1", "task/1", ""])("rejects %j as a caller task id", (callerTaskId) => {
    expect(() => validateRouterMetadata({ platform: "cohub", callerTaskId })).toThrow(
      "router.callerTaskId must match [A-Za-z0-9._-]{1,64}",
    );
  });

  it("adds the headers to every request and keeps caller-provided values", async () => {
    const calls: Array<{ input: string | URL | Request; init: RequestInit }> = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init: init ?? {} });
      return new Response("{}", { status: 200 });
    };
    const fetchWithRouter = createRouterMetadataFetch(
      fetchMock as typeof fetch,
      validateRouterMetadata({ userUuid: "user-1", platform: "cohub", callerTaskId: "task-1", retry: 2 }),
    );

    await fetchWithRouter("https://router.neta.art/v1/images/generations", {
      method: "POST",
      headers: { "X-Neta-Platform": "custom" },
    });

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-neta-platform")).toBe("custom");
    expect(headers.get("x-neta-user-uuid")).toBe("user-1");
    expect(headers.get("x-neta-caller-task-id")).toBe("task-1");
    expect(headers.get("x-neta-retry-count")).toBe("2");
  });

  it("sends the headers on the submit and every task poll", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url).endsWith("/v1/video/generations")) {
        return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "SUCCESS", result_url: "https://example.com/out.mp4" } }), {
        status: 200,
      });
    };
    const client = createGenerationClient({
      apiKey: "key",
      fetch: fetchMock as typeof fetch,
      router: { platform: "cohub", callerTaskId: "task-1" },
    });

    try {
      const promise = client.generate({
        model: "seedance-2-0-fast",
        content: [{ type: "text", text: "hello" }],
        parameters: { poll_interval: 1, max_wait: 30 },
      });
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    } finally {
      vi.useRealTimers();
    }

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.get("x-neta-platform")).toBe("cohub");
      expect(call.headers.get("x-neta-caller-task-id")).toBe("task-1");
    }
  });
});

describe("generation HTTP transport errors", () => {
  it("preserves connect timeout diagnostics in the thrown message and details", async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
      address: "47.77.179.20",
      port: 443,
    });
    const fetchMock = async () => {
      throw new TypeError("fetch failed", { cause });
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const error = await client
      .generate({
        model: "seedance-2-0-fast",
        content: [{ type: "text", text: "hello" }],
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(GenerationTransportError);
    expect(error).toMatchObject({
      name: "GenerationTransportError",
      details: {
        method: "POST",
        host: "router.neta.art",
        path: "/v1/video/generations",
        causeName: "ConnectTimeoutError",
        causeCode: "UND_ERR_CONNECT_TIMEOUT",
        causeAddress: "47.77.179.20",
        causePort: 443,
      },
      cause: expect.any(TypeError),
    });
    expect((error as Error).message).toContain("Generation transport failed method=POST");
    expect((error as Error).message).toContain("cause_code=UND_ERR_CONNECT_TIMEOUT");
  });

  it("preserves diagnostics exposed directly by custom fetch errors", async () => {
    const fetchError = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
      syscall: "read",
      address: "47.77.179.20",
      port: 443,
    });
    const fetchMock = async () => {
      throw fetchError;
    };

    const error = await fetchWithTimeout(
      fetchMock as typeof fetch,
      "https://router.neta.art/v1/video/generations",
      { method: "POST" },
      1_000,
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: "GenerationTransportError",
      details: {
        causeName: "Error",
        causeCode: "ECONNRESET",
        causeSyscall: "read",
        causeAddress: "47.77.179.20",
        causePort: 443,
      },
      cause: fetchError,
    });
  });

  it("keeps SDK-owned aborts classified as timeouts", async () => {
    vi.useFakeTimers();
    const fetchMock = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true,
        });
      });

    try {
      const request = expect(
        fetchWithTimeout(
          fetchMock as typeof fetch,
          "https://router.neta.art/v1/video/generations",
          { method: "POST" },
          100,
        ),
      ).rejects.toBeInstanceOf(GenerationTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await request;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves relative request targets when transport diagnostics are built", async () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchMock = async () => {
      throw new TypeError("fetch failed", { cause });
    };
    const error = await fetchWithTimeout(
      fetchMock as typeof fetch,
      "/router/v1/video/generations?token=secret#diagnostic",
      { method: "POST" },
      1_000,
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({
      name: "GenerationTransportError",
      details: {
        method: "POST",
        path: "/router/v1/video/generations",
        causeCode: "ECONNRESET",
      },
      cause: expect.any(TypeError),
    });
    expect((error as GenerationTransportError).details).not.toHaveProperty("host");
    expect((error as Error).message).not.toContain("secret");
  });

  it("removes query credentials from absolute transport error targets", async () => {
    const cause = Object.assign(
      new Error("socket hang up https://router.neta.art/v1/video/generations?token=secret&signature=private"),
      { code: "ECONNRESET" },
    );
    const fetchMock = async () => {
      throw new TypeError("fetch failed", { cause });
    };
    const error = await fetchWithTimeout(
      fetchMock as typeof fetch,
      "https://router.neta.art/v1/video/generations?token=secret&signature=private#diagnostic",
      { method: "POST" },
      1_000,
    ).catch((value: unknown) => value);

    expect(error).toMatchObject({
      details: {
        host: "router.neta.art",
        path: "/v1/video/generations",
      },
    });
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("private");
    expect((error as GenerationTransportError).details).not.toHaveProperty("causeMessage");
  });

  it("keeps response debug failures out of transport error classification", async () => {
    const loggerError = new Error("logger failed");
    const fetchMock = async () => new Response("upstream unavailable", { status: 502 });
    const client = createGenerationClient({
      apiKey: "key",
      debug: {
        enabled: true,
        logger: (event) => {
          if (event.type === "response") throw loggerError;
        },
      },
      fetch: fetchMock as typeof fetch,
    });

    const error = await client
      .generate({
        model: "seedance-2-0-fast",
        content: [{ type: "text", text: "hello" }],
      })
      .catch((value: unknown) => value);

    expect(error).toBe(loggerError);
    expect(error).not.toBeInstanceOf(GenerationTransportError);
  });

  it("reports a response body that breaks off or stalls while debug reads it as a transport error or a timeout", async () => {
    const debug = { enabled: true, includeSensitive: false, includeResponseBody: true, logger: () => undefined };
    const breaking = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    const broken = await fetchTextWithTimeout(
      createDebugFetch(breaking as typeof fetch, debug),
      "https://router.neta.art/meshy/openapi/v2/text-to-3d/task_1",
      { method: "GET" },
      1_000,
    ).catch((value: unknown) => value);
    expect(broken).toBeInstanceOf(GenerationTransportError);
    expect(broken).toMatchObject({ cause: expect.any(TypeError) });

    vi.useFakeTimers();
    try {
      const stalling = async (_input: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":'));
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new DOMException("aborted", "AbortError")),
                {
                  once: true,
                },
              );
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      const request = expect(
        fetchTextWithTimeout(
          createDebugFetch(stalling as typeof fetch, debug),
          "https://router.neta.art/meshy/openapi/v2/text-to-3d/task_1",
          { method: "GET" },
          100,
        ),
      ).rejects.toBeInstanceOf(GenerationTimeoutError);
      await vi.advanceTimersByTimeAsync(100);
      await request;
    } finally {
      vi.useRealTimers();
    }
  });
});
