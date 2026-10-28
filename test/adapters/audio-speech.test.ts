import { describe, expect, it, vi } from "vitest";
import {
  createGenerationClient,
  type GenerateRequest,
  GenerationConfigError,
  type GenerationContentBlock,
  type GenerationModelDeclaration,
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationValidationError,
  getBuiltinGenerationModel,
} from "../../src/index.js";

const REFERENCE_URL = "https://example.com/reference.mp3";
const SECOND_REFERENCE_URL = "https://example.com/reference-2.mp3";

function routerSuccess(
  body: Record<string, unknown> = {},
  options: { status?: number; headers?: HeadersInit } = {},
): Response {
  return new Response(
    JSON.stringify({
      url: "https://router-files.neta.art/files/request/output.mp3",
      content_type: "audio/mpeg",
      media_type: "audio",
      size: 74924,
      ...body,
    }),
    {
      status: options.status ?? 200,
      headers: { "content-type": "application/json", ...options.headers },
    },
  );
}

function audio(url = REFERENCE_URL, meta?: Record<string, unknown>): GenerationContentBlock {
  return {
    type: "audio",
    source: { type: "url", url },
    ...(meta ? { meta } : {}),
  };
}

function qwenDesignRequest(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    model: "qwen-tts",
    content: [{ type: "text", text: "这是需要朗读的文本。" }],
    meta: { voice_prompt: "沉稳清晰的男性播音员声音" },
    ...overrides,
  };
}

function recordingClient(responseFactory: () => Response = () => routerSuccess()) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return responseFactory();
  };
  return {
    calls,
    client: createGenerationClient({ apiKey: "secret-key", fetch: fetchMock as typeof fetch }),
  };
}

