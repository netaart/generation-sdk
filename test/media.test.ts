import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGenerationClient,
  type GenerationContentBlock,
  GenerationMediaReadError,
  type GenerationModelDeclaration,
  GenerationValidationError,
  isPublicAddress,
  publicMediaFetch,
  readGenerationMediaInfo,
  validateGenerationMedia,
} from "../src/index.js";
import { loopbackMediaFetch, MEDIA_FIXTURES, type MediaServer, startMediaServer } from "./helpers/media-server.js";

let media: MediaServer;
beforeAll(async () => {
  media = await startMediaServer();
});
afterAll(() => media.close());

const text = (value: string): GenerationContentBlock => ({ type: "text", text: value });
const block = (
  type: "image" | "video" | "audio",
  path: string,
  role?: string,
): Extract<GenerationContentBlock, { type: "image" | "video" | "audio" }> => ({
  type,
  source: { type: "url", url: media.url(path) },
  ...(role ? { meta: { role } } : {}),
});

function seedance(model: string): GenerationModelDeclaration {
  const declaration = createGenerationClient().getModel(model);
  if (!declaration) throw new Error(`missing builtin model ${model}`);
  return declaration;
}

async function info(type: "image" | "video" | "audio", path: string) {
  return readGenerationMediaInfo(loopbackMediaFetch, block(type, path), {
    label: type,
    signal: AbortSignal.timeout(10_000),
  });
}

async function check(model: string, content: GenerationContentBlock[]) {
  return validateGenerationMedia(seedance(model), content, loopbackMediaFetch);
}

describe("reading media information", () => {
  it("reads the format and size of every accepted image format", async () => {
    const cases = [
      ["image-640x360.png", "png", 640, 360],
      ["image-640x360.jpg", "jpeg", 640, 360],
      ["image-640x360.webp", "webp", 640, 360],
      ["image-640x360.gif", "gif", 640, 360],
      ["image-640x360.heic", "heic", 640, 360],
      ["image-320x320.bmp", "bmp", 320, 320],
      ["image-320x320.tiff", "tiff", 320, 320],
    ] as const;
    for (const [path, format, width, height] of cases) {
      expect(await info("image", path), path).toMatchObject({ format, width, height });
    }
  });

  it("reads the frame rate and duration of mp4 and mov videos", async () => {
    expect(await info("video", "video-854x480-24fps.mp4")).toMatchObject({
      format: "mp4",
      width: 854,
      height: 480,
      fps: 24,
      duration: 3,
    });
    expect(await info("video", "video-854x480-120fps.mp4")).toMatchObject({ fps: 120, duration: 2 });
    expect(await info("video", "video-640x360.mov")).toMatchObject({ format: "mov", width: 640, height: 360, fps: 30 });
  });

  it("reads a video whose moov box sits after the media data with range requests only", async () => {
    const path = "video-854x480-23.976fps-moov-end.mp4";
    const result = await info("video", path);
    expect(result).toMatchObject({ format: "mp4", width: 854, height: 480 });
    expect(result.fps).toBeCloseTo(23.976, 3);
    expect(result.duration).toBeCloseTo(3.003, 3);

    const ranges = media.ranges(path);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(ranges.every((range) => range.startsWith("bytes="))).toBe(true);
    // 中间的媒体数据没有被读取：除第一段之外，所有请求都从 moov 附近开始
    const size = (await readFile(`${MEDIA_FIXTURES}${path}`)).length;
    const starts = ranges.slice(1).map((range) => Number(range.slice("bytes=".length).split("-")[0]));
    expect(Math.min(...starts)).toBeGreaterThan(size - 64 * 1024);
  });

  it("reads the frame rate and duration of a fragmented mp4 from its fragments", async () => {
    expect(await info("video", "video-854x480-30fps-fragmented.mp4")).toMatchObject({
      format: "mp4",
      width: 854,
      height: 480,
      fps: 30,
      duration: 4,
    });
  });

  it("reads a video from a host that ignores range requests", async () => {
    expect(await info("video", "no-range/video-854x480-23.976fps-moov-end.mp4")).toMatchObject({
      format: "mp4",
      width: 854,
      height: 480,
    });
  });

  it("reads the format and duration of audio files", async () => {
    expect(await info("audio", "audio-5s.wav")).toMatchObject({ format: "wav", duration: 5 });
    const mp3 = await info("audio", "audio-20s.mp3");
    expect(mp3.format).toBe("mp3");
    expect(mp3.duration).toBeCloseTo(20, 0);
    expect(await info("audio", "audio-5s.m4a")).toMatchObject({ format: "m4a" });
  });

  it("reports an unknown format for files that are not media", async () => {
    expect(await info("image", "not-media.txt")).toMatchObject({ format: undefined, bytes: 25 });
    expect(await info("video", "not-media.txt")).toMatchObject({ format: undefined });
    expect(await info("audio", "not-media.txt")).toMatchObject({ format: undefined });
  });
});

