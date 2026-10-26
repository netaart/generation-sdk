import { describe, expect, it, vi } from "vitest";
import { createGenerationClient } from "../../src/index.js";

const sunoTaskModelCases = [
  {
    model: "suno_cover_chirp_v5",
    task: "cover",
    content: [{ type: "text" as const, text: "cover this with new lyrics" }],
    meta: { cover_clip_id: "clip_origin", task_id: "task_origin", continue_clip_id: "clip_origin" },
  },
  {
    model: "suno_image_to_song_chirp_v5",
    task: "image_to_song",
    content: [
      { type: "text" as const, text: "turn this image into a short hopeful pop song" },
      { type: "image" as const, source: { type: "url" as const, url: "https://example.com/image.jpg" } },
    ],
    meta: { metadata_params: { prompt: "turn this image into a short hopeful pop song" } },
  },
  {
    model: "suno_video_to_song_chirp_v5",
    task: "video_to_song",
    content: [
      { type: "text" as const, text: "turn this video into a short cinematic song" },
      { type: "video" as const, source: { type: "url" as const, url: "https://example.com/video.mp4" } },
    ],
    meta: { metadata_params: { prompt: "turn this video into a short cinematic song" } },
  },
  {
    model: "suno_sound_chirp_v5",
    task: "sound",
    content: [{ type: "text" as const, text: "gentle rain ambience" }],
    meta: { metadata_params: { sound: "gentle rain ambience" } },
  },
  {
    model: "suno_infill_chirp_v5",
    task: "infill",
    content: [{ type: "text" as const, text: "replace this section with a brighter verse" }],
    meta: { continue_clip_id: "clip_origin", metadata_params: { infill_start_s: 10, infill_end_s: 20 } },
  },
  {
    model: "suno_vox_chirp_v5",
    task: "vox",
    content: [{ type: "text" as const, text: "turn this reference into a complete song" }],
    meta: { artist_clip_id: "clip_origin", tags: "pop,female voice", make_instrumental: false },
  },
] as const;