function requestBody(call: { init: RequestInit } | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

describe("openai.audioSpeech adapter requests", () => {
  it("sends the fixed wire contract and preserves Qwen input and voice prompt", async () => {
    const { client, calls } = recordingClient(() =>
      routerSuccess({}, { headers: { "x-request-id": "request-primary", "x-oneapi-request-id": "request-fallback" } }),
    );
    const input = "  原样保留的朗读文本。\n";
    const voicePrompt = "  沉稳清晰的声音。\n";

    const output = await client.generate({
      model: "qwen-tts",
      content: [{ type: "text", text: input }],
      meta: { voice_prompt: voicePrompt },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://router.neta.art/v1/audio/speech");
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers)).toMatchObject(
      new Headers({ Authorization: "Bearer secret-key", "Content-Type": "application/json" }),
    );
    expect(requestBody(calls[0])).toEqual({
      model: "qwen-tts",
      input,
      metadata: { voice_prompt: voicePrompt },
    });
    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://router-files.neta.art/files/request/output.mp3" },
        meta: { content_type: "audio/mpeg", size: 74924, request_id: "request-primary" },
      },
    ]);
  });

  it("maps Qwen reference audio and trims only its URL", async () => {
    const { client, calls } = recordingClient();
    await client.generate({
      model: "qwen-tts",
      content: [{ type: "text", text: "短句" }, audio(`  ${REFERENCE_URL}\n`)],
    });

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-tts",
      input: "短句",
      ref_audio: REFERENCE_URL,
    });
  });

  it("silently ignores deprecated preview_text without sending it", async () => {
    const { client, calls } = recordingClient();
    await client.generate(
      qwenDesignRequest({
        meta: { voice_prompt: "清晰女声", preview_text: "旧字段不应发送" },
      }),
    );

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-tts",
      input: "这是需要朗读的文本。",
      metadata: { voice_prompt: "清晰女声" },
    });
  });

  it("rejects a higgs-tts request before fetch", async () => {
    const fetchMock = vi.fn(async () => routerSuccess());
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    try {
      await client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] });
      throw new Error("expected config error");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationConfigError);
      expect((error as Error).message).toBe("Generation model is unavailable: higgs-tts");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openai.audioSpeech adapter validation", () => {
  it.each([
    { name: "missing text", content: [] },
    {
      name: "two text blocks",
      content: [
        { type: "text" as const, text: "一" },
        { type: "text" as const, text: "二" },
      ],
    },
    { name: "empty text", content: [{ type: "text" as const, text: "" }] },
    { name: "blank text", content: [{ type: "text" as const, text: " \n " }] },
  ])("rejects $name before fetch", async ({ content }) => {
    const fetchMock = vi.fn(async () => routerSuccess());
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    await expect(client.generate({ model: "qwen-tts", content })).rejects.toBeInstanceOf(GenerationValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts retired preview_text without treating it as a Qwen voice source", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "qwen-tts",
        content: [{ type: "text", text: "有效语音文本" }],
        meta: { preview_text: "已经失效的文本来源" },
      }),
    ).toThrow("requires one reference audio or meta.voice_prompt");
  });

  it.each([
    {
      name: "neither voice source",
      request: qwenDesignRequest({ meta: {} }),
    },
    {
      name: "both voice sources",
      request: qwenDesignRequest({
        content: [{ type: "text", text: "文本" }, audio()],
      }),
    },
    {
      name: "blank voice prompt",
      request: qwenDesignRequest({ meta: { voice_prompt: " \n " } }),
    },
    {
      name: "audio weight",
      request: qwenDesignRequest({
        content: [{ type: "text", text: "文本" }, audio(REFERENCE_URL, { weight: 1 })],
        meta: {},
      }),
    },
  ])("rejects Qwen $name", ({ request }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate(request)).toThrow(GenerationValidationError);
  });

  it("enforces Qwen reference limits inside the adapter hook when a declaration is overridden", () => {
    const declaration = getBuiltinGenerationModel("qwen-tts");
    if (!declaration) throw new Error("qwen-tts declaration is unavailable");
    const audioSpec = declaration.content.input.find((spec) => spec.type === "audio");
    if (!audioSpec) throw new Error("qwen-tts audio spec is unavailable");
    audioSpec.max = 2;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() =>
      client.validate({
        model: "qwen-tts",
        content: [{ type: "text", text: "文本" }, audio(), audio(SECOND_REFERENCE_URL)],
      }),
    ).toThrow("supports at most one reference audio");
  });

  it("rejects a higgs-tts declaration at the audio speech adapter", () => {
    const declaration = {
      schema: "neta.generation.model.v1",
      model: "higgs-tts",
      adapter: { type: "openai.audioSpeech" },
      content: {
        input: [
          { type: "text", required: true, min: 1, max: 1 },
          { type: "audio", required: false, max: 16, sources: ["url"] },
        ],
      },
    } satisfies GenerationModelDeclaration;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() => client.validate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] })).toThrow(
      "Unsupported audio speech model: higgs-tts",
    );
  });

  it.each([
    { model: "qwen-audio-3.0-tts-plus", text: "a".repeat(14) },
    { model: "qwen-audio-3.0-tts-flash", text: "😀".repeat(14) },
  ])("rejects $model input below 15 Unicode code points", ({ model, text }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate({ model, content: [{ type: "text", text }, audio()] })).toThrow(
      "requires input of at least 15 Unicode code points",
    );
  });

  it.each([
    { model: "qwen-audio-3.0-tts-plus", text: "a".repeat(15) },
    { model: "qwen-audio-3.0-tts-flash", text: ` ${"😀".repeat(15)} ` },
    { model: "qwen-tts", text: "短" },
    { model: "qwen-tts", text: "a".repeat(40) },
  ])("accepts the $model input boundary", ({ model, text }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate({ model, content: [{ type: "text", text }, audio()] })).not.toThrow();
  });

  it.each<{ label: string; request: GenerateRequest }>([
    { label: "request typo", request: qwenDesignRequest({ meta: { voice_promt: "拼错" } }) },
    {
      label: "raw ref_audio",
      request: qwenDesignRequest({ meta: { voice_prompt: "声音", ref_audio: REFERENCE_URL } }),
    },
    {
      label: "text block meta",
      request: qwenDesignRequest({ content: [{ type: "text", text: "文本", meta: { weight: 1 } }] }),
    },
  ])("rejects invalid meta scope: $label", ({ request }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate(request)).toThrow(GenerationValidationError);
  });

  it.each([
    "",
    "not a URL",
    "data:audio/mpeg;base64,abc",
    "file:///tmp/reference.mp3",
    "s3://bucket/file.mp3",
  ])("rejects unsupported reference URL %s", (url) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate({ model: "qwen-tts", content: [{ type: "text", text: "文本" }, audio(url)] })).toThrow(
      GenerationValidationError,
    );
  });

  it("rejects base64 reference audio through model validation", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "qwen-tts",
        content: [
          { type: "text", text: "文本" },
          { type: "audio", source: { type: "base64", mediaType: "audio/mpeg", data: "abc" } },
        ],
      }),
    ).toThrow("audio source is not supported by qwen-tts: base64");
  });
});

