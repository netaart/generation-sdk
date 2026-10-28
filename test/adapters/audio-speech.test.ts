import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
const QWEN_TEXT = "这是用于语音合成测试的一整句中文示例文本。";

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
    model: "qwen-audio-3.1-tts-flash",
    content: [{ type: "text", text: QWEN_TEXT }],
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
    const input = "  原样保留的朗读文本内容，不应被修改。\n";
    const voicePrompt = "  沉稳清晰的声音。\n";

    const output = await client.generate({
      model: "qwen-audio-3.1-tts-flash",
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
      model: "qwen-audio-3.1-tts-flash",
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
      model: "qwen-audio-3.1-tts-flash",
      content: [{ type: "text", text: QWEN_TEXT }, audio(`  ${REFERENCE_URL}\n`)],
    });

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      ref_audio: REFERENCE_URL,
    });
  });

  it("rejects the retired preview_text as an unknown request.meta field before fetch", async () => {
    const fetchMock = vi.fn(async () => routerSuccess());
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    await expect(
      client.generate(qwenDesignRequest({ meta: { voice_prompt: "清晰女声", preview_text: "旧字段不应发送" } })),
    ).rejects.toThrow("Unknown request.meta field: preview_text");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "qwen-tts",
    "qwen-audio-3.0-tts-plus",
    "qwen-audio-3.0-tts-flash",
  ])("rejects the retired Qwen id %s as an unavailable model before fetch", async (model) => {
    const fetchMock = vi.fn(async () => routerSuccess());
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    await expect(client.generate({ model, content: [{ type: "text", text: QWEN_TEXT }] })).rejects.toMatchObject({
      constructor: GenerationConfigError,
      message: `Generation model is unavailable: ${model}`,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.getModel(model)).toBeNull();
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
    await expect(client.generate({ model: "qwen-audio-3.1-tts-flash", content })).rejects.toBeInstanceOf(
      GenerationValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the retired preview_text in request.meta and request.metadata, with or without a voice source", () => {
    const client = createGenerationClient({ apiKey: "key" });
    const content: GenerationContentBlock[] = [{ type: "text", text: QWEN_TEXT }];

    expect(() =>
      client.validate({ model: "qwen-audio-3.1-tts-flash", content, meta: { preview_text: "已经失效的文本来源" } }),
    ).toThrow("Unknown request.meta field: preview_text");
    expect(() =>
      client.validate({
        model: "qwen-audio-3.1-tts-flash",
        content,
        metadata: { voice_prompt: "清晰女声", preview_text: "已经失效的文本来源" },
      }),
    ).toThrow("Unknown request.metadata field: preview_text");
  });

  it.each([
    {
      name: "neither voice source",
      request: qwenDesignRequest({ meta: {} }),
    },
    {
      name: "both voice sources",
      request: qwenDesignRequest({
        content: [{ type: "text", text: QWEN_TEXT }, audio()],
      }),
    },
    {
      name: "blank voice prompt",
      request: qwenDesignRequest({ meta: { voice_prompt: " \n " } }),
    },
    {
      name: "audio weight",
      request: qwenDesignRequest({
        content: [{ type: "text", text: QWEN_TEXT }, audio(REFERENCE_URL, { weight: 1 })],
        meta: {},
      }),
    },
  ])("rejects Qwen $name", ({ request }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() => client.validate(request)).toThrow(GenerationValidationError);
  });

  it("enforces Qwen reference limits inside the adapter hook when a declaration is overridden", () => {
    const declaration = getBuiltinGenerationModel("qwen-audio-3.1-tts-flash");
    if (!declaration) throw new Error("qwen-audio-3.1-tts-flash declaration is unavailable");
    const audioSpec = declaration.content.input.find((spec) => spec.type === "audio");
    if (!audioSpec) throw new Error("qwen-audio-3.1-tts-flash audio spec is unavailable");
    audioSpec.max = 2;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() =>
      client.validate({
        model: "qwen-audio-3.1-tts-flash",
        content: [{ type: "text", text: QWEN_TEXT }, audio(), audio(SECOND_REFERENCE_URL)],
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
    { text: "a".repeat(14) },
    { text: "😀".repeat(14) },
  ])("rejects qwen-audio-3.1-tts-flash input below 15 Unicode code points ($text)", ({ text }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({ model: "qwen-audio-3.1-tts-flash", content: [{ type: "text", text }, audio()] }),
    ).toThrow("requires input of at least 15 Unicode code points");
  });

  it.each([
    { text: "a".repeat(15) },
    { text: ` ${"😀".repeat(15)} ` },
  ])("accepts the qwen-audio-3.1-tts-flash input boundary ($text)", ({ text }) => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({ model: "qwen-audio-3.1-tts-flash", content: [{ type: "text", text }, audio()] }),
    ).not.toThrow();
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
    expect(() =>
      client.validate({ model: "qwen-audio-3.1-tts-flash", content: [{ type: "text", text: QWEN_TEXT }, audio(url)] }),
    ).toThrow(GenerationValidationError);
  });

  it("rejects base64 reference audio through model validation", () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "qwen-audio-3.1-tts-flash",
        content: [
          { type: "text", text: QWEN_TEXT },
          { type: "audio", source: { type: "base64", mediaType: "audio/mpeg", data: "abc" } },
        ],
      }),
    ).toThrow("audio source is not supported by qwen-audio-3.1-tts-flash: base64");
  });
});