describe("suno.tasks adapter", () => {
  it("submits music tasks and polls successful song outputs", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_1" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_1",
            action: "music",
            status: "SUCCESS",
            data: [
              {
                id: "clip_1",
                audio_url: "https://example.com/song.mp3",
                video_url: "https://example.com/song.mp4",
                image_url: "https://example.com/cover.jpg",
                title: "Warm Horizon",
                text: "la la la",
                metadata: { duration: 180, tags: "cinematic pop", prompt: "warm piano" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_music_chirp_fenix",
      content: [{ type: "text", text: "warm piano" }],
      parameters: { poll_interval: 1, max_wait: 30 },
      meta: { title: "Warm Horizon" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(calls[0]?.url).toBe("https://router.neta.art/suno/submit/music");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      mv: "chirp-fenix",
      gpt_description_prompt: "warm piano",
      title: "Warm Horizon",
    });
    expect(calls[1]?.url).toBe("https://router.neta.art/suno/fetch/task_1");
    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://example.com/song.mp3" },
        meta: expect.objectContaining({ id: "clip_1", title: "Warm Horizon", duration: 180 }),
      },
      {
        type: "video",
        source: { type: "url", url: "https://example.com/song.mp4" },
        meta: expect.objectContaining({ id: "clip_1", title: "Warm Horizon", duration: 180 }),
      },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/cover.jpg" },
        meta: expect.objectContaining({ id: "clip_1", title: "Warm Horizon", duration: 180 }),
      },
      {
        type: "text",
        text: "la la la",
        meta: expect.objectContaining({ id: "clip_1", title: "Warm Horizon", duration: 180 }),
      },
    ]);
  });

  it("passes Suno provider fields through request and content meta", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_image" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_image",
            action: "music",
            status: "SUCCESS",
            data: { audio_url: "https://example.com/image-song.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_image_to_song_chirp_v5",
      content: [
        { type: "text", text: "make this image sing" },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/image.jpg" },
          meta: { metadata_params: { prompt: "make this image sing" } },
        },
      ],
      parameters: { poll_interval: 1, max_wait: 30 },
      meta: { title: "Image Song" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      prompt: "make this image sing",
      image_url: "https://example.com/image.jpg",
      mv: "chirp-v5",
      task: "image_to_song",
      title: "Image Song",
      metadata_params: {
        image_url: "https://example.com/image.jpg",
        prompt: "make this image sing",
      },
    });
  });

  it("keeps provider-specific Suno fields in meta instead of SDK parameters", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_meta" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_meta",
            action: "music",
            status: "SUCCESS",
            data: { audio_url: "https://example.com/cover.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_cover_chirp_v5",
      content: [{ type: "text", text: "warm piano chorus" }],
      parameters: { poll_interval: 1, max_wait: 30 },
      meta: {
        title: "Cover Test",
        tags: "warm piano",
        make_instrumental: false,
        task_id: "task_origin",
        cover_clip_id: "clip_origin",
        continue_clip_id: "clip_origin",
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      mv: "chirp-v5",
      prompt: "warm piano chorus",
      task: "cover",
      title: "Cover Test",
      tags: "warm piano",
      make_instrumental: false,
      task_id: "task_origin",
      clip_id: "clip_origin",
      cover_clip_id: "clip_origin",
      continue_clip_id: "clip_origin",
    });
  });

  it("uses sound as a first-class task model", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_sound" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_sound",
            action: "music",
            status: "SUCCESS",
            data: { audio_url: "https://example.com/sound.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_sound_chirp_v5",
      content: [{ type: "text", text: "gentle rain ambience" }],
      parameters: { poll_interval: 1, max_wait: 30 },
      meta: { metadata_params: { sound: "gentle rain ambience" } },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();

    expect(calls[0]?.url).toBe("https://router.neta.art/suno/submit/music");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      mv: "chirp-v5",
      prompt: "gentle rain ambience",
      task: "sound",
      metadata_params: { sound: "gentle rain ambience" },
    });
  });

  it("parses Suno item media fields from task results", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_item_media" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_item_media",
            action: "music",
            status: "SUCCESS",
            progress: "100%",
            data: {
              code: 200,
              data: {
                taskBatchId: "batch_1",
                items: [
                  {
                    id: "item_1",
                    clipId: "clip_1",
                    title: "Warm Horizon",
                    tags: "cinematic pop",
                    prompt: "warm piano",
                    duration: 142.56,
                    progress: 100,
                    progressMsg: "Production completed",
                    cld2AudioUrl: "https://example.com/song.mp3",
                    cld2ImageUrl: "https://example.com/cover.jpg",
                    cld2VideoUrl: "https://example.com/song.mp4",
                  },
                ],
              },
            },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_music_chirp_fenix",
      content: [{ type: "text", text: "warm piano" }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://example.com/song.mp3" },
        meta: expect.objectContaining({ id: "item_1", clip_id: "clip_1", duration: 142.56 }),
      },
      {
        type: "video",
        source: { type: "url", url: "https://example.com/song.mp4" },
        meta: expect.objectContaining({ id: "item_1", clip_id: "clip_1", progress_message: "Production completed" }),
      },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/cover.jpg" },
        meta: expect.objectContaining({ id: "item_1", clip_id: "clip_1", tags: "cinematic pop" }),
      },
    ]);
  });

  it("normalizes taskStatus fetch responses", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: 200, data: "task_status" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            taskBatchId: "task_status",
            taskStatus: "finished",
            items: [
              {
                id: "item_1",
                clipId: "clip_1",
                title: "Finished",
                status: 30,
                progress: 100,
                progressMsg: "Production completed",
                cld2AudioUrl: "https://example.com/status.mp3",
                cld2ImageUrl: "https://example.com/status.jpg",
              },
            ],
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_infill_chirp_v5",
      content: [{ type: "text", text: "[Verse]\nnew hopeful lyrics" }],
      parameters: { poll_interval: 1, max_wait: 30 },
      meta: {
        continue_clip_id: "clip_1",
        metadata_params: {
          infill_start_s: 0,
          infill_end_s: 30,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://example.com/status.mp3" },
        meta: expect.objectContaining({
          task_id: "task_status",
          clip_id: "clip_1",
          status: 30,
          progress_message: "Production completed",
        }),
      },
      {
        type: "image",
        source: { type: "url", url: "https://example.com/status.jpg" },
        meta: expect.objectContaining({ task_id: "task_status", clip_id: "clip_1" }),
      },
    ]);
  });

  it("supports task-specific Suno models without mutating operation schemas", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { task?: string };
        return new Response(JSON.stringify({ code: "success", data: `task_${body.task}` }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_done",
            action: "music",
            status: "SUCCESS",
            data: { audio_url: "https://example.com/task-output.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });

    for (const input of sunoTaskModelCases) {
      const promise = client.generate({
        model: input.model,
        content: [...input.content],
        parameters: { poll_interval: 1, max_wait: 30 },
        meta: input.meta,
      });
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    }
    vi.useRealTimers();

    const submitCalls = calls.filter((call) => call.url.endsWith("/suno/submit/music"));
    expect(submitCalls).toHaveLength(sunoTaskModelCases.length);
    expect(submitCalls.map((call) => JSON.parse(String(call.init.body)).task)).toEqual(
      sunoTaskModelCases.map((input) => input.task),
    );
    for (const [index, call] of submitCalls.entries()) {
      expect(call.url).toBe("https://router.neta.art/suno/submit/music");
      const body = JSON.parse(String(call.init.body));
      expect(body).toMatchObject({ mv: "chirp-v5", task: sunoTaskModelCases[index]?.task });
    }
  });

  it("validates task-specific Suno meta requirements from model declarations", async () => {
    const fetchMock = async () => new Response("{}");
    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    await expect(() =>
      client.validate({
        model: "suno_cover_chirp_v5",
        content: [{ type: "text", text: "cover this" }],
        parameters: { poll_interval: 1, max_wait: 30 },
      }),
    ).toThrow("Missing required meta: cover_clip_id");

    await expect(
      client.generate({
        model: "suno_cover_chirp_v5",
        content: [{ type: "text", text: "cover this" }],
        parameters: { poll_interval: 1, max_wait: 30 },
      }),
    ).rejects.toThrow("Missing required meta: cover_clip_id");

    await expect(() =>
      client.validate({
        model: "suno_cover_chirp_v5",
        content: [{ type: "text", text: "cover this" }],
        parameters: { poll_interval: 1, max_wait: 30 },
        meta: { cover_clip_id: "clip_origin" },
      }),
    ).toThrow("Missing required meta: task_id");

    await expect(() =>
      client.validate({
        model: "suno_cover_chirp_v5",
        content: [{ type: "text", text: "cover this" }],
        parameters: { poll_interval: 1, max_wait: 30 },
        meta: { cover_clip_id: "clip_origin", task_id: "task_origin" },
      }),
    ).toThrow("Missing required meta: continue_clip_id");

    await expect(() =>
      client.validate({
        model: "suno_image_to_song_chirp_v5",
        content: [{ type: "text", text: "make image sing" }],
        parameters: { poll_interval: 1, max_wait: 30 },
        meta: { metadata_params: { prompt: "make image sing" } },
      }),
    ).toThrow("Missing required image content block");

    await expect(() =>
      client.validate({
        model: "suno_image_to_song_chirp_v5",
        content: [
          {
            type: "image",
            source: { type: "url", url: "https://example.com/image.jpg" },
          },
        ],
      }),
    ).toThrow("Missing required meta: metadata_params");
  });

  it("normalizes array-wrapped task fetch responses", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_array" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: [
            {
              task_id: "task_array",
              action: "music",
              status: "SUCCESS",
              data: { audio_url: "https://example.com/array.mp3", title: "Array Wrapped" },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_music_chirp_fenix",
      content: [{ type: "text", text: "warm piano" }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://example.com/array.mp3" },
        meta: expect.objectContaining({ title: "Array Wrapped", task_id: "task_array" }),
      },
    ]);
  });

  it("normalizes data-array wrapped task fetch responses", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_wrapped_array" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            data: [
              {
                task_id: "task_wrapped_array",
                action: "music",
                status: "SUCCESS",
                data: { audio_url: "https://example.com/wrapped-array.mp3", title: "Wrapped Array" },
              },
            ],
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_music_chirp_fenix",
      content: [{ type: "text", text: "warm piano" }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://example.com/wrapped-array.mp3" },
        meta: expect.objectContaining({ title: "Wrapped Array", task_id: "task_wrapped_array" }),
      },
    ]);
  });

  it("keeps outer task status when task data contains media arrays", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_pending" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_pending",
            action: "music",
            status: "PENDING",
            data: [{ audio_url: "https://example.com/not-ready.mp3" }],
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_music_chirp_fenix",
      content: [{ type: "text", text: "warm piano" }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    const assertion = expect(promise).rejects.toThrow("Timed out waiting for Suno task");
    await vi.advanceTimersByTimeAsync(31_000);
    await assertion;
    vi.useRealTimers();
  });

  it("rejects successful Suno tasks that return no output", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_empty" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: { task_id: "task_empty", action: "music", status: "SUCCESS", data: [] },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_music_chirp_fenix",
      content: [{ type: "text", text: "warm piano" }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    const assertion = expect(promise).rejects.toThrow("Suno task succeeded but returned no output");
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });

  it("marks a Suno task the gateway reports as moderation blocked with the safety category", async () => {
    vi.useFakeTimers();
    const fetchMock = async (url: string | URL | Request) => {
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_blocked" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_blocked",
            action: "music",
            status: "FAILURE",
            fail_reason:
              "moderation_failure/Your tags contain artist name hoyomix - we don't reference specific artists on Suno",
          },
        }),
        { status: 200, headers: { "X-Error-Category": "safety" } },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client
      .generate({
        model: "suno_music_chirp_fenix",
        content: [{ type: "text", text: "warm piano" }],
        parameters: { poll_interval: 1, max_wait: 30 },
      })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await promise;
    vi.useRealTimers();
    expect(error).toMatchObject({
      message: "Suno task failed",
      category: "safety",
      details: { task_id: "task_blocked" },
    });
  });

  it("returns immediate outputs for non-polled Suno operations", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          code: 200,
          data: {
            taskBatchId: "batch_1",
            upsampled_tags: "acoustic pop, warm piano, bright",
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const output = await client.generate({
      model: "suno_style_tags",
      content: [{ type: "text", text: "warm piano" }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://router.neta.art/suno/submit/upsample-tags");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      original_tags: "warm piano",
    });
    expect(output).toEqual([
      {
        type: "text",
        text: "acoustic pop, warm piano, bright",
        meta: expect.objectContaining({ operation: "upsample_tags", task_batch_id: "batch_1" }),
      },
    ]);
  });

  it("uploads audio through the upload_audio endpoint", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/uploads/audio")) {
        return new Response(JSON.stringify({ code: "success", data: "task_upload" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_upload",
            action: "upload_audio",
            status: "SUCCESS",
            data: { clip_id: "clip_uploaded", audio_url: "https://example.com/uploaded.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_upload_audio",
      content: [{ type: "audio", source: { type: "url", url: "https://example.com/input.mp3" } }],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    const output = await promise;
    vi.useRealTimers();

    expect(calls[0]?.url).toBe("https://router.neta.art/suno/uploads/audio");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      name: "reference-audio",
      timeout: 120,
      url: "https://example.com/input.mp3",
    });
    expect(output).toEqual([
      {
        type: "audio",
        source: { type: "url", url: "https://example.com/uploaded.mp3" },
        meta: expect.objectContaining({ clip_id: "clip_uploaded", operation: "upload_audio" }),
      },
    ]);
  });

  it("accepts deprecated request metadata as Suno provider meta", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_metadata" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_metadata",
            action: "music",
            status: "SUCCESS",
            data: { audio_url: "https://example.com/metadata.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_music_chirp_fenix",
      content: [{ type: "text", text: "warm piano" }],
      parameters: { poll_interval: 1, max_wait: 30 },
      metadata: { title: "Legacy Metadata" },
      meta: { tags: "warm piano" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();

    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      title: "Legacy Metadata",
      tags: "warm piano",
    });
  });

  it("normalizes Suno metadataParams aliases before validation and provider payloads", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_metadata_params" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_metadata_params",
            action: "music",
            status: "SUCCESS",
            data: { audio_url: "https://example.com/metadata-params.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_sound_chirp_v5",
      content: [{ type: "text", text: "gentle rain ambience" }],
      parameters: { poll_interval: 1, max_wait: 30 },
      meta: { metadataParams: { sound: "gentle rain ambience" } },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      task: "sound",
      mv: "chirp-v5",
      metadata_params: { sound: "gentle rain ambience" },
    });
    expect(body).not.toHaveProperty("metadataParams");
  });

  it("normalizes content meta metadataParams aliases", async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).endsWith("/suno/submit/music")) {
        return new Response(JSON.stringify({ code: "success", data: "task_content_metadata_params" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          code: "success",
          data: {
            task_id: "task_content_metadata_params",
            action: "music",
            status: "SUCCESS",
            data: { audio_url: "https://example.com/content-metadata-params.mp3" },
          },
        }),
        { status: 200 },
      );
    };

    const client = createGenerationClient({ apiKey: "key", fetch: fetchMock as typeof fetch });
    const promise = client.generate({
      model: "suno_image_to_song_chirp_v5",
      content: [
        {
          type: "text",
          text: "make this image sing",
        },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/image.jpg" },
          meta: {
            metadataParams: { image_url: "https://example.com/image.jpg" },
          },
        },
      ],
      parameters: { poll_interval: 1, max_wait: 30 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toMatchObject({
      task: "image_to_song",
      mv: "chirp-v5",
      metadata_params: { image_url: "https://example.com/image.jpg" },
    });
    expect(body).not.toHaveProperty("metadataParams");
  });
});
