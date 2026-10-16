import { describe, expect, it, vi } from "vitest";
import {
  createGenerationClient,
  type GenerateRequest,
  type GenerationContentBlock,
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationValidationError,
  getBuiltinGenerationModel,
} from "../../src/index.js";

const REFERENCE_URL = "https://example.com/reference.mp3";
const SECOND_REFERENCE_URL = "https://example.com/reference-2.mp3";
const EMOTION_URL = "https://example.com/emotion.mp3";

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

  it("maps all Higgs reference modes", async () => {
    const { client, calls } = recordingClient();

    await client.generate({ model: "higgs-tts", content: [{ type: "text", text: "默认音色" }] });
    await client.generate({
      model: "higgs-tts",
      content: [{ type: "text", text: "单参考" }, audio()],
    });
    await client.generate({
      model: "higgs-tts",
      content: [{ type: "text", text: "显式 undefined 权重" }, audio(REFERENCE_URL, { weight: undefined })],
    });
    await client.generate({
      model: "higgs-tts",
      content: [{ type: "text", text: "带权重单参考" }, audio(REFERENCE_URL, { weight: 1 })],
    });
    await client.generate({
      model: "higgs-tts",
      content: [
        { type: "text", text: "多参考" },
        audio(` ${REFERENCE_URL} `, { weight: 0.4 }),
        audio(SECOND_REFERENCE_URL, { weight: 0.6 }),
      ],
    });

    expect(calls.map((call) => requestBody(call))).toEqual([
      { model: "higgs-tts", input: "默认音色" },
      { model: "higgs-tts", input: "单参考", ref_audio: REFERENCE_URL },
      { model: "higgs-tts", input: "显式 undefined 权重", ref_audio: REFERENCE_URL },
      {
        model: "higgs-tts",
        input: "带权重单参考",
        metadata: { references: [{ url: REFERENCE_URL, weight: 1 }] },
      },
      {
        model: "higgs-tts",
        input: "多参考",
        metadata: {
          references: [
            { url: REFERENCE_URL, weight: 0.4 },
            { url: SECOND_REFERENCE_URL, weight: 0.6 },
          ],
        },
      },
    ]);
  });

  it("maps all Breeze capability modes", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "breeze-tts-2",
      content: [{ type: "text", text: "音色设计" }],
      meta: { instruction: "一个沙哑的中年男声" },
    });
    await client.generate({
      model: "breeze-tts-2",
      content: [{ type: "text", text: "音色克隆" }, audio()],
    });
    await client.generate({
      model: "breeze-tts-2",
      content: [{ type: "text", text: "带转写的音色克隆" }, audio()],
      meta: { ref_text: "参考音频里说的那句话" },
    });
    await client.generate({
      model: "breeze-tts-2",
      content: [{ type: "text", text: "音色演绎" }, audio()],
      meta: { instruction: "语速放慢", ref_text: "参考音频里说的那句话" },
    });
    await client.generate({
      model: "breeze-tts-2",
      content: [{ type: "text", text: "默认音色" }],
    });

    expect(calls.map((call) => requestBody(call))).toEqual([
      { model: "breeze-tts-2", input: "音色设计", metadata: { instruction: "一个沙哑的中年男声" } },
      { model: "breeze-tts-2", input: "音色克隆", ref_audio: REFERENCE_URL },
      {
        model: "breeze-tts-2",
        input: "带转写的音色克隆",
        ref_audio: REFERENCE_URL,
        metadata: { ref_text: "参考音频里说的那句话" },
      },
      {
        model: "breeze-tts-2",
        input: "音色演绎",
        ref_audio: REFERENCE_URL,
        metadata: { instruction: "语速放慢", ref_text: "参考音频里说的那句话" },
      },
      { model: "breeze-tts-2", input: "默认音色" },
    ]);
  });

  it("maps all IndexTTS emotion entries and speaking rate", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "index-tts-2.5",
      content: [{ type: "text", text: "克隆" }, audio()],
      meta: { language: "zh" },
    });
    await client.generate({
      model: "index-tts-2.5",
      content: [{ type: "text", text: "情感参考音频" }, audio()],
      meta: { language: "ja", emotion_audio: `  ${EMOTION_URL}\n` },
    });
    await client.generate({
      model: "index-tts-2.5",
      content: [{ type: "text", text: "情感文本" }, audio()],
      meta: { language: "en", emotion_text: "愤怒地说" },
    });
    await client.generate({
      model: "index-tts-2.5",
      content: [{ type: "text", text: "语速" }, audio()],
      meta: { language: "es", duration_factor: 1.2 },
    });

    expect(calls.map((call) => requestBody(call))).toEqual([
      { model: "index-tts-2.5", input: "克隆", ref_audio: REFERENCE_URL, metadata: { language: "zh" } },
      {
        model: "index-tts-2.5",
        input: "情感参考音频",
        ref_audio: REFERENCE_URL,
        metadata: { language: "ja", emotion_audio: EMOTION_URL },
      },
      {
        model: "index-tts-2.5",
        input: "情感文本",
        ref_audio: REFERENCE_URL,
        metadata: { language: "en", emotion_text: "愤怒地说" },
      },
      {
        model: "index-tts-2.5",
        input: "语速",
        ref_audio: REFERENCE_URL,
        metadata: { language: "es", duration_factor: 1.2 },
      },
    ]);
  });

  it("keeps an explicit neutral speaking rate distinguishable from an omitted one", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "index-tts-2.5",
      content: [{ type: "text", text: "显式 1.0" }, audio()],
      meta: { language: "zh", duration_factor: 1 },
    });
    await client.generate({
      model: "index-tts-2.5",
      content: [{ type: "text", text: "没传" }, audio()],
      meta: { language: "zh" },
    });

    expect(calls.map((call) => requestBody(call))).toEqual([
      {
        model: "index-tts-2.5",
        input: "显式 1.0",
        ref_audio: REFERENCE_URL,
        metadata: { language: "zh", duration_factor: 1 },
      },
      { model: "index-tts-2.5", input: "没传", ref_audio: REFERENCE_URL, metadata: { language: "zh" } },
    ]);
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
    await expect(client.generate({ model: "higgs-tts", content })).rejects.toBeInstanceOf(GenerationValidationError);
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

  it("enforces Higgs reference limits inside the adapter hook when a declaration is overridden", () => {
    const declaration = getBuiltinGenerationModel("higgs-tts");
    if (!declaration) throw new Error("higgs-tts declaration is unavailable");
    const audioSpec = declaration.content.input.find((spec) => spec.type === "audio");
    if (!audioSpec) throw new Error("higgs-tts audio spec is unavailable");
    audioSpec.max = 17;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() =>
      client.validate({
        model: "higgs-tts",
        content: [
          { type: "text", text: "文本" },
          ...Array.from({ length: 17 }, (_, index) =>
            audio(`https://example.com/reference-${index}.mp3`, { weight: 1 }),
          ),
        ],
      }),
    ).toThrow("supports at most 16 references");
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
      label: "raw references",
      request: {
        model: "higgs-tts",
        content: [{ type: "text", text: "文本" }],
        meta: { references: [{ url: REFERENCE_URL, weight: 1 }] },
      },
    },
    {
      label: "text block meta",
      request: {
        model: "higgs-tts",
        content: [{ type: "text", text: "文本", meta: { weight: 1 } }],
      },
    },
    {
      label: "Higgs request voice prompt",
      request: {
        model: "higgs-tts",
        content: [{ type: "text", text: "文本" }],
        meta: { voice_prompt: "声音" },
      },
    },
  ])("rejects invalid meta scope: $label", ({ request }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate(request)).toThrow(GenerationValidationError);
  });

  it.each([
    null,
    "1",
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid single-reference Higgs weight %s", (weight) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "higgs-tts",
        content: [{ type: "text", text: "文本" }, audio(REFERENCE_URL, { weight })],
      }),
    ).toThrow("meta.weight must be a finite positive number");
  });

  it.each([
    {},
    { weight: undefined },
    { weight: 0 },
  ])("rejects missing or invalid multi-reference Higgs weights", (meta) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "higgs-tts",
        content: [
          { type: "text", text: "文本" },
          audio(REFERENCE_URL, meta),
          audio(SECOND_REFERENCE_URL, { weight: 1 }),
        ],
      }),
    ).toThrow("meta.weight must be a finite positive number");
  });

  it.each([
    "",
    "not a URL",
    "data:audio/mpeg;base64,abc",
    "file:///tmp/reference.mp3",
    "s3://bucket/file.mp3",
  ])("rejects unsupported reference URL %s", (url) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }, audio(url)] }),
    ).toThrow(GenerationValidationError);
  });

  it("rejects base64 reference audio through model validation", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "higgs-tts",
        content: [
          { type: "text", text: "文本" },
          { type: "audio", source: { type: "base64", mediaType: "audio/mpeg", data: "abc" } },
        ],
      }),
    ).toThrow("audio source is not supported by higgs-tts: base64");
  });

  it.each<{ label: string; request: GenerateRequest }>([
    {
      label: "voice design",
      request: {
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }],
        meta: { instruction: "一个沙哑的中年男声" },
      },
    },
    {
      label: "default voice",
      request: { model: "breeze-tts-2", content: [{ type: "text", text: "文本" }] },
    },
    {
      label: "voice clone",
      request: { model: "breeze-tts-2", content: [{ type: "text", text: "文本" }, audio()] },
    },
    {
      label: "voice clone with transcript",
      request: {
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { ref_text: "参考音频里说的那句话" },
      },
    },
    {
      label: "voice performance",
      request: {
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { instruction: "语速放慢" },
      },
    },
    {
      label: "voice performance with transcript",
      request: {
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { instruction: "语速放慢", ref_text: "参考音频里说的那句话" },
      },
    },
  ])("accepts Breeze $label", ({ request }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate(request)).not.toThrow();
  });

  it.each([
    { label: "ascii", text: "a".repeat(1001) },
    { label: "astral", text: "😀".repeat(1001) },
  ])("rejects Breeze $label input above 1000 Unicode code points", ({ text }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate({ model: "breeze-tts-2", content: [{ type: "text", text }, audio()] })).toThrow(
      "breeze-tts-2 accepts input of at most 1000 Unicode code points",
    );
  });

  it.each([
    { label: "ascii", text: "a".repeat(1000) },
    { label: "astral", text: ` ${"😀".repeat(1000)} ` },
  ])("accepts the Breeze $label input boundary", ({ text }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate({ model: "breeze-tts-2", content: [{ type: "text", text }, audio()] })).not.toThrow();
  });

  it("rejects a Breeze transcript without reference audio", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }],
        meta: { ref_text: "参考音频里说的那句话" },
      }),
    ).toThrow("breeze-tts-2 meta.ref_text requires one reference audio");
  });

  it("rejects a second Breeze reference audio", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }, audio(), audio(SECOND_REFERENCE_URL)],
      }),
    ).toThrow(GenerationValidationError);
  });

  it("enforces Breeze reference limits inside the adapter hook when a declaration is overridden", () => {
    const declaration = getBuiltinGenerationModel("breeze-tts-2");
    if (!declaration) throw new Error("breeze-tts-2 declaration is unavailable");
    const audioSpec = declaration.content.input.find((spec) => spec.type === "audio");
    if (!audioSpec) throw new Error("breeze-tts-2 audio spec is unavailable");
    audioSpec.max = 2;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() =>
      client.validate({
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }, audio(), audio(SECOND_REFERENCE_URL)],
      }),
    ).toThrow("supports at most one reference audio");
  });

  it.each<{ label: string; request: GenerateRequest }>([
    {
      label: "emotion from the reference audio",
      request: {
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh" },
      },
    },
    {
      label: "emotion from an emotion reference audio",
      request: {
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", emotion_audio: EMOTION_URL },
      },
    },
    {
      label: "emotion from emotion text",
      request: {
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", emotion_text: "愤怒地说" },
      },
    },
  ])("accepts IndexTTS $label", ({ request }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate(request)).not.toThrow();
  });

  it("rejects both IndexTTS emotion entries at once", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", emotion_audio: EMOTION_URL, emotion_text: "愤怒地说" },
      }),
    ).toThrow("index-tts-2.5 meta.emotion_audio and meta.emotion_text are mutually exclusive");
  });

  it("rejects an IndexTTS request without reference audio", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }],
        meta: { language: "zh" },
      }),
    ).toThrow(GenerationValidationError);
  });

  it("rejects a second IndexTTS reference audio", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio(), audio(SECOND_REFERENCE_URL)],
        meta: { language: "zh" },
      }),
    ).toThrow(GenerationValidationError);
  });

  it.each([
    { label: "no reference audio", count: 0, message: "index-tts-2.5 requires one reference audio" },
    { label: "two reference audio blocks", count: 2, message: "supports at most one reference audio" },
  ])("enforces IndexTTS $label inside the adapter hook when a declaration is overridden", ({ count, message }) => {
    const declaration = getBuiltinGenerationModel("index-tts-2.5");
    if (!declaration) throw new Error("index-tts-2.5 declaration is unavailable");
    const audioSpec = declaration.content.input.find((spec) => spec.type === "audio");
    if (!audioSpec) throw new Error("index-tts-2.5 audio spec is unavailable");
    audioSpec.required = false;
    audioSpec.min = 0;
    audioSpec.max = 2;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [
          { type: "text", text: "文本" },
          ...Array.from({ length: count }, (_, index) => audio(`https://example.com/reference-${index}.mp3`)),
        ],
        meta: { language: "zh" },
      }),
    ).toThrow(message);
  });

  it.each([0.5, 1, 2])("accepts the IndexTTS speaking rate boundary %s", (durationFactor) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", duration_factor: durationFactor },
      }),
    ).not.toThrow();
  });

  it.each([
    { durationFactor: 0.4, message: "meta.duration_factor must be >= 0.5" },
    { durationFactor: 2.1, message: "meta.duration_factor must be <= 2" },
  ])("rejects the out-of-range IndexTTS speaking rate $durationFactor", ({ durationFactor, message }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", duration_factor: durationFactor },
      }),
    ).toThrow(message);
  });

  it.each(["zh", "en", "ja", "es", "ar"])("accepts the IndexTTS language %s", (language) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language },
      }),
    ).not.toThrow();
  });

  it("rejects an unsupported IndexTTS language", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "fr" },
      }),
    ).toThrow("meta.language must be one of: zh, en, ja, es, ar");
  });

  it("rejects an IndexTTS request without a language", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
      }),
    ).toThrow("Missing required meta: language");
  });

  it.each([
    "",
    " ",
    "not a URL",
    "data:audio/mpeg;base64,abc",
    "file:///tmp/emotion.mp3",
  ])("rejects unsupported IndexTTS emotion audio %s", (emotionAudio) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", emotion_audio: emotionAudio },
      }),
    ).toThrow("index-tts-2.5 meta.emotion_audio");
  });

  it.each<{ label: string; request: GenerateRequest }>([
    {
      label: "Breeze voice prompt",
      request: {
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }],
        meta: { voice_prompt: "沙哑男声" },
      },
    },
    {
      label: "Breeze audio block transcript",
      request: {
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }, audio(REFERENCE_URL, { ref_text: "转写" })],
      },
    },
    {
      label: "Breeze blank instruction",
      request: {
        model: "breeze-tts-2",
        content: [{ type: "text", text: "文本" }],
        meta: { instruction: " \n " },
      },
    },
    {
      label: "IndexTTS instruction",
      request: {
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", instruction: "语速放慢" },
      },
    },
    {
      label: "IndexTTS blank emotion text",
      request: {
        model: "index-tts-2.5",
        content: [{ type: "text", text: "文本" }, audio()],
        meta: { language: "zh", emotion_text: " \n " },
      },
    },
  ])("rejects invalid meta scope: $label", ({ request }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate(request)).toThrow(GenerationValidationError);
  });

  it.each([
    { model: "breeze-tts-2", meta: {} },
    { model: "index-tts-2.5", meta: { language: "zh" } },
  ])("accepts short $model input without a length floor", ({ model, meta }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate({ model, content: [{ type: "text", text: "短" }, audio()], meta })).not.toThrow();
  });

  it("keeps rejecting audio speech models the adapter does not know", () => {
    const declaration = getBuiltinGenerationModel("higgs-tts");
    if (!declaration) throw new Error("higgs-tts declaration is unavailable");
    declaration.model = "unknown-tts";
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() => client.validate({ model: "unknown-tts", content: [{ type: "text", text: "文本" }] })).toThrow(
      "Unsupported audio speech model: unknown-tts",
    );
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

    const result = await client.generateResult({
      model: "higgs-tts",
      content: [{ type: "text", text: "文本" }],
    });

    expect(result.requestId).toBe("body-request-id");
    expect(result.cost).toBeUndefined();
    expect(result.content[0]?.meta?.request_id).toBe("header-primary");
  });

  it("uses x-oneapi-request-id when x-request-id is absent", async () => {
    const fetchMock = async () => routerSuccess({}, { headers: { "x-oneapi-request-id": "fallback-id" } });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const result = await client.generateResult({
      model: "higgs-tts",
      content: [{ type: "text", text: "文本" }],
    });
    expect(result.requestId).toBe("fallback-id");
    expect(result.content[0]?.meta?.request_id).toBe("fallback-id");
  });

  it("accepts other valid audio media types and an omitted size", async () => {
    const fetchMock = async () => routerSuccess({ content_type: "audio/ogg; codecs=opus", size: undefined });
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const output = await client.generate({
      model: "higgs-tts",
      content: [{ type: "text", text: "文本" }],
    });
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
    await expect(
      client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] }),
    ).rejects.toMatchObject({
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
    await expect(
      client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] }),
    ).rejects.toMatchObject({
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

    await expect(
      client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] }),
    ).rejects.toMatchObject({
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

    await expect(
      client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] }),
    ).rejects.toMatchObject({
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
      await client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] });
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
    await expect(
      client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] }),
    ).rejects.toMatchObject({
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
    const request = { model: "higgs-tts", content: [{ type: "text" as const, text: "文本" }] };

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
      const pending = client.generate({ model: "higgs-tts", content: [{ type: "text", text: "文本" }] });
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
      model: "higgs-tts",
      content: [{ type: "text", text: "文本" }, audio(reference, { weight: 1 })],
    });

    const serialized = JSON.stringify(events);
    expect(serialized).toContain(reference);
    expect(serialized).toContain(outputUrl);
    expect(serialized).not.toContain("Bearer key");
    expect(serialized).toContain("[REDACTED]");
  });
});
