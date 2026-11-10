import { describe, expect, it, vi } from "vitest";
import {
  createGenerationClient,
  type GenerationContentBlock,
  type GenerationModelDeclaration,
  type GenerationProviderError,
} from "../../src/index.js";

type FetchCall = { url: string; init: RequestInit };

const h3Declaration = {
  schema: "neta.generation.model.v1",
  model: "minimax-h3",
  category: "video",
  adapter: { type: "minimax.h3VideoGenerations" },
  content: {
    input: [
      { type: "text", required: true, min: 1, max: 16, merge: "newline" },
      {
        type: "image",
        max: 12,
        sources: ["url"],
        roles: ["first_frame", "last_frame", "reference_image"],
        roleRequired: true,
      },
      {
        type: "video",
        max: 3,
        sources: ["url"],
        roles: ["reference_video"],
        roleRequired: true,
      },
      {
        type: "audio",
        max: 3,
        sources: ["url"],
        roles: ["reference_audio"],
        roleRequired: true,
      },
    ],
  },
  parameters: {
    duration: { type: "integer", optional: true, default: 5 },
    resolution: { type: "string", optional: true, default: "768P" },
    ratio: {
      type: "string",
      optional: true,
      default: "16:9",
      enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    },
    aigc_watermark: { type: "boolean", optional: true, default: false },
    poll_interval: { type: "integer", optional: true, default: 1, min: 1, max: 30 },
    max_wait: { type: "integer", optional: true, default: 600, min: 30, max: 1800 },
  },
} satisfies GenerationModelDeclaration;

function textBlock(text: string): GenerationContentBlock {
  return { type: "text", text };
}

function imageBlock(url: string, role: string): GenerationContentBlock {
  return { type: "image", source: { type: "url", url }, meta: { role } };
}

function videoBlock(url: string): GenerationContentBlock {
  return { type: "video", source: { type: "url", url }, meta: { role: "reference_video" } };
}

function audioBlock(url: string): GenerationContentBlock {
  return { type: "audio", source: { type: "url", url }, meta: { role: "reference_audio" } };
}

function parseCreateBody(calls: FetchCall[]): Record<string, unknown> {
  return JSON.parse(String(calls[0]?.init.body ?? "{}")) as Record<string, unknown>;
}

async function runSuccessfulGeneration(
  content: GenerationContentBlock[],
  parameters: Record<string, unknown> = {},
  taskResponse: Record<string, unknown> = {
    code: "success",
    data: {
      task_id: "task-1",
      status: "SUCCESS",
      progress: "100%",
      result_url: "https://example.com/out.mp4",
    },
  },
  declaration: GenerationModelDeclaration = h3Declaration,
): Promise<{ calls: FetchCall[]; output: GenerationContentBlock[] }> {
  vi.useFakeTimers();
  const calls: FetchCall[] = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("/v1/video/generations")) {
      return new Response(JSON.stringify({ id: "task-1", status: "queued" }), { status: 200 });
    }
    return new Response(JSON.stringify(taskResponse), { status: 200 });
  };

  try {
    const client = createGenerationClient({
      apiKey: "key",
      fetch: fetchMock as typeof fetch,
      models: [declaration],
      includeBuiltinModels: false,
    });
    const promise = client.generate({
      model: declaration.model,
      content,
      parameters: { poll_interval: 1, max_wait: 30, ...parameters },
    });
    await vi.advanceTimersByTimeAsync(1000);
    return { calls, output: await promise };
  } finally {
    vi.useRealTimers();
  }
}

