import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGenerationClient, type GenerationContentBlock, type GenerationProviderError } from "../../src/index.js";
import { loopbackMediaFetch, type MediaServer, startMediaServer } from "../helpers/media-server.js";

type FetchCall = { url: string; init: RequestInit };

let media: MediaServer;
beforeAll(async () => {
  media = await startMediaServer();
});
afterAll(() => media.close());

const image = (file = "image-640x360.jpg") => media.url(file);
const video = (file = "video-854x480-24fps.mp4") => media.url(file);
const audio = (file = "audio-5s.wav") => media.url(file);

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
      parameters: { duration: 5 },
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
    const client = createGenerationClient({
      apiKey: "key",
      fetch: fetchMock as typeof fetch,
      mediaFetch: loopbackMediaFetch,
    });
    const promise = client.generate({
      model,
      content,
      parameters: { poll_interval: 1, max_wait: 30, ...parameters },
    });
    // 素材检查读取本地服务器上的真实文件，等到创建任务之后再推进轮询计时
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
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
      parameters: { duration: 5, poll_interval: 1, max_wait: 30 },
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
    expect(body.duration).toBe(5);
    expect(metadata.duration).toBeUndefined();
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

  it("defaults duration to 5 when omitted", async () => {
    const { calls } = await runSuccessfulVideoGeneration([textBlock("a slow push in")]);
    expect(parseCreateBody(calls).duration).toBe(5);
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
      imageBlock(image(), { role: "first_frame" }),
      imageBlock(image("image-640x360.png"), { role: "last_frame" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.prompt).toBe("create a smooth cinematic transition");
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: image() }, role: "first_frame" },
      { type: "image_url", image_url: { url: image("image-640x360.png") }, role: "last_frame" },
    ]);
    expect((metadata.content as Array<{ type: string }>).some((item) => item.type === "text")).toBe(false);
    expect(metadata.resolution).toBe("720p");
    expect(metadata.ratio).toBe("16:9");
  });

  it("sends reference images and reference video as metadata media content", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("keep the subject from the image and the motion rhythm from the video"),
      imageBlock(image(), { role: "reference_image" }),
      imageBlock(image("image-640x360.webp"), { role: "reference_image" }),
      videoBlock(video(), { role: "reference_video" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.prompt).toBe("keep the subject from the image and the motion rhythm from the video");
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: image() }, role: "reference_image" },
      { type: "image_url", image_url: { url: image("image-640x360.webp") }, role: "reference_image" },
      { type: "video_url", video_url: { url: video() }, role: "reference_video" },
    ]);
    expect((metadata.content as Array<{ type: string }>).some((item) => item.type === "text")).toBe(false);
  });

  it("sends reference audio beside visual media as metadata audio_url", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("keep the subject from the image and the rhythm from the audio"),
      imageBlock(image(), { role: "reference_image" }),
      audioBlock(audio("audio-10s.mp3"), { role: "reference_audio" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.image).toBeUndefined();
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: image() }, role: "reference_image" },
      { type: "audio_url", audio_url: { url: audio("audio-10s.mp3") }, role: "reference_audio" },
    ]);
  });

  it("puts a plain image into metadata content when reference audio is present", async () => {
    const { calls } = await runSuccessfulVideoGeneration([
      textBlock("animate this still with the provided soundtrack"),
      imageBlock(image()),
      audioBlock(audio(), { role: "reference_audio" }),
    ]);
    const body = parseCreateBody(calls);
    const metadata = body.metadata as Record<string, unknown>;

    expect(body.image).toBeUndefined();
    expect(metadata.content).toEqual([
      { type: "image_url", image_url: { url: image() } },
      { type: "audio_url", audio_url: { url: audio() }, role: "reference_audio" },
    ]);
  });

  it("sends Seedance 2.5 reference audio without visual media", async () => {
    const { calls } = await runSuccessfulVideoGeneration(
      [textBlock("a dance that follows this beat"), audioBlock(audio(), { role: "reference_audio" })],
      {},
      "seedance-2-5",
    );
    const metadata = parseCreateBody(calls).metadata as Record<string, unknown>;
    expect(metadata.content).toEqual([{ type: "audio_url", audio_url: { url: audio() }, role: "reference_audio" }]);
  });

  it("rejects audio-only Seedance 2.0 requests before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [
        textBlock("this has audio but no visual reference"),
        audioBlock("https://example.com/reference.mp3", { role: "reference_audio" }),
      ],
      "seedance-2-0-fast audio input requires at least one image or video content block",
    );
  });

  it("rejects reference audio with first and last frames before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [
        textBlock("create a smooth cinematic transition with this soundtrack"),
        imageBlock("https://example.com/first.jpg", { role: "first_frame" }),
        imageBlock("https://example.com/last.jpg", { role: "last_frame" }),
        audioBlock("https://example.com/reference.mp3", { role: "reference_audio" }),
      ],
      "Seedance does not accept reference_audio with first_frame/last_frame",
    );
  });

  it("rejects a last frame without a first frame before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [textBlock("end on this frame"), imageBlock("https://example.com/last.jpg", { role: "last_frame" })],
      "A last_frame image needs a first_frame image in the same request",
    );
  });

  it("rejects a second reference video on Seedance 2.0 before resolving sources", async () => {
    await expectVideoGenerationValidationError(
      [
        textBlock("combine the motion of both clips"),
        videoBlock("https://example.com/a.mp4", { role: "reference_video" }),
        videoBlock("https://example.com/b.mp4", { role: "reference_video" }),
      ],
      "Expected at most 1 video content block(s)",
    );
  });

  it("sends several reference videos to Seedance 2.5", async () => {
    const { calls } = await runSuccessfulVideoGeneration(
      [
        textBlock("combine the motion of both clips"),
        videoBlock(video(), { role: "reference_video" }),
        videoBlock(video("video-854x480-23.976fps-moov-end.mp4"), { role: "reference_video" }),
      ],
      {},
      "seedance-2-5",
    );
    const metadata = parseCreateBody(calls).metadata as Record<string, unknown>;
    expect(metadata.content).toEqual([
      { type: "video_url", video_url: { url: video() }, role: "reference_video" },
      {
        type: "video_url",
        video_url: { url: video("video-854x480-23.976fps-moov-end.mp4") },
        role: "reference_video",
      },
    ]);
  });

  it("accepts duration -1 and rejects durations below 4", async () => {
    const { calls } = await runSuccessfulVideoGeneration([textBlock("a slow push in")], { duration: -1 });
    expect(parseCreateBody(calls).duration).toBe(-1);

    const client = createGenerationClient({ apiKey: "key" });
    for (const duration of [0, 3, -2]) {
      expect(() =>
        client.validate({
          model: "seedance-2-0-fast",
          content: [textBlock("a slow push in")],
          parameters: { duration },
        }),
      ).toThrow("Parameter duration must be >= 4 or one of: -1");
    }
    expect(() =>
      client.validate({
        model: "seedance-2-0-fast",
        content: [textBlock("a slow push in")],
        parameters: { duration: 16 },
      }),
    ).toThrow("Parameter duration must be <= 15 or one of: -1");
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
        parameters: { duration: 5 },
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
      parameters: { duration: 5, poll_interval: 1, max_wait: 30 },
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
        parameters: { duration: 5, poll_interval: 1, max_wait: 30 },
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
        parameters: { duration: 5, ratio: "9:16" },
      }),
    ).rejects.toThrow('Seedance 2.5 first/last-frame tasks require ratio=adaptive, got "9:16"');
  });

  it("keeps a fixed ratio for Seedance 2.0 first-frame tasks", async () => {
    const { calls } = await runSuccessfulVideoGeneration(
      [textBlock("animate the still"), imageBlock(image(), { role: "first_frame" })],
      { ratio: "9:16" },
    );
    const metadata = parseCreateBody(calls).metadata as Record<string, unknown>;
    expect(metadata.ratio).toBe("9:16");
  });

  it("defaults Seedance 2.5 first-frame ratio to adaptive", async () => {
    const { calls } = await runSuccessfulVideoGeneration(
      [textBlock("animate the still"), imageBlock(image(), { role: "first_frame" })],
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
});