describe("Seedance media limits", () => {
  it("accepts files inside every limit", async () => {
    await expect(
      check("seedance-2-0-fast", [
        text("follow the references"),
        block("image", "image-640x360.heic", "reference_image"),
        block("image", "image-320x320.tiff", "reference_image"),
        block("video", "video-854x480-23.976fps-moov-end.mp4", "reference_video"),
        block("audio", "audio-10s.mp3", "reference_audio"),
      ]),
    ).resolves.toBeUndefined();
  });

  it.each([
    [
      "an image narrower than 300 px",
      ["image", "image-200x720.png", "reference_image"],
      "reference_image (content[1]): width 200 px is outside 300–6000 px; resize it",
    ],
    [
      "an image wider than 2.5:1",
      ["image", "image-1600x600.png", "first_frame"],
      "first_frame (content[1]): aspect ratio (width/height) 2.667 is outside 0.4–2.5; crop or pad it",
    ],
    [
      "a file that is not an image",
      ["image", "not-media.txt"],
      "image (content[1]): the file format is not recognized; convert it to jpeg, png, webp, bmp, tiff, gif, heic, heif",
    ],
    [
      "a 120 fps video",
      ["video", "video-854x480-120fps.mp4", "reference_video"],
      "reference_video (content[1]): frame rate 120 fps is outside 23.8–60 fps; re-encode it at a constant 24 or 30 fps",
    ],
    [
      "a video below the pixel count",
      ["video", "video-640x360.mov", "reference_video"],
      "reference_video (content[1]): pixel count (width × height) 230400 is outside 407696–8295044; scale it",
    ],
    [
      "a 1 s video",
      ["video", "video-854x480-1s.mp4", "reference_video"],
      "reference_video (content[1]): duration 1 s is outside 1.8–15.2 s; trim it or use a longer file",
    ],
    [
      "a 20 s video",
      ["video", "video-854x480-20s.mp4", "reference_video"],
      "reference_video (content[1]): duration 20 s is outside 1.8–15.2 s; trim it or use a longer file",
    ],
    [
      "an m4a audio file",
      ["audio", "audio-5s.m4a", "reference_audio"],
      "reference_audio (content[1]): format m4a is not accepted; convert it to wav, mp3",
    ],
    [
      "a 1 s audio file",
      ["audio", "audio-1s.wav", "reference_audio"],
      "reference_audio (content[1]): duration 1 s is outside 1.8–15.2 s; trim it or use a longer file",
    ],
  ] as const)("rejects %s with the measured value, the limit, and a fix", async (_name, file, message) => {
    const [type, path, role] = file;
    const error = await check("seedance-2-0-fast", [text("prompt"), block(type, path, role)]).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(GenerationValidationError);
    expect((error as Error).message).toBe(message);
  });

  it("rejects reference audio whose total length is over the limit", async () => {
    await expect(
      check("seedance-2-0-fast", [
        text("prompt"),
        block("image", "image-640x360.png"),
        block("audio", "audio-10s.mp3", "reference_audio"),
        block("audio", "audio-10s.mp3", "reference_audio"),
      ]),
    ).rejects.toThrow(
      /^audio inputs: total duration 20\.\d+ s is outside at most 15\.2 s; use fewer or shorter files$/,
    );
  });

  it("accepts a 20 s reference video and audio on Seedance 2.5", async () => {
    await expect(
      check("seedance-2-5", [
        text("prompt"),
        block("video", "video-854x480-20s.mp4", "reference_video"),
        block("audio", "audio-20s.mp3", "reference_audio"),
      ]),
    ).resolves.toBeUndefined();
  });

  it("rejects files over the size limit from the declared length, the stream, or base64 data", async () => {
    const declaration = seedance("seedance-2-0-fast");
    const small: GenerationModelDeclaration = {
      ...declaration,
      content: {
        input: declaration.content.input.map((spec) =>
          spec.media ? { ...spec, media: { ...spec.media, maxBytes: 1024 * 1024 * 0.01 } } : spec,
        ),
      },
    };
    const run = (item: GenerationContentBlock) =>
      validateGenerationMedia(small, [text("prompt"), item], loopbackMediaFetch);

    await expect(run(block("image", "image-640x360.gif"))).rejects.toThrow(
      "image (content[1]): the file is 0.013 MB, above the 0.01 MB limit; compress it or use a smaller file",
    );
    await expect(run(block("video", "no-range/video-854x480-24fps.mp4", "reference_video"))).rejects.toThrow(
      "reference_video (content[1]): the file is larger than 0.01 MB, above the 0.01 MB limit",
    );
    await expect(run(block("video", "video-854x480-24fps.mp4", "reference_video"))).rejects.toThrow(
      "reference_video (content[1]): the file is 0.041 MB, above the 0.01 MB limit",
    );
    const data = (await readFile(`${MEDIA_FIXTURES}audio-5s.wav`)).toString("base64");
    await expect(
      run({
        type: "audio",
        source: { type: "base64", mediaType: "audio/wav", data },
        meta: { role: "reference_audio" },
      }),
    ).rejects.toThrow("reference_audio (content[1]): the file is 0.076 MB, above the 0.01 MB limit");
  });

  it("treats a 4xx reply as invalid input and a 5xx reply or a refused connection as a read failure", async () => {
    const notFound = await check("seedance-2-0-fast", [text("prompt"), block("image", "status/404")]).catch(
      (value: unknown) => value,
    );
    expect(notFound).toBeInstanceOf(GenerationValidationError);
    expect((notFound as Error).message).toBe(
      "image (content[1]): the URL returned HTTP 404; use a URL that serves the file",
    );

    const unavailable = await check("seedance-2-0-fast", [text("prompt"), block("image", "status/503")]).catch(
      (value: unknown) => value,
    );
    expect(unavailable).toBeInstanceOf(GenerationMediaReadError);
    expect((unavailable as Error).message).toMatch(
      /^Could not read image \(content\[1\]\) from 127\.0\.0\.1:\d+: HTTP 503$/,
    );

    const port = await closedPort();
    const refused = await validateGenerationMedia(
      seedance("seedance-2-0-fast"),
      [text("prompt"), { type: "image", source: { type: "url", url: `http://127.0.0.1:${port}/a.png` } }],
      loopbackMediaFetch,
    ).catch((value: unknown) => value);
    expect(refused).toBeInstanceOf(GenerationMediaReadError);
  });

  it("follows redirects to the media file", async () => {
    await expect(
      check("seedance-2-0-fast", [text("prompt"), block("image", "redirect/image-640x360.png")]),
    ).resolves.toBeUndefined();
  });

  it("does not read media before generate() is called", async () => {
    const client = createGenerationClient({
      apiKey: "key",
      mediaFetch: () => {
        throw new Error("validate() must not read media");
      },
    });
    expect(
      client.validate({
        model: "seedance-2-0-fast",
        content: [text("prompt"), block("video", "video-854x480-120fps.mp4", "reference_video")],
      }),
    ).toMatchObject({ declaration: { model: "seedance-2-0-fast" } });
  });

  it("checks media in generate() before the provider is called", async () => {
    let providerCalls = 0;
    const client = createGenerationClient({
      apiKey: "key",
      mediaFetch: loopbackMediaFetch,
      fetch: async () => {
        providerCalls += 1;
        return new Response("{}");
      },
    });
    await expect(
      client.generate({
        model: "seedance-2-0",
        content: [text("prompt"), block("video", "video-854x480-120fps.mp4", "reference_video")],
      }),
    ).rejects.toThrow("frame rate 120 fps is outside 23.8–60 fps");
    expect(providerCalls).toBe(0);
  });
});