describe("openai.audioSpeech Qwen instructions and seed", () => {
  it("sends parameters.instructions as the top-level instructions, trimmed, on a designed voice", async () => {
    const { client, calls } = recordingClient();

    await client.generate(qwenDesignRequest({ parameters: { instructions: "  用非常缓慢、低沉的语气说\n" } }));

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      instructions: "用非常缓慢、低沉的语气说",
      metadata: { voice_prompt: "沉稳清晰的男性播音员声音" },
    });
  });

  it.each<{ name: string; parameters?: Record<string, unknown> }>([
    { name: "absent" },
    { name: "an empty parameters object", parameters: {} },
    { name: "an empty string", parameters: { instructions: "" } },
    { name: "only whitespace", parameters: { instructions: " \n\t " } },
  ])("sends no instructions key when instructions is $name", async ({ parameters }) => {
    const { client, calls } = recordingClient();

    await client.generate(qwenDesignRequest(parameters ? { parameters } : {}));

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      metadata: { voice_prompt: "沉稳清晰的男性播音员声音" },
    });
  });

  it("sends parameters.instructions as the top-level instructions on a cloned voice", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "qwen-audio-3.1-tts-flash",
      content: [{ type: "text", text: QWEN_TEXT }, audio(`  ${REFERENCE_URL}\n`)],
      parameters: { instructions: "请用非常缓慢的语速说话。" },
    });

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      ref_audio: REFERENCE_URL,
      instructions: "请用非常缓慢的语速说话。",
    });
  });

  it("sends parameters.seed as metadata.seed next to metadata.voice_prompt on a designed voice", async () => {
    const { client, calls } = recordingClient();

    await client.generate(qwenDesignRequest({ parameters: { seed: 42 } }));

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      metadata: { voice_prompt: "沉稳清晰的男性播音员声音", seed: 42 },
    });
  });

  it("sends seed 0 as metadata.seed and sends metadata.seed alone on a cloned voice", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "qwen-audio-3.1-tts-flash",
      content: [{ type: "text", text: QWEN_TEXT }, audio()],
      parameters: { seed: 0 },
    });

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      ref_audio: REFERENCE_URL,
      metadata: { seed: 0 },
    });
  });

  it("takes audio meta.role reference_audio on a Qwen clone and does not send it", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "qwen-audio-3.1-tts-flash",
      content: [{ type: "text", text: QWEN_TEXT }, audio(REFERENCE_URL, { role: "reference_audio" })],
    });

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      ref_audio: REFERENCE_URL,
    });
  });

  it.each(["first_frame", "", 7])("rejects Qwen audio meta.role %j before fetch", async (role) => {
    const fetchMock = vi.fn(async () => routerSuccess());
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    await expect(
      client.generate({
        model: "qwen-audio-3.1-tts-flash",
        content: [{ type: "text", text: QWEN_TEXT }, audio(REFERENCE_URL, { role })],
      }),
    ).rejects.toThrow(`audio role is not supported by qwen-audio-3.1-tts-flash: ${String(role)}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still rejects other Qwen audio meta fields", () => {
    const client = createGenerationClient({ apiKey: "key" });

    expect(() =>
      client.validate({
        model: "qwen-audio-3.1-tts-flash",
        content: [{ type: "text", text: QWEN_TEXT }, audio(REFERENCE_URL, { role: "reference_audio", text: "转写" })],
      }),
    ).toThrow("Unknown audio content meta field: text");
  });

  it("declares an example that uses parameters.instructions, and it passes validation", () => {
    const client = createGenerationClient({ apiKey: "key" });
    const example = getBuiltinGenerationModel("qwen-audio-3.1-tts-flash")?.examples?.find(
      (candidate) => candidate.request.parameters?.instructions !== undefined,
    );

    expect(example?.request.parameters).toEqual({ instructions: "语速放慢，声音压低，带一点疲惫" });
    expect(() => client.validate(example?.request as GenerateRequest)).not.toThrow();
  });

  it("documents Qwen instructions and seed in the README's Text to speech section", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## Text to speech"), readme.indexOf("`scene3` takes"));

    expect(section).toContain(
      "- Qwen: `voice_prompt` design OR one-reference clone via `qwen-audio-3.1-tts-flash`; requires at least 15 Unicode code points. Optional `parameters.instructions` directs how the whole text is spoken (tone, emotion, pace, dialect or role) for both kinds of voice; optional `parameters.seed` (0 to 65535) is passed to the model.",
    );
    expect(section).toContain('parameters: { instructions: "语速放慢，声音压低，带一点疲惫" }');
  });

  it("sends the design body with instructions and seed together", async () => {
    const { client, calls } = recordingClient();

    await client.generate(qwenDesignRequest({ parameters: { instructions: "低声耳语", seed: 65535 } }));

    expect(requestBody(calls[0])).toEqual({
      model: "qwen-audio-3.1-tts-flash",
      input: QWEN_TEXT,
      instructions: "低声耳语",
      metadata: { voice_prompt: "沉稳清晰的男性播音员声音", seed: 65535 },
    });
  });

  it.each([-1, 65536, 1.5])("rejects seed %s through the declaration before fetch", async (seed) => {
    const fetchMock = vi.fn(async () => routerSuccess());
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    await expect(client.generate(qwenDesignRequest({ parameters: { seed } }))).rejects.toBeInstanceOf(
      GenerationValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("declares instructions and seed as optional parameters, with the agreed wording", () => {
    const parameters = getBuiltinGenerationModel("qwen-audio-3.1-tts-flash")?.parameters;

    expect(parameters).toEqual({
      instructions: {
        type: "string",
        optional: true,
        description:
          "Natural-language direction for how the whole text is spoken: tone, emotion, pace, dialect or role. Works with a designed and a cloned voice.",
      },
      seed: { type: "integer", optional: true, min: 0, max: 65535, description: "Random seed, passed to the model." },
    });
  });
});

describe("openai.audioSpeech Qwen retired alias qwen-audio-3.0-tts-plus", () => {
  const FLASH = "qwen-audio-3.1-tts-flash";
  const RETIRED_ALIAS = "qwen-audio-3.0-tts-plus";

  // Cohub's platform config declares the retired id with the same shape as the flash model; the SDK never declares it.
  function platformDeclaration(model: string): GenerationModelDeclaration {
    const declaration = getBuiltinGenerationModel(FLASH);
    if (!declaration) throw new Error(`${FLASH} declaration is unavailable`);
    return { ...structuredClone(declaration), model };
  }

  function platformClient(model: string, fetchMock: typeof fetch = vi.fn() as unknown as typeof fetch) {
    return createGenerationClient({
      models: [platformDeclaration(model)],
      includeBuiltinModels: false,
      apiKey: "key",
      fetch: fetchMock,
    });
  }

  const designWithDirections = (model: string): GenerateRequest => ({
    model,
    content: [{ type: "text", text: QWEN_TEXT }],
    meta: { voice_prompt: "沉稳清晰的男性播音员声音" },
    parameters: { instructions: " 低声耳语 ", seed: 7 },
  });
  const cloneWithDirections = (model: string): GenerateRequest => ({
    model,
    content: [{ type: "text", text: QWEN_TEXT }, audio(REFERENCE_URL, { role: "reference_audio" })],
    parameters: { instructions: "请慢一点" },
  });

  it.each([
    { name: "design with instructions and seed", request: designWithDirections },
    { name: "clone with instructions", request: cloneWithDirections },
  ])("builds the same payload as the flash model, apart from model: $name", async ({ request }) => {
    const sent: string[] = [];
    const fetchMock = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return routerSuccess();
    }) as typeof fetch;

    await platformClient(RETIRED_ALIAS, fetchMock).generate(request(RETIRED_ALIAS));
    await platformClient(FLASH, fetchMock).generate(request(FLASH));

    const [aliasBody, flashBody] = sent.map((body) => JSON.parse(body) as Record<string, unknown>);
    expect(aliasBody?.model).toBe(RETIRED_ALIAS);
    expect(flashBody?.model).toBe(FLASH);
    expect({ ...aliasBody, model: FLASH }).toEqual(flashBody);
  });

  it("applies the flash validation to the retired alias", () => {
    const client = platformClient(RETIRED_ALIAS);

    expect(() =>
      client.validate({
        model: RETIRED_ALIAS,
        content: [{ type: "text", text: "太短" }],
        meta: { voice_prompt: "声音" },
      }),
    ).toThrow("requires input of at least 15 Unicode code points");
    expect(() =>
      client.validate({
        model: RETIRED_ALIAS,
        content: [{ type: "text", text: QWEN_TEXT }],
        meta: { voice_prompt: "声音", preview_text: "旧字段" },
      }),
    ).toThrow("Unknown request.meta field: preview_text");
  });

  it("does not declare the retired alias", () => {
    expect(getBuiltinGenerationModel(RETIRED_ALIAS)).toBeNull();
    expect(createGenerationClient({ apiKey: "key" }).getModel(RETIRED_ALIAS)).toBeNull();
  });

  it.each([
    "qwen-tts",
    "qwen-audio-3.0-tts-flash",
  ])("still rejects a platform declaration of %s at the audio speech adapter", (model) => {
    const client = platformClient(model);

    expect(() => client.validate(qwenDesignRequest({ model }))).toThrow(`Unsupported audio speech model: ${model}`);
  });
});

describe("openai.audioSpeech scene3 requests", () => {
  it("sends a built-in voice request with the text exactly as given and the default drama_value", async () => {
    const { client, calls } = recordingClient();
    const input = "  [sighs] We missed the last train again. [laughs] Well, at least the night is warm.\n";

    await client.generate({ model: "scene3", content: [{ type: "text", text: input }] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://router.neta.art/v1/audio/speech");
    expect(requestBody(calls[0])).toEqual({ model: "scene3", input, metadata: { drama_value: 0.5 } });
  });

  it("sends an explicit drama_value with the built-in voice", async () => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "scene3",
      content: [{ type: "text", text: "文本" }],
      parameters: { drama_value: 0.2 },
    });

    expect(requestBody(calls[0])).toEqual({ model: "scene3", input: "文本", metadata: { drama_value: 0.2 } });
  });

  it.each([0, 0.8, 1])("sends an explicit drama_value of %s next to the references", async (dramaValue) => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "scene3",
      content: [{ type: "text", text: "使用参考音频的声音朗读这段文本。" }, audio()],
      parameters: { drama_value: dramaValue },
    });

    expect(requestBody(calls[0])).toEqual({
      model: "scene3",
      input: "使用参考音频的声音朗读这段文本。",
      metadata: { references: [{ url: REFERENCE_URL }], drama_value: dramaValue },
    });
  });

  it.each([2, 16])("sends %i references in order, each with its own transcript when given", async (count) => {
    const { client, calls } = recordingClient();
    const urls = Array.from({ length: count }, (_, index) => `https://example.com/speaker-${index}.mp3`);
    const input = urls.map((_, index) => `<|speaker:${index}|>第${index}句台词。`).join("");

    await client.generate({
      model: "scene3",
      content: [
        { type: "text", text: input },
        ...urls.map((url, index) => (index % 2 === 0 ? audio(url, { text: `  第${index}段录音。\n` }) : audio(url))),
      ],
    });

    expect(requestBody(calls[0])).toEqual({
      model: "scene3",
      input,
      metadata: {
        references: urls.map((url, index) => (index % 2 === 0 ? { url, text: `第${index}段录音。` } : { url })),
        drama_value: 0.5,
      },
    });
  });

  it.each<{ name: string; parameters?: Record<string, unknown>; metadata: Record<string, unknown> }>([
    {
      name: "seed 0",
      parameters: { seed: 0 },
      metadata: { references: [{ url: REFERENCE_URL }], drama_value: 0.5, seed: 0 },
    },
    {
      name: "seed 7",
      parameters: { seed: 7 },
      metadata: { references: [{ url: REFERENCE_URL }], drama_value: 0.5, seed: 7 },
    },
    {
      name: "seed 2^53 - 1",
      parameters: { seed: 9007199254740991 },
      metadata: { references: [{ url: REFERENCE_URL }], drama_value: 0.5, seed: 9007199254740991 },
    },
    { name: "no seed", metadata: { references: [{ url: REFERENCE_URL }], drama_value: 0.5 } },
  ])("sends seed in metadata only when it is given ($name)", async ({ parameters, metadata }) => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "scene3",
      content: [{ type: "text", text: "文本" }, audio()],
      ...(parameters ? { parameters } : {}),
    });

    expect(requestBody(calls[0])).toEqual({ model: "scene3", input: "文本", metadata });
  });

  it.each<{ name: string; parameters?: Record<string, unknown>; instructions?: string }>([
    {
      name: "given",
      parameters: { instructions: "Calm and warm, like a bedtime story." },
      instructions: "Calm and warm, like a bedtime story.",
    },
    { name: "not given" },
  ])("sends instructions at the top level only when they are $name", async ({ parameters, instructions }) => {
    const { client, calls } = recordingClient();

    await client.generate({
      model: "scene3",
      content: [{ type: "text", text: "文本" }],
      ...(parameters ? { parameters } : {}),
    });

    expect(requestBody(calls[0])).toEqual({
      model: "scene3",
      input: "文本",
      metadata: { drama_value: 0.5 },
      ...(instructions === undefined ? {} : { instructions }),
    });
  });

  it.each([
    { name: "300 characters", instructions: "字".repeat(300) },
    { name: "300 characters outside the BMP", instructions: "😀".repeat(300) },
    { name: "300 characters besides [ ] < > | and surrounding spaces", instructions: ` [${"字".repeat(300)}] <|> \n` },
  ])("accepts instructions of $name and sends them as given", async ({ instructions }) => {
    const { client, calls } = recordingClient();

    await client.generate({ model: "scene3", content: [{ type: "text", text: "文本" }], parameters: { instructions } });

    expect(requestBody(calls[0])?.instructions).toBe(instructions);
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
      metadata: { references: [{ url: REFERENCE_URL }], drama_value: 0.5 },
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
      metadata: { references: [{ url: REFERENCE_URL, text: "参考音频里实际说的话。" }], drama_value: 0.5 },
    });
  });

  // The cohub CLI writes `--audio reference_audio=<url>` as an audio block with meta.role "reference_audio".
  it.each<{ name: string; meta: Record<string, unknown>; reference: Record<string, unknown> }>([
    { name: "alone", meta: { role: "reference_audio" }, reference: { url: REFERENCE_URL } },
    {
      name: "next to meta.text",
      meta: { role: "reference_audio", text: "参考音频里实际说的话。" },
      reference: { url: REFERENCE_URL, text: "参考音频里实际说的话。" },
    },
  ])("takes meta.role reference_audio $name and does not send it", async ({ meta, reference }) => {
    const { client, calls } = recordingClient();

    await client.generate({ model: "scene3", content: [{ type: "text", text: "文本" }, audio(REFERENCE_URL, meta)] });

    expect(requestBody(calls[0])).toEqual({
      model: "scene3",
      input: "文本",
      metadata: { references: [reference], drama_value: 0.5 },
    });
  });
});