describe("openai.audioSpeech scene3 requests", () => {
  it("sends a built-in voice request with the text exactly as given", async () => {
    const { client, calls } = recordingClient();
    const input = "  [sighs] We missed the last train again. [laughs] Well, at least the night is warm.\n";

    await client.generate({ model: "scene3", content: [{ type: "text", text: input }] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://router.neta.art/v1/audio/speech");
    expect(requestBody(calls[0])).toEqual({ model: "scene3", input });
  });

  it("sends one clone reference as a trimmed URL without a transcript", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "scene3",
      content: [{ type: "text", text: "使用参考音频的声音朗读这段文本。" }, audio(`  ${REFERENCE_URL}\n`)],
    });

    expect(requestBody(calls[0])).toEqual({
      model: "scene3",
      input: "使用参考音频的声音朗读这段文本。",
      metadata: { references: [{ url: REFERENCE_URL }] },
    });
  });

  it("sends one clone reference with its trimmed transcript", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "scene3",
      content: [
        { type: "text", text: "使用参考音频的声音朗读这段文本。" },
        audio(`  ${REFERENCE_URL}\n`, { text: "  参考音频里实际说的话。\n" }),
      ],
    });

    expect(requestBody(calls[0])).toEqual({
      model: "scene3",
      input: "使用参考音频的声音朗读这段文本。",
      metadata: { references: [{ url: REFERENCE_URL, text: "参考音频里实际说的话。" }] },
    });
  });
});

describe("openai.audioSpeech scene3 validation", () => {
  function scene3Request(content: GenerationContentBlock[], overrides: Partial<GenerateRequest> = {}): GenerateRequest {
    return { model: "scene3", content, ...overrides };
  }

  it.each<{ name: string; request: GenerateRequest; message: string }>([
    { name: "zero text blocks", request: scene3Request([]), message: "Missing required text content block" },
    {
      name: "two text blocks",
      request: scene3Request([
        { type: "text", text: "一" },
        { type: "text", text: "二" },
      ]),
      message: "Expected at most 1 text content block(s)",
    },
    {
      name: "blank text",
      request: scene3Request([{ type: "text", text: " \n " }]),
      message: "scene3 requires exactly one non-empty text content block as input",
    },
    {
      name: "two audio blocks",
      request: scene3Request([{ type: "text", text: "文本" }, audio(), audio(SECOND_REFERENCE_URL)]),
      message: "Expected at most 1 audio content block(s)",
    },
    {
      name: "base64 audio source",
      request: scene3Request([
        { type: "text", text: "文本" },
        { type: "audio", source: { type: "base64", mediaType: "audio/mpeg", data: "abc" } },
      ]),
      message: "audio source is not supported by scene3: base64",
    },
    {
      name: "ftp reference URL",
      request: scene3Request([{ type: "text", text: "文本" }, audio("ftp://example.com/reference.mp3")]),
      message: "audio content block 0 URL must be a valid HTTP(S) URL",
    },
    {
      name: "request meta voice_prompt",
      request: scene3Request([{ type: "text", text: "文本" }], { meta: { voice_prompt: "沉稳清晰的男性播音员声音" } }),
      message: "Unknown request.meta field: voice_prompt",
    },
    {
      name: "audio meta weight",
      request: scene3Request([{ type: "text", text: "文本" }, audio(REFERENCE_URL, { weight: 1 })]),
      message: "Unknown audio content meta field: weight",
    },
    {
      name: "empty audio meta.text",
      request: scene3Request([{ type: "text", text: "文本" }, audio(REFERENCE_URL, { text: "" })]),
      message: "audio content block 0 meta.text must be a non-empty string",
    },
    {
      name: "numeric audio meta.text",
      request: scene3Request([{ type: "text", text: "文本" }, audio(REFERENCE_URL, { text: 5 })]),
      message: "audio content block 0 meta.text must be a non-empty string",
    },
  ])("rejects $name before fetch", async ({ request, message }) => {
    const { client, calls } = recordingClient();
    const error = await client.generate(request).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GenerationValidationError);
    expect((error as Error).message).toBe(message);
    expect(calls).toHaveLength(0);
  });

  it("enforces scene3 reference limits inside the adapter hook when a declaration is overridden", () => {
    const declaration = getBuiltinGenerationModel("scene3");
    if (!declaration) throw new Error("scene3 declaration is unavailable");
    const audioSpec = declaration.content.input.find((spec) => spec.type === "audio");
    if (!audioSpec) throw new Error("scene3 audio spec is unavailable");
    audioSpec.max = 2;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() =>
      client.validate(scene3Request([{ type: "text", text: "文本" }, audio(), audio(SECOND_REFERENCE_URL)])),
    ).toThrow("scene3 supports at most one reference audio");
  });
});