describe("public media fetch", () => {
  it("classifies only globally routable unicast addresses as public", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.100.100.200",
      "0.0.0.0",
      "255.255.255.255",
      "224.0.0.1",
      "::1",
      "::",
      "fc00::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "not-an-address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses private, loopback, and metadata hosts by literal address or by DNS name", async () => {
    const signal = AbortSignal.timeout(10_000);
    const port = new URL(media.url("")).port;
    for (const url of [
      media.url("image-640x360.png"),
      `http://localhost:${port}/image-640x360.png`,
      `http://[::1]:${port}/image-640x360.png`,
      "http://10.0.0.1/a.png",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.100.200/latest/meta-data/",
      "http://[::ffff:127.0.0.1]/a.png",
    ]) {
      const error = await publicMediaFetch(url, { headers: {}, signal }).catch((value: unknown) => value);
      expect(error, url).toBeInstanceOf(GenerationValidationError);
      expect((error as Error).message, url).toMatch(/^Media URL must point to a public host: /);
    }
    await expect(publicMediaFetch("file:///etc/passwd", { headers: {}, signal })).rejects.toThrow(
      "Media URL must use http or https: file:",
    );
  });

  it("is the default media fetch of the client", async () => {
    const client = createGenerationClient({
      apiKey: "key",
      fetch: async () => {
        throw new Error("provider should not be called");
      },
    });
    await expect(
      client.generate({ model: "seedance-2-0-fast", content: [text("prompt"), block("image", "image-640x360.png")] }),
    ).rejects.toThrow("image (content[1]): Media URL must point to a public host: 127.0.0.1");
  });
});

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}