describe("openai.audioSpeech scene3 validation", () => {
  function scene3Request(content: GenerationContentBlock[], overrides: Partial<GenerateRequest> = {}): GenerateRequest {
    return { model: "scene3", content, ...overrides };
  }

  function speakerReferences(count: number): GenerationContentBlock[] {
    return Array.from({ length: count }, (_, index) => audio(`https://example.com/speaker-${index}.mp3`));
  }

  // The wording drama3-launch agreed for drama_value (ticket 02a); the declaration and the README carry it as is.
  const DRAMA_VALUE_DESCRIPTION =
    "How lively the delivery is, from 0 to 1 (default 0.5, the recommended setting). Higher values give more varied intonation and fewer pauses; lower values are steadier. The effect is subtle: for a clear change of tone, use `instructions` or direction cues in the text. With the same `seed`, `drama_value` and input, the audio is the same.";

  async function readmeScene3Section(): Promise<string> {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    return readme.slice(readme.indexOf("`scene3` takes"), readme.indexOf("## Video generation"));
  }

  // What the text input and the reference recordings must tell a caller (drama3-launch, after the parameter table).
  const TEXT_FACTS = [
    "about 80 languages",
    "<whisper>…</whisper>",
    "<slow>…</slow>",
    "<emphasis>…</emphasis>",
    "Direction: … Line: …",
    "free natural language",
    "only examples",
    "are hints and are not spoken",
    "round parentheses",
    "spoken as written",
    "square brackets",
    "about 21.5 per second of audio",
  ];
  const REFERENCE_FACTS = [
    "1 to 20 s",
    "under 1 s is rejected",
    "over 20 s is cut at a quiet point",
    "only the part before the cut is kept",
  ];

  it("declares drama_value from 0 to 1 with 0.5 as default, and up to 16 references", () => {
    const declaration = getBuiltinGenerationModel("scene3");

    expect(declaration?.parameters?.drama_value).toMatchObject({ type: "number", min: 0, max: 1, default: 0.5 });
    expect(declaration?.content.input.find((spec) => spec.type === "audio")?.max).toBe(16);
  });

  it("describes drama_value in the agreed words", () => {
    expect(getBuiltinGenerationModel("scene3")?.parameters?.drama_value?.description).toBe(DRAMA_VALUE_DESCRIPTION);
  });

  it("names the inputs it does not take and the controls the text can carry", () => {
    const declaration = getBuiltinGenerationModel("scene3");
    const text = declaration?.content.input.find((spec) => spec.type === "text")?.description ?? "";

    expect(declaration?.description).toContain(
      "Not supported: speed, response_format, voice, voice_prompt, stream, or a separate language parameter (write the language in the text, e.g. [language: ja]).",
    );
    for (const control of [
      "[sighs]",
      "<whisper>…</whisper>",
      "[style] prefix",
      "<|speaker:N|>",
      "[language: xx]",
      "[audio tokens: N]",
    ]) {
      expect(text, control).toContain(control);
    }
  });

  it("tells what the text can carry and which reference recordings work", () => {
    const declaration = getBuiltinGenerationModel("scene3");
    const text = declaration?.content.input.find((spec) => spec.type === "text")?.description ?? "";
    const references = declaration?.content.input.find((spec) => spec.type === "audio")?.description ?? "";

    for (const fact of TEXT_FACTS) expect(text, fact).toContain(fact);
    for (const fact of REFERENCE_FACTS) expect(references, fact).toContain(fact);
  });

  it("keeps the backend model and its sampling out of the declaration", () => {
    // drama_value is the one public name that may carry the word, so it is taken out before the check.
    const published = JSON.stringify(getBuiltinGenerationModel("scene3")).replaceAll("drama_value", "");

    expect(published).not.toMatch(/drama|fish|sampl|temperature|top[-_ ]?k/i);
  });

  it("documents every scene3 input and parameter in the README, each with an example", async () => {
    const section = await readmeScene3Section();

    expect(section).toContain(DRAMA_VALUE_DESCRIPTION);
    expect(section).toContain("up to 16");
    expect(section).toContain(
      "Not supported: `speed`, `response_format`, `voice`, `voice_prompt`, `stream`, or a separate `language` parameter",
    );
    for (const control of ["[sighs]", "<whisper>", "[style]", "<|speaker:N|>", "[language: xx]", "[audio tokens: N]"]) {
      expect(section, control).toContain(control);
    }
    for (const example of ["meta: { text:", "drama_value: 0.8", "seed: 42", 'instructions: "']) {
      expect(section, example).toContain(example);
    }
    for (const fact of [...TEXT_FACTS, ...REFERENCE_FACTS]) expect(section, fact).toContain(fact);
  });

  it("keeps the backend model and its sampling out of the README section", async () => {
    const section = (await readmeScene3Section()).replaceAll("drama_value", "");

    expect(section.length).toBeGreaterThan(0);
    expect(section).not.toMatch(/drama|fish|sampl|temperature|top[-_ ]?k/i);
  });

  it.each<{ name: string; value: unknown }>([
    { name: "drama_value", value: 0.5 },
  ])("keeps $name to scene3: the Qwen model rejects it as an unknown parameter", ({ name, value }) => {
    const client = createGenerationClient({ apiKey: "key" });

    expect(() => client.validate(qwenDesignRequest({ parameters: { [name]: value } }))).toThrow(
      `Unknown parameter: ${name}`,
    );
  });

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
      name: "seventeen audio blocks",
      request: scene3Request([{ type: "text", text: "文本" }, ...speakerReferences(17)]),
      message: "Expected at most 16 audio content block(s)",
    },
    {
      name: "drama_value below 0",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { drama_value: -0.1 } }),
      message: "Parameter drama_value must be >= 0",
    },
    {
      name: "drama_value above 1",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { drama_value: 1.1 } }),
      message: "Parameter drama_value must be <= 1",
    },
    {
      name: "string drama_value",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { drama_value: "high" } }),
      message: "Parameter drama_value must be a number",
    },
    {
      name: "null drama_value",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { drama_value: null } }),
      message: "Parameter drama_value must be a number",
    },
    {
      name: "NaN drama_value",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { drama_value: Number.NaN } }),
      message: "Parameter drama_value must be a number",
    },
    {
      name: "negative seed",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { seed: -1 } }),
      message: "Parameter seed must be >= 0",
    },
    {
      name: "fractional seed",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { seed: 1.5 } }),
      message: "Parameter seed must be an integer",
    },
    {
      name: "seed above 2^53 - 1",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { seed: 9007199254740992 } }),
      message: "Parameter seed must be <= 9007199254740991",
    },
    {
      name: "301-character instructions",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { instructions: "字".repeat(301) } }),
      message: "Parameter instructions must be at most 300 characters",
    },
    {
      name: "numeric instructions",
      request: scene3Request([{ type: "text", text: "文本" }], { parameters: { instructions: 5 } }),
      message: "Parameter instructions must be a string",
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
      name: "audio meta.role other than reference_audio",
      request: scene3Request([{ type: "text", text: "文本" }, audio(REFERENCE_URL, { role: "first_frame" })]),
      message: "audio role is not supported by scene3: first_frame",
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
    audioSpec.max = 17;
    const client = createGenerationClient({ models: [declaration], includeBuiltinModels: false, apiKey: "key" });

    expect(() => client.validate(scene3Request([{ type: "text", text: "文本" }, ...speakerReferences(17)]))).toThrow(
      "scene3 supports at most 16 reference audios",
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
      model: "qwen-audio-3.1-tts-flash",
      content: [{ type: "text", text: QWEN_TEXT }, audio(reference)],
    });

    const serialized = JSON.stringify(events);
    expect(serialized).toContain(reference);
    expect(serialized).toContain(outputUrl);
    expect(serialized).not.toContain("Bearer key");
    expect(serialized).toContain("[REDACTED]");
  });
});
