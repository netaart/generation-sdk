import { describe, expect, it, vi } from "vitest";
import { createGenerationClient, type GenerationContentBlock, type GenerationProviderError } from "../../src/index.js";

type FetchCall = { url: string; init: RequestInit };

function textBlock(text: string): GenerationContentBlock {
  return { type: "text", text };
}

function imageBlock(url: string, meta?: Record<string, unknown>): GenerationContentBlock {
  return { type: "image", source: { type: "url", url }, ...(meta ? { meta } : {}) };
}

function videoBlock(url: string, meta?: Record<string, unknown>): GenerationContentBlock {
  return { type: "video", source: { type: "url", url }, ...(meta ? { meta } : {}) };
}

function audioBlock(url: string, meta?: Record<string, unknown>): GenerationContentBlock {
  return { type: "audio", source: { type: "url", url }, ...(meta ? { meta } : {}) };
}

function parseCreateBody(calls: FetchCall[]): Record<string, unknown> {
  return JSON.parse(String(calls[0]?.init.body ?? "{}")) as Record<string, unknown>;
}

async function expectVideoGenerationValidationError(content: GenerationContentBlock[], message: string) {
  let resolvedSources = 0;
  const client = createGenerationClient({
    apiKey: "key",
    fetch: async () => {
      throw new Error("fetch should not be called");
    },
    sourceResolver: (source) => {
      resolvedSources += 1;
      return source.type === "url" ? source.url : source.data;
    },
  });

  await expect(
    client.generate({
      model: "seedance-2-0-fast",
      content,
    }),
  ).rejects.toThrow(message);
  expect(resolvedSources).toBe(0);
}

async function runSuccessfulVideoGeneration(
  content: GenerationContentBlock[],
  parameters: Record<string, unknown> = {},
  model = "seedance-2-0-fast",
) {
  vi.useFakeTimers();
  const calls: FetchCall[] = [];
  const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).endsWith("/v1/video/generations")) {
      return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: { status: "SUCCESS", result_url: "https://example.com/out.mp4" } }), {
      status: 200,
    });
  };

  try {
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model,
      content,
      parameters: { poll_interval: 1, max_wait: 30, ...parameters },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    return { calls, output };
  } finally {
    vi.useRealTimers();
  }
}