describe("minimax.h3VideoGenerations adapter", () => {
  it("submits official H3 fields and polls the NewAPI task envelope", async () => {
    const { calls, output } = await runSuccessfulGeneration([textBlock("a red cube rotating on a white table")]);
    const body = parseCreateBody(calls);

    expect(calls[0]?.url).toBe("https://router.neta.art/v1/video/generations");
    expect(calls[1]?.url).toBe("https://router.neta.art/v1/video/generations/task-1");
    expect(body).toEqual({
      model: "minimax-h3",
      content: [{ type: "text", text: "a red cube rotating on a white table" }],
      resolution: "768P",
      duration: 5,
      ratio: "16:9",
      aigc_watermark: false,
    });
    expect(output).toEqual([
      {
        type: "video",
        source: { type: "url", url: "https://example.com/out.mp4" },
        meta: { task_id: "task-1", status: "succeeded", progress: "100%" },
      },
    ]);
  });

  it("keeps flat task response compatibility", async () => {
    const { output } = await runSuccessfulGeneration(
      [textBlock("a red cube rotating on a white table")],
      {},
      {
        id: "task-1",
        status: "completed",
        progress: 100,
        metadata: { url: "https://example.com/out.mp4" },
      },
    );

    expect(output).toEqual([
      {
        type: "video",
        source: { type: "url", url: "https://example.com/out.mp4" },
        meta: { task_id: "task-1", status: "succeeded", progress: 100 },
      },
    ]);
  });

  it("fails on the first poll when NewAPI reports TIMEOUT and carries the fail reason", async () => {
    vi.useFakeTimers();
    const timeoutResponse = {
      code: "success",
      data: {
        task_id: "task-1",
        status: "TIMEOUT",
        fail_reason: "任务超时（模型 minimax-h3，15分钟）",
        progress: "100%",
        data: { status: "failed" },
      },
    };
    const calls: string[] = [];
    const fetchMock = async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).endsWith("/v1/video/generations")) {
        return new Response(JSON.stringify({ id: "task-1", status: "queued" }), { status: 200 });
      }
      return new Response(JSON.stringify(timeoutResponse), { status: 200 });
    };

    try {
      const client = createGenerationClient({
        apiKey: "key",
        fetch: fetchMock as typeof fetch,
        models: [h3Declaration],
        includeBuiltinModels: false,
      });
      const rejection = expect(
        client.generate({
          model: h3Declaration.model,
          content: [textBlock("a red cube rotating on a white table")],
          parameters: { poll_interval: 1, max_wait: 30 },
        }),
      ).rejects.toMatchObject({
        name: "GenerationProviderError",
        message: "MiniMax H3 generation failed: 任务超时（模型 minimax-h3，15分钟）",
        details: { taskId: "task-1", rawStatus: timeoutResponse },
      } satisfies Partial<GenerationProviderError>);

      await vi.advanceTimersByTimeAsync(31_000);
      await rejection;
      expect(calls).toEqual([
        "https://router.neta.art/v1/video/generations",
        "https://router.neta.art/v1/video/generations/task-1",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes image, video, and audio references and preserves the requested ratio", async () => {
    const { calls } = await runSuccessfulGeneration(
      [
        textBlock("keep the subject, motion, and soundtrack references"),
        imageBlock("https://example.com/subject.png", "reference_image"),
        imageBlock("https://example.com/style.png", "reference_image"),
        videoBlock("https://example.com/motion.mp4"),
        audioBlock("https://example.com/voice.mp3"),
      ],
      { resolution: "2K", ratio: "9:16", aigc_watermark: true },
    );
    const body = parseCreateBody(calls);

    expect(body).toMatchObject({ resolution: "2K", duration: 5, ratio: "9:16", aigc_watermark: true });
    expect(body.content).toEqual([
      { type: "text", text: "keep the subject, motion, and soundtrack references" },
      { type: "image_url", image_url: { url: "https://example.com/subject.png" }, role: "reference_image" },
      { type: "image_url", image_url: { url: "https://example.com/style.png" }, role: "reference_image" },
      { type: "video_url", video_url: { url: "https://example.com/motion.mp4" }, role: "reference_video" },
      { type: "audio_url", audio_url: { url: "https://example.com/voice.mp3" }, role: "reference_audio" },
    ]);
  });

  it("passes duration and resolution through for NewAPI to validate", async () => {
    const { calls } = await runSuccessfulGeneration([textBlock("a long high-resolution shot")], {
      duration: 42,
      resolution: "4K",
    });
    expect(parseCreateBody(calls)).toMatchObject({ duration: 42, resolution: "4K" });
  });

  it("uses the declaration model for the unrestricted alias", async () => {
    const declaration = {
      ...h3Declaration,
      model: "minimax-h3-unrestricted",
    } satisfies GenerationModelDeclaration;
    const { calls } = await runSuccessfulGeneration(
      [textBlock("a custom-size shot")],
      { duration: 15, resolution: "1920x1080" },
      undefined,
      declaration,
    );

    expect(parseCreateBody(calls)).toMatchObject({
      model: "minimax-h3-unrestricted",
      duration: 15,
      resolution: "1920x1080",
    });
  });

  it("preserves fixed ratios for frame inputs", async () => {
    const { calls } = await runSuccessfulGeneration(
      [textBlock("animate the transition"), imageBlock("https://example.com/first.png", "first_frame")],
      { ratio: "9:16" },
    );

    expect(parseCreateBody(calls).ratio).toBe("9:16");
  });

  it("preserves adaptive ratio for media inputs", async () => {
    const { calls } = await runSuccessfulGeneration(
      [textBlock("animate the transition"), imageBlock("https://example.com/first.png", "first_frame")],
      { ratio: "adaptive" },
    );

    expect(parseCreateBody(calls).ratio).toBe("adaptive");
  });

  it("normalizes adaptive ratio for text-only input", async () => {
    const { calls } = await runSuccessfulGeneration([textBlock("a wide establishing shot")], {
      ratio: "adaptive",
    });

    expect(parseCreateBody(calls).ratio).toBe("16:9");
  });

  it("accepts audio-only reference input", async () => {
    const { calls } = await runSuccessfulGeneration(
      [textBlock("use the rhythm and mood from this soundtrack"), audioBlock("https://example.com/music.mp3")],
      { ratio: "9:16" },
    );

    expect(parseCreateBody(calls)).toMatchObject({
      ratio: "9:16",
      content: [
        { type: "text", text: "use the rhythm and mood from this soundtrack" },
        {
          type: "audio_url",
          audio_url: { url: "https://example.com/music.mp3" },
          role: "reference_audio",
        },
      ],
    });
  });

  it("rejects mixed modes and excessive media before resolving sources", async () => {
    let resolvedSources = 0;
    const client = createGenerationClient({
      apiKey: "key",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
      sourceResolver: () => {
        resolvedSources += 1;
        return "https://example.com/resolved";
      },
      models: [h3Declaration],
      includeBuiltinModels: false,
    });

    await expect(
      client.generate({
        model: h3Declaration.model,
        content: [
          textBlock("invalid mixed request"),
          imageBlock("https://example.com/first.png", "first_frame"),
          imageBlock("https://example.com/reference.png", "reference_image"),
        ],
      }),
    ).rejects.toThrow("cannot mix frame images with reference materials");
    expect(resolvedSources).toBe(0);
  });

  it("enforces the H3 total media limit", async () => {
    const content: GenerationContentBlock[] = [textBlock("too many references")];
    for (let index = 0; index < 9; index += 1) {
      content.push(imageBlock(`https://example.com/reference-${index}.png`, "reference_image"));
    }
    for (let index = 0; index < 3; index += 1) {
      content.push(videoBlock(`https://example.com/reference-${index}.mp4`));
    }
    content.push(audioBlock("https://example.com/reference.mp3"));

    const client = createGenerationClient({
      apiKey: "key",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
      models: [h3Declaration],
      includeBuiltinModels: false,
    });

    await expect(client.generate({ model: h3Declaration.model, content })).rejects.toThrow(
      "MiniMax H3 supports at most 12 media items; received 9 reference images, 3 reference videos, 1 reference audio inputs, and 0 frame images",
    );
  });

  it("accepts exactly 12 reference media items", async () => {
    const content: GenerationContentBlock[] = [textBlock("use all references")];
    for (let index = 0; index < 9; index += 1) {
      content.push(imageBlock(`https://example.com/reference-${index}.png`, "reference_image"));
    }
    for (let index = 0; index < 3; index += 1) {
      content.push(videoBlock(`https://example.com/reference-${index}.mp4`));
    }

    const { calls } = await runSuccessfulGeneration(content);

    expect(parseCreateBody(calls)).toMatchObject({ ratio: "16:9" });
    expect(parseCreateBody(calls).content).toHaveLength(13);
  });
});