describe("openai.audioSpeech adapter success responses", () => {
  it("captures request ID headers in result metadata with the documented priority", async () => {
    const fetchMock = async () =>
      routerSuccess(
        { request_id: "body-request-id" },
        { headers: { "x-request-id": "header-primary", "x-oneapi-request-id": "header-fallback" } },
      );
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    const result = await client.generateResult(qwenDesignRequest());

    expect(result.requestId).toBe("body-request-id");
    expect(result.cost).toBeUndefined();
    expect(result.content[0]?.meta?.request_id).toBe("header-primary");
  });

  it("uses x-oneapi-request-id when x-request-id is absent", async () => {
    const fetchMock = async () => routerSuccess({}, { headers: { "x-oneapi-request-id": "fallback-id" } });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const result = await client.generateResult(qwenDesignRequest());
    expect(result.requestId).toBe("fallback-id");
    expect(result.content[0]?.meta?.request_id).toBe("fallback-id");
  });

  it("accepts other valid audio media types and an omitted size", async () => {
    const fetchMock = async () => routerSuccess({ content_type: "audio/ogg; codecs=opus", size: undefined });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const output = await client.generate(qwenDesignRequest());
    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://router-files.neta.art/files/request/output.mp3" },
        meta: { content_type: "audio/ogg; codecs=opus" },
      },
    ]);
  });

  it.each([
    { label: "empty body", response: () => new Response("", { status: 200 }) },
    { label: "array", response: () => new Response("[]", { status: 200 }) },
    { label: "null", response: () => new Response("null", { status: 200 }) },
    { label: "HTML", response: () => new Response("<html>bad gateway</html>", { status: 200 }) },
    { label: "missing URL", response: () => routerSuccess({ url: "" }) },
    { label: "invalid URL", response: () => routerSuccess({ url: "file:///tmp/output.mp3" }) },
    { label: "wrong media type", response: () => routerSuccess({ media_type: "video" }) },
    { label: "wrong content type", response: () => routerSuccess({ content_type: "application/json" }) },
    { label: "negative size", response: () => routerSuccess({ size: -1 }) },
    { label: "fractional size", response: () => routerSuccess({ size: 1.5 }) },
    {
      label: "binary audio response",
      response: () =>
        new Response(new Uint8Array([0x49, 0x44, 0x33]), { status: 200, headers: { "content-type": "audio/mpeg" } }),
    },
  ])("rejects unsupported 2xx response: $label", async ({ response }) => {
    const fetchMock = async () => {
      const result = response();
      result.headers.set("x-request-id", "malformed-request");
      return result;
    };
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    await expect(client.generate(qwenDesignRequest())).rejects.toMatchObject({
      name: "GenerationProviderError",
      message: "Audio speech provider returned an unsupported success response",
      status: 200,
      details: { requestId: "malformed-request" },
    });
  });

  it("rejects HTTP 204 with its status, empty body, and request ID", async () => {
    const fetchMock = async () =>
      new Response(null, { status: 204, statusText: "No Content", headers: { "x-oneapi-request-id": "request-204" } });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    await expect(client.generate(qwenDesignRequest())).rejects.toMatchObject({
      name: "GenerationProviderError",
      message: "No Content",
      status: 204,
      body: "",
      details: { requestId: "request-204" },
    });
  });
});

