import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createGenerationClient,
  type GenerateRequest,
  GenerationValidationError,
  readGenerationModelDeclarationsFromDirectory,
} from "../src/index.js";

import { type MediaServer, startMediaServer } from "./helpers/media-server.js";

const videoFile = "video-854x480-24fps.mp4";
let media: MediaServer;
beforeAll(async () => {
  media = await startMediaServer();
});
afterEach(() => {
  expect(media.ranges(videoFile)).toEqual([]);
});
afterAll(() => media.close());

function request(parameters: Record<string, unknown> = {}): GenerateRequest {
  return {
    model: "seedance-2-5",
    content: [
      { type: "text", text: "Keep the supplied video's shots and dialogue, improve the lighting." },
      {
        type: "video",
        source: { type: "url", url: media.url(videoFile) },
        meta: { role: "reference_video" },
      },
    ],
    parameters,
  };
}

// 本地校验必须先于凭据检查、素材读取和生成请求执行。
const client = createGenerationClient();

describe("Seedance 2.5 reference video intent", () => {
  it.each([20, 28, 30])("rejects the incident request with duration %s before generating", async (duration) => {
    const input = request({ duration, ratio: "adaptive", resolution: "1080p", max_wait: 1500 });
    expect(() => client.validate(input)).toThrow("reference_video requires parameters.video_mode");
    await expect(client.generate(input)).rejects.toBeInstanceOf(GenerationValidationError);
    await expect(client.generateResult(input)).rejects.toThrow(
      "edit and extend require duration=-1 and ratio=adaptive",
    );
  });

  it("requires explicit intent even when the duration and ratio are automatic", () => {
    expect(() => client.validate(request({ duration: -1, ratio: "adaptive" }))).toThrow(
      "reference_video requires parameters.video_mode",
    );
  });

  it.each(["edit", "extend"])("rejects fixed and omitted duration for %s", async (videoMode) => {
    for (const duration of [undefined, 4, 20, 28, 30]) {
      const input = request({ video_mode: videoMode, duration, ratio: "adaptive" });
      const message = `Seedance 2.5 video_mode=${videoMode} requires duration=-1 (automatic duration), got ${duration ?? 5}; set parameters.duration to -1`;
      expect(() => client.validate(input)).toThrow(message);
      await expect(client.generate(input)).rejects.toThrow(message);
    }
  });

  it.each(["edit", "extend"])("rejects fixed and omitted ratio for %s", async (videoMode) => {
    for (const ratio of [undefined, "16:9", "9:16"]) {
      const input = request({ video_mode: videoMode, duration: -1, ratio });
      const message = `Seedance 2.5 video_mode=${videoMode} requires ratio=adaptive, got "${ratio ?? "16:9"}"; set parameters.ratio to "adaptive"`;
      expect(() => client.validate(input)).toThrow(message);
      await expect(client.generate(input)).rejects.toThrow(message);
    }
  });

  it.each(["edit", "extend"])("accepts automatic duration and ratio for %s", (videoMode) => {
    const input = request({ video_mode: videoMode, duration: -1, ratio: "adaptive" });
    expect(client.validate(input).parameters).toMatchObject({
      video_mode: videoMode,
      duration: -1,
      ratio: "adaptive",
    });
  });

  it.each([4, 20, 28, 30, -1])("accepts duration %s for reference generation", (duration) => {
    const input = request({ video_mode: "reference", duration, ratio: "9:16" });
    input.content = [
      { type: "text", text: "Create a new scene using the motion style from the supplied video." },
      ...input.content.filter((block) => block.type === "video"),
    ];
    expect(client.validate(input).parameters).toMatchObject({
      video_mode: "reference",
      duration,
      ratio: "9:16",
    });
  });

  it("accepts the reference generation defaults", () => {
    expect(client.validate(request({ video_mode: "reference" })).parameters).toMatchObject({
      video_mode: "reference",
      duration: 5,
      ratio: "16:9",
    });
  });

  it.each(["reference", "edit", "extend"])("rejects %s mode without reference video", (videoMode) => {
    expect(() =>
      client.validate({
        ...request({ video_mode: videoMode, duration: -1, ratio: "adaptive" }),
        content: [{ type: "text", text: "A river at dawn." }],
      }),
    ).toThrow("Seedance 2.5 video_mode requires reference_video content");
  });

  it("rejects unknown or incorrectly typed video modes", () => {
    for (const videoMode of ["automatic", "", null, 1]) {
      expect(() => client.validate(request({ video_mode: videoMode }))).toThrow(GenerationValidationError);
    }
  });

  it("keeps ordinary generation and other Seedance models available", () => {
    for (const model of ["seedance-2-0", "seedance-2-0-fast"]) {
      expect(client.validate({ ...request({ duration: 10, ratio: "16:9" }), model }).parameters).toMatchObject({
        duration: 10,
        ratio: "16:9",
      });
    }
    expect(
      client.validate({
        model: "seedance-2-5",
        content: [{ type: "text", text: "A river at dawn." }],
        parameters: { duration: 30, ratio: "9:16" },
      }).parameters,
    ).toMatchObject({ duration: 30, ratio: "9:16" });
  });

  it("publishes the same validation contract in the shipped YAML", async () => {
    const models = await readGenerationModelDeclarationsFromDirectory(join(process.cwd(), "models"));
    const configured = createGenerationClient({ models, includeBuiltinModels: false });
    expect(configured.getModel("seedance-2-5")?.parameters).toEqual(client.getModel("seedance-2-5")?.parameters);
    expect(() => configured.validate(request({ duration: 28, ratio: "adaptive" }))).toThrow(
      "reference_video requires parameters.video_mode",
    );
    expect(() => configured.validate(request({ video_mode: "edit", duration: 28, ratio: "adaptive" }))).toThrow(
      "video_mode=edit requires duration=-1",
    );
    expect(
      configured.validate(request({ video_mode: "edit", duration: -1, ratio: "adaptive" })).parameters,
    ).toMatchObject({ video_mode: "edit", duration: -1, ratio: "adaptive" });
  });
});