describe("ark.videoGenerations adapter", () => {
  it("creates and polls video tasks", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/v1/video/generations")) {
        return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "SUCCESS", result_url: "https://example.com/out.mp4" } }), {
        status: 200,
      });
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "seedance-2-0-fast",
      content: [{ type: "text", text: "hello" }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(calls[0]?.url).toBe("https://router.neta.art/v1/video/generations");
    expect(calls[1]?.url).toBe("https://router.neta.art/v1/video/generations/task-1");
    expect(output[0]).toEqual({
      type: "video",
      source: { type: "url", url: "https://example.com/out.mp4" },
      meta: { task_id: "task-1", status: "succeeded" },
    });
  });

  it("sends text-to-video prompts without metadata content", async () => {
    const { calls } = await runSuccessfulVideoGeneration([textBlock("a red cube rotating on a white table")], {
      ratio: "9:16",
    });
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.prompt).toBe("a red cube rotating on a white table");
    expect(body.width).toBeUndefined();
    expect(body.height).toBeUndefined();
    expect(metadata.content).toBeUndefined();
    expect(metadata.resolution).toBe("720p");
    expect(metadata.ratio).toBe("9:16");
    expect(metadata.fps).toBe(24);
    expect(metadata.generate_audio).toBe(true);
    expect(metadata.return_last_frame).toBe(true);
    expect(metadata.watermark).toBeUndefined();
  });

  it("rejects the removed aspect_ratio alias", async () => {
    const client = createGenerationClient({ apiKey: "key" });
    expect(() =>
      client.validate({
        model: "seedance-2-0-fast",
        content: [textBlock("a vertical shot")],
        parameters: { aspect_ratio: "9:16" },
      }),
    ).toThrow("Unknown parameter: aspect_ratio");
  });

  it("sends first and last frames as metadata media content without text blocks", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("create a smooth cinematic transition"),
      imageBlock("https://example.com/first.jpg", { role: "first_frame" }),
      imageBlock("https://example.com/last.jpg", { role: "last_frame" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.prompt).toBe("create a smooth cinematic transition");
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/first.jpg" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "https://example.com/last.jpg" }, role: "last_frame" },
    ]);
    expect((metadata.content as Array<{ type: string }>).some((item) => item.type === "text")).toBe(false);
    expect(metadata.resolution).toBe("720p");
    expect(metadata.ratio).toBe("16:9");
  });

  it("sends reference images and reference video as metadata media content", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("keep the subject from the image and the motion rhythm from the video"),
      imageBlock("https://example.com/subject.jpg", { role: "reference_image" }),
      imageBlock("https://example.com/style.jpg", { role: "reference_image" }),
      videoBlock("https://example.com/motion.mp4", { role: "reference_video" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.prompt).toBe("keep the subject from the image and the motion rhythm from the video");
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/subject.jpg" }, role: "reference_image" },
      { type: "image_url", image_url: { url: "https://example.com/style.jpg" }, role: "reference_image" },
      { type: "video_url", video_url: { url: "https://example.com/motion.mp4" }, role: "reference_video" },
    ]);
    expect((metadata.content as Array<{ type: string }>).some((item) => item.type === "text")).toBe(false);
  });

  it("sends reference audio beside visual media as metadata audio_url", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("keep the subject from the image and the rhythm from the audio"),
      imageBlock("https://example.com/subject.jpg", { role: "reference_image" }),
      audioBlock("https://example.com/reference.mp3", { role: "reference_audio" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.image).toBeUndefined();
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/subject.jpg" }, role: "reference_image" },
      { type: "audio_url", audio_url: { url: "https://example.com/reference.mp3" }, role: "reference_audio" },
    ]);
  });

  it("sends reference audio with first and last frames", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("create a smooth cinematic transition with this soundtrack"),
      imageBlock("https://example.com/first.jpg", { role: "first_frame" }),
      imageBlock("https://example.com/last.jpg", { role: "last_frame" }),
      audioBlock("https://example.com/reference.mp3", { role: "reference_audio" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/first.jpg" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "https://example.com/last.jpg" }, role: "last_frame" },
      { type: "audio_url", audio_url: { url: "https://example.com/reference.mp3" }, role: "reference_audio" },
    ]);
  });

  it("puts a plain image into metadata content when reference audio is present", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("animate this still with the provided soundtrack"),
      imageBlock("https://example.com/plain.jpg"),
      audioBlock("https://example.com/reference.mp3", { role: "reference_audio" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.image).toBeUndefined();
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: "https://example.com/plain.jpg" } },
      { type: "audio_url", audio_url: { url: "https://example.com/reference.mp3" }, role: "reference_audio" },
    ]);
  });

  it("rejects audio-only Seedance requests before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [
        textBlock("this has audio but no visual reference"),
        audioBlock("https://example.com/reference.mp3", { role: "reference_audio" }),
      ],
      "Seedance audio input requires at least one image or video",
    );
  });

  it("rejects mixed frame and reference media before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [
        textBlock("this is an invalid mixed media request"),
        imageBlock("https://example.com/first.jpg", { role: "first_frame" }),
        imageBlock("https://example.com/ref.jpg", { role: "reference_image" }),
      ],
      "Cannot mix video media modes: use only plain image, first_frame/last_frame, or reference_image/reference_video",
    );
  });

  it("rejects duplicate frame roles before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [
        textBlock("this has two first frames"),
        imageBlock("https://example.com/first-1.jpg", { role: "first_frame" }),
        imageBlock("https://example.com/first-2.jpg", { role: "first_frame" }),
      ],
      "Frame mode supports at most one first_frame image",
    );
  });

  it("rejects multiple plain images before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [
        textBlock("this has too many plain image inputs"),
        imageBlock("https://example.com/plain-1.jpg"),
        imageBlock("https://example.com/plain-2.jpg"),
      ],
      "Plain image mode supports at most one image",
    );
  });

  it("includes the create-task response when no task id is returned", async () => {
    const fetchMock = async () =>
      new Response(JSON.stringify({ status: "queued", message: "missing id" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    await expect(
      client.generate({
        model: "seedance-2-0-fast",
        content: [{ type: "text", text: "hello" }],
      }),
    ).rejects.toMatchObject({
      name: "GenerationProviderError",
      message: "Video generation provider did not return a task id",
      details: { response: { status: "queued", message: "missing id" } },
    } satisfies Partial<GenerationProviderError>);
  });

  it("preserves the router-generated first frame role", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/video/generations")) {
        return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          data: {
            status: "SUCCESS",
            result_url: "https://example.com/out.mp4",
            first_frame: "https://example.com/first.webp",
            progress: "100%",
            data: { status: "succeeded", seed: 123 },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "seedance-2-0-fast",
      content: [{ type: "text", text: "hello" }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(output).toEqual([
      {
        type: "video",
        source: { type: "url", url: "https://example.com/out.mp4" },
        meta: { task_id: "task-1", status: "succeeded", progress: "100%", seed: 123 },
      },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/first.webp" },
        meta: { role: "first_frame", task_id: "task-1" },
      },
    ]);
  });

  it("includes poll diagnostics when a succeeded task has no video URL", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/v1/video/generations")) {
        return new Response(JSON.stringify({ task_id: "task-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { status: "succeeded", progress: 100, data: { seed: 123 } } }), {
        status: 200,
      });
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = expect(
      client.generate({
        model: "seedance-2-0-fast",
        content: [{ type: "text", text: "hello" }],
        parameters: { poll_interval: 1, max_wait: 30 },
      }),
    ).rejects.toMatchObject({
      name: "GenerationProviderError",
      message: "Video generation succeeded but returned no video URL",
      details: {
        taskId: "task-1",
        rawStatus: { data: { status: "succeeded", progress: 100, data: { seed: 123 } } },
        metadata: { progress: 100, seed: 123 },
      },
    } satisfies Partial<GenerationProviderError>);

    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();
  });

  it("rejects Seedance 2.5 first-frame tasks that set a fixed ratio", async () => {
    const client = createGenerationClient({
      apiKey: "key",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(
      client.generate({
        model: "seedance-2-5",
        content: [textBlock("animate the still"), imageBlock("https://example.com/first.jpg", { role: "first_frame" })],
        parameters: { ratio: "9:16" },
      }),
    ).rejects.toThrow('Seedance 2.5 first/last-frame tasks require ratio=adaptive, got "9:16"');
  });

  it("defaults Seedance 2.5 first-frame ratio to adaptive", async () => {
    const { calls } = await runSuccessfulVideoGeneration(
      [textBlock("animate the still"), imageBlock("https://example.com/first.jpg", { role: "first_frame" })],
      {},
      "seedance-2-5",
    );
    const metadata = parseCreateBody(calls).metadata as Record<string, unknown>;
    expect(metadata.ratio).toBe("adaptive");
  });

  it("still allows Seedance 2.5 text-to-video to use a fixed ratio", async () => {
    const { calls } = await runSuccessfulVideoGeneration(
      [textBlock("a vertical shot of rain on a window")],
      { ratio: "9:16" },
      "seedance-2-5",
    );
    const metadata = parseCreateBody(calls).metadata as Record<string, unknown>;
    expect(metadata.ratio).toBe("9:16");
  });

  it("rejects Seedance 2.5 reference-video tasks that set a fixed ratio", async () => {
    const client = createGenerationClient({
      apiKey: "key",
      fetch: async () => {
        throw new Error("fetch should not be called");
      },
    });

    await expect(
      client.generate({
        model: "seedance-2-5",
        content: [
          textBlock("turn the clip into night rain"),
          videoBlock("https://example.com/source.mp4", { role: "reference_video" }),
        ],
        parameters: { ratio: "16:9" },
      }),
    ).rejects.toThrow('Seedance 2.5 edit/extend tasks require ratio=adaptive, got "16:9"');
  });

  it("defaults Seedance 2.5 reference-video ratio to adaptive", async () => {
    const { calls } = await runSuccessfulVideoGeneration(
      [textBlock("extend the motion"), videoBlock("https://example.com/source.mp4", { role: "reference_video" })],
      {},
      "seedance-2-5",
    );
    const metadata = parseCreateBody(calls).metadata as Record<string, unknown>;
    expect(metadata.ratio).toBe("adaptive");
  });
});