describe("openai.audioSpeech adapter errors and diagnostics", () => {
  it("preserves the standard router error envelope", async () => {
    const body = { error: { message: "reference audio is too short", code: "bad_response" } };
    const fetchMock = async () =>
      new Response(JSON.stringify(body), {
        status: 502,
        headers: { "content-type": "application/json", "x-request-id": "request-error" },
      });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    await expect(client.generate(qwenDesignRequest())).rejects.toMatchObject({
      name: "GenerationProviderError",
      message: "reference audio is too short",
      status: 502,
      body: JSON.stringify(body),
      details: { requestId: "request-error", code: "bad_response", error: body },
    } satisfies Partial<GenerationProviderError>);
  });

  it("preserves non-standard JSON without inventing message or code fields", async () => {
    const body = { message: "top-level message is not part of the contract", code: "top-level-code" };
    const rawBody = JSON.stringify(body);
    const fetchMock = async () =>
      new Response(rawBody, { status: 400, headers: { "content-type": "application/problem+json" } });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    await expect(client.generate(qwenDesignRequest())).rejects.toMatchObject({
      message: rawBody,
      status: 400,
      body: rawBody,
      details: { code: undefined, error: body },
    });
  });

  it.each([123, true, null, {}, ""])("ignores a non-string or empty router error code", async (code) => {
    const body = { error: { message: "failed", code } };
    const fetchMock = async () =>
      new Response(JSON.stringify(body), { status: 500, headers: { "content-type": "application/json" } });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    try {
      await client.generate(qwenDesignRequest());
      throw new Error("expected provider error");
    } catch (error) {
      expect(error).toBeInstanceOf(GenerationProviderError);
      expect((error as GenerationProviderError).details?.code).toBeUndefined();
    }
  });

  it("preserves text errors and uses x-oneapi request ID fallback", async () => {
    const fetchMock = async () =>
      new Response("plain text failure", {
        status: 500,
        headers: { "content-type": "text/plain", "x-oneapi-request-id": "fallback-error-id" },
      });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    await expect(client.generate(qwenDesignRequest())).rejects.toMatchObject({
      message: "plain text failure",
      body: "plain text failure",
      details: { requestId: "fallback-error-id", code: undefined },
    });
  });

  it("uses statusText and then the fixed fallback for empty error bodies", async () => {
    const statuses = [
      new Response("", { status: 500, statusText: "Provider Down" }),
      new Response("", { status: 500, statusText: "" }),
    ];
    const fetchMock = async () => statuses.shift() as Response;
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const request = qwenDesignRequest();

    await expect(client.generate(request)).rejects.toThrow("Provider Down");
    await expect(client.generate(request)).rejects.toThrow("Audio speech provider request failed");
  });

  it("converts an aborted fetch to GenerationTimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
      const pending = client.generate(qwenDesignRequest());
      const expectation = expect(pending).rejects.toBeInstanceOf(GenerationTimeoutError);
      await vi.advanceTimersByTimeAsync(210_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps full reference and output URLs in debug events while redacting authorization", async () => {
    const events: unknown[] = [];
    const reference = "https://example.com/reference.mp3?signature=secret#diagnostic";
    const outputUrl = "https://router-files.neta.art/files/output.mp3?signature=result#diagnostic";
    const fetchMock = async () => routerSuccess({ url: outputUrl });
    const client = createGenerationClient({
      apiKey: "key",
      fetch: fetchMock as typeof fetch,
      debug: { enabled: true, logger: (event) => events.push(event) },
    });

    await client.generate({
      model: "qwen-tts",
      content: [{ type: "text", text: "文本" }, audio(reference)],
    });

    const serialized = JSON.stringify(events);
    expect(serialized).toContain(reference);
    expect(serialized).toContain(outputUrl);
    expect(serialized).not.toContain("Bearer key");
    expect(serialized).toContain("[REDACTED]");
  });
});
