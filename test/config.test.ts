import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isScalar, isSeq, parseDocument, parse as parseYaml } from "yaml";
import {
  createGenerationClient,
  exportBuiltinModelConfig,
  type GenerationContentBlock,
  type GenerationModelDeclaration,
  parseGenerationModelDeclaration,
  readGenerationModelDeclarationsFromDirectory,
  stringifyBuiltinModelConfig,
  stringifyGenerationModelDeclaration,
} from "../src/index.js";

function contentInputs(declaration: GenerationModelDeclaration) {
  return [
    ...declaration.content.input,
    ...Object.values(declaration.operations ?? {}).flatMap((operation) => operation.content?.input ?? []),
  ];
}

describe("config", () => {
  it("roundtrips a built-in model declaration", () => {
    const raw = stringifyBuiltinModelConfig("gpt-image-2");
    const declaration = parseGenerationModelDeclaration(raw, "gpt-image-2.yaml");
    expect(declaration.schema).toBe("neta.generation.model.v1");
    expect(declaration.model).toBe("gpt-image-2");
    expect(declaration.category).toBe("image");
  });

  it("assigns catalog categories for published product models", async () => {
    const client = createGenerationClient({ apiKey: "test" });
    const expected = {
      image: [
        "birefnet-general",
        "gemini-3.1-flash-image-preview",
        "gemini-3.1-flash-lite-image",
        "gpt-image-2",
        "krea2",
        "noobxl-i2i-ipa-onediff",
        "noobxl-t2i-onediff",
        "qwen-image-edit",
        "z-image-turbo",
      ],
      video: [
        "kling-image-to-video",
        "kling-multi-image-to-video",
        "kling-omni-video",
        "kling-text-to-video",
        "minimax-h3",
        "minimax-h3-unrestricted",
        "seedance-2-0",
        "seedance-2-0-fast",
        "seedance-2-5",
        "video-upscale-native",
      ],
      audio: ["song2", "suno_music_chirp_fenix"],
      "3d": ["meshy"],
      decision: ["jev-1.13.0", "jev-latest", "openai/gpt-6-luna-decisions"],
    } as const;

    const byCategory = {
      image: client
        .listModels()
        .filter((model) => model.category === "image")
        .map((model) => model.model),
      video: client
        .listModels()
        .filter((model) => model.category === "video")
        .map((model) => model.model),
      audio: client
        .listModels()
        .filter((model) => model.category === "audio")
        .map((model) => model.model),
      "3d": client
        .listModels()
        .filter((model) => model.category === "3d")
        .map((model) => model.model),
      decision: client
        .listModels()
        .filter((model) => model.category === "decision")
        .map((model) => model.model),
    };

    expect(byCategory.image.sort()).toEqual([...expected.image]);
    expect(byCategory.video.sort()).toEqual([...expected.video]);
    expect(byCategory.audio.sort()).toEqual([...expected.audio]);
    expect(byCategory["3d"].sort()).toEqual([...expected["3d"]]);
    expect(byCategory.decision.sort()).toEqual([...expected.decision]);
    for (const model of [
      "higgs-tts",
      "qwen-tts",
      "qwen-audio-3.0-tts-plus",
      "qwen-audio-3.0-tts-flash",
      "suno_cover_chirp_v5",
      "suno_image_to_song_chirp_v5",
      "suno_infill_chirp_v5",
      "suno_sound_chirp_v5",
      "suno_style_tags",
      "suno_upload_audio",
      "suno_video_to_song_chirp_v5",
      "suno_vox_chirp_v5",
    ]) {
      expect(client.getModel(model)?.category, model).toBeUndefined();
    }
    expect(
      byCategory.image.length +
        byCategory.video.length +
        byCategory.audio.length +
        byCategory["3d"].length +
        byCategory.decision.length,
    ).toBe(client.listModels().filter((model) => model.category !== undefined).length);

    const files = await readGenerationModelDeclarationsFromDirectory(join(process.cwd(), "models"));
    expect(files.map((model) => [model.model, model.category]).sort()).toEqual(
      client
        .listModels()
        .map((model) => [model.model, model.category])
        .sort(),
    );
  });

  it("accepts older v1 declarations that omit category", () => {
    const valid = stringifyBuiltinModelConfig("gpt-image-2", { format: "json" });
    const parsed = JSON.parse(valid) as Record<string, unknown>;
    const withoutCategory = { ...parsed };
    delete withoutCategory.category;

    const declaration = parseGenerationModelDeclaration(JSON.stringify(withoutCategory), "gpt-image-2.json");
    expect(declaration.model).toBe("gpt-image-2");
    expect(declaration.category).toBeUndefined();
  });

  it("rejects model declarations with an invalid category", () => {
    const valid = stringifyBuiltinModelConfig("gpt-image-2", { format: "json" });
    const parsed = JSON.parse(valid) as Record<string, unknown>;

    expect(() =>
      parseGenerationModelDeclaration(JSON.stringify({ ...parsed, category: "music" }), "gpt-image-2.json"),
    ).toThrow("Invalid model declaration: gpt-image-2.json");
    expect(() =>
      parseGenerationModelDeclaration(JSON.stringify({ ...parsed, category: "outputType" }), "gpt-image-2.json"),
    ).toThrow("Invalid model declaration: gpt-image-2.json");
    expect(() =>
      parseGenerationModelDeclaration(JSON.stringify({ ...parsed, category: null }), "gpt-image-2.json"),
    ).toThrow("Invalid model declaration: gpt-image-2.json");

    expect(
      parseGenerationModelDeclaration(JSON.stringify({ ...parsed, category: "audio" }), "gpt-image-2.json").category,
    ).toBe("audio");
  });

  it("roundtrips optional pricing and accepts declarations that omit it", () => {
    const valid = stringifyBuiltinModelConfig("gpt-image-2", { format: "json" });
    const parsed = JSON.parse(valid) as Record<string, unknown>;

    expect(parseGenerationModelDeclaration(valid, "gpt-image-2.json").pricing).toBeUndefined();

    const fixed = parseGenerationModelDeclaration(
      JSON.stringify({ ...parsed, pricing: { unit: "image", amount: 0.007 } }),
      "gpt-image-2.json",
    );
    expect(fixed.pricing).toEqual({ unit: "image", amount: 0.007 });
    expect(
      parseGenerationModelDeclaration(stringifyGenerationModelDeclaration(fixed), "gpt-image-2.yaml").pricing,
    ).toEqual({ unit: "image", amount: 0.007 });

    const ranged = parseGenerationModelDeclaration(
      JSON.stringify({ ...parsed, pricing: { unit: "second", min: 0.126, max: 0.168, note: "std\u2013pro" } }),
      "gpt-image-2.json",
    );
    expect(ranged.pricing).toEqual({ unit: "second", min: 0.126, max: 0.168, note: "std\u2013pro" });

    expect(
      parseGenerationModelDeclaration(
        JSON.stringify({ ...parsed, pricing: { unit: "1m_tokens", amount: 140 } }),
        "gpt-image-2.json",
      ).pricing,
    ).toEqual({ unit: "1m_tokens", amount: 140 });
  });

  it("rejects model declarations with invalid pricing", () => {
    const valid = stringifyBuiltinModelConfig("gpt-image-2", { format: "json" });
    const parsed = JSON.parse(valid) as Record<string, unknown>;

    const invalid = [
      null,
      "image",
      [],
      { unit: "token", amount: 1 },
      { unit: "image" },
      { unit: "image", amount: 1, min: 1, max: 2 },
      { unit: "image", amount: -1 },
      { unit: "image", min: 2, max: 1 },
      { unit: "image", min: 1 },
      { unit: "image", max: 1 },
      { unit: "image", min: Number.NaN, max: 1 },
      { unit: "image", amount: 1, note: 5 },
    ];

    for (const pricing of invalid) {
      expect(() => parseGenerationModelDeclaration(JSON.stringify({ ...parsed, pricing }), "gpt-image-2.json")).toThrow(
        "Invalid model declaration: gpt-image-2.json",
      );
    }
  });

  it("accepts array and stepped number parameter specs and rejects malformed ones", () => {
    const parsed = JSON.parse(stringifyBuiltinModelConfig("gpt-image-2", { format: "json" })) as Record<
      string,
      unknown
    >;
    const withParameter = (spec: unknown) =>
      JSON.stringify({ ...parsed, parameters: { ...(parsed.parameters as object), extra: spec } });

    for (const spec of [
      {
        type: "array",
        items: { type: "string", enum: ["glb", "fbx"] },
        min: 1,
        max: 2,
        unique: true,
        default: ["glb"],
      },
      { type: "array", optional: true, items: { type: "integer", min: 0, max: 9 }, min: 0 },
      { type: "number", min: 2, max: 10, multipleOf: 0.5 },
      { type: "integer", multipleOf: 2 },
    ]) {
      expect(parseGenerationModelDeclaration(withParameter(spec), "gpt-image-2.json").parameters?.extra).toEqual(spec);
    }
    for (const spec of [
      { type: "array" },
      { type: "array", items: { type: "boolean" } },
      { type: "array", items: { type: "string", enum: [1] } },
      { type: "array", items: { type: "integer" }, min: -1 },
      { type: "array", items: { type: "integer" }, min: 1.5 },
      { type: "array", items: { type: "integer" }, min: 3, max: 2 },
      { type: "array", items: { type: "integer" }, unique: "yes" },
      { type: "number", multipleOf: 0 },
      { type: "integer", multipleOf: "2" },
    ]) {
      expect(
        () => parseGenerationModelDeclaration(withParameter(spec), "gpt-image-2.json"),
        JSON.stringify(spec),
      ).toThrow("Invalid model declaration: gpt-image-2.json");
    }
  });

  it("roundtrips built-in model meta declarations", () => {
    const raw = stringifyBuiltinModelConfig("suno_image_to_song_chirp_v5");
    const declaration = parseGenerationModelDeclaration(raw, "suno_image_to_song_chirp_v5.yaml");
    expect(declaration.adapter).toMatchObject({
      operation: "music",
      task: "image_to_song",
      payload: { mv: "chirp-v5" },
    });
    expect(declaration.meta?.taskVariants?.image_to_song).toMatchObject({
      requiredContent: ["image"],
      required: ["metadata_params"],
    });
  });

  it("does not expose the removed legacy Suno model", () => {
    const client = createGenerationClient({ apiKey: "test" });
    expect(client.getModel("suno_music")).toBeNull();
    expect(() =>
      client.validate({
        model: "suno_music",
        content: [{ type: "text", text: "warm piano" }],
      }),
    ).toThrow("Generation model is unavailable: suno_music");
    expect(() => client.stringifyModelConfig("suno_music")).toThrow("Generation model is unavailable: suno_music");
  });

  it("keeps infrastructure names out of model descriptions", () => {
    const client = createGenerationClient({ apiKey: "test" });
    for (const model of client.listModels()) {
      expect(model.description, model.model).not.toMatch(/\b(?:router|new[ -]?api)\b/i);
    }
  });

  it("publishes agent-discoverable audio speech declarations", () => {
    const client = createGenerationClient();
    const qwenModels = ["qwen-tts", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"];

    for (const model of qwenModels) {
      const declaration = client.getModel(model);
      expect(declaration?.description).toContain("Modes: voice_prompt design OR one-reference clone");
      expect(declaration?.description).not.toMatch(/Higgs|stronger|HTTP|URL/i);
      expect(declaration?.content.input.find((input) => input.type === "text")?.description).toContain(
        "Exactly one non-empty text block",
      );
      expect(declaration?.content.input.find((input) => input.type === "audio")?.description).toContain(
        "no voice_prompt",
      );
      expect(declaration?.content.input.find((input) => input.type === "audio")?.description).toContain(
        "Dependency: use prior generated audio",
      );
      expect(declaration?.meta?.fields?.voice_prompt?.description).toContain("no reference audio");
      expect(declaration?.examples?.map((example) => example.title)).toEqual(["Voice design", "Voice clone"]);
      expect(JSON.parse(client.stringifyModelConfig(model, { format: "json" }))).toEqual(declaration);
    }

    const qwen = client.getModel("qwen-tts");
    expect(qwen?.description).toBe(
      "Modes: voice_prompt design OR one-reference clone. Default: unspecified Qwen design. Text: any length. Conflict: ask user; never combine/reinterpret. Dependency: clone prior generated audio.",
    );
    expect(qwen?.content.input.find((input) => input.type === "text")?.description).not.toContain(
      "Unicode code points",
    );

    const plus = client.getModel("qwen-audio-3.0-tts-plus");
    expect(plus?.description).toBe(
      "Modes: voice_prompt design OR one-reference clone. Text: >=15 Unicode code points. Conflict: ask user; never combine/reinterpret. Dependency: clone prior generated audio.",
    );
    expect(plus?.content.input.find((input) => input.type === "text")?.description).toContain(
      "at least 15 Unicode code points",
    );

    const flash = client.getModel("qwen-audio-3.0-tts-flash");
    expect(flash?.description).toBe(
      "Modes: voice_prompt design OR one-reference clone. Text: >=15 Unicode code points. Conflict: ask user; never combine/reinterpret. Dependency: clone prior generated audio.",
    );
    expect(flash?.content.input.find((input) => input.type === "text")?.description).toContain(
      "at least 15 Unicode code points",
    );

    const higgs = client.getModel("higgs-tts");
    expect(higgs?.description).toBe(
      "Modes: built-in; one-reference high-fidelity clone; weighted 2-16-reference blend. Default: delegated generic voice (natural/suitable). Blend: all references, full text, one request. Conflict: clone + redesign; ask user, do not reinterpret. Dependency: clone prior generated audio.",
    );
    expect(higgs?.description).not.toMatch(/Qwen|stronger|HTTP|URL/i);
    expect(higgs?.content.input.find((input) => input.type === "audio")?.description).toContain(
      "2-16 require positive finite weights",
    );
    expect(higgs?.content.input.find((input) => input.type === "audio")?.description).toContain(
      "Dependency: use prior generated audio",
    );
    expect(higgs?.examples?.map((example) => example.title)).toEqual([
      "Default voice",
      "Single reference",
      "Weighted single reference",
      "Multiple references",
    ]);
    expect(JSON.parse(client.stringifyModelConfig("higgs-tts", { format: "json" }))).toEqual(higgs);
  });

  it("keeps model discovery on the existing package exports", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports ?? {})).toEqual([".", "./models"]);
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    expect(readme).not.toContain("@neta-art/generation/models/");
    expect(readme).toContain("Qwen: `voice_prompt` design OR one-reference clone");
    expect(readme).toContain("Higgs: delegated default voice, high-fidelity one-reference clone");
    expect(readme).toContain("Conflict: reference + redesign requires user choice before generation");
    expect(readme).toContain("Blend: all references, full text, one request");
    expect(readme).toContain("Dependency: clone prior generated audio");
    expect(readme).toContain("Ranking: no declared Qwen quality, latency, or cost order");
    expect(readme).not.toMatch(/quality prioritized over latency|latency prioritized over maximum quality/);
  });

  it("does not advertise base64 input sources in model YAML", async () => {
    const models = await readGenerationModelDeclarationsFromDirectory(join(process.cwd(), "models"));
    for (const model of models) {
      for (const input of contentInputs(model)) {
        expect(input.sources ?? [], `${model.model}: ${input.type}`).not.toContain("base64");
      }
    }
  });

  it("keeps base64 compatibility in the runtime model declarations", () => {
    const client = createGenerationClient({ apiKey: "test" });
    const models = client
      .listModels()
      .filter((model) => model.content.input.some((input) => input.sources?.includes("base64")))
      .map((model) => model.model);

    expect(models).toEqual([
      "birefnet-general",
      "gemini-3.1-flash-image-preview",
      "gemini-3.1-flash-lite-image",
      "gpt-image-2",
      "kling-image-to-video",
      "kling-multi-image-to-video",
      "kling-omni-video",
      "noobxl-i2i-ipa-onediff",
      "suno_image_to_song_chirp_v5",
      "suno_upload_audio",
      "suno_video_to_song_chirp_v5",
    ]);
  });

  it("keeps krea2 text-only", () => {
    const client = createGenerationClient({ apiKey: "test" });
    expect(client.getModel("krea2")?.content.input.map((input) => input.type)).toEqual(["text"]);
    expect(() =>
      client.validate({
        model: "krea2",
        content: [
          { type: "text", text: "an editorial portrait" },
          { type: "image", source: { type: "url", url: "https://example.com/reference.png" } },
        ],
      }),
    ).toThrow("Content block type is not supported by krea2: image");
  });

  it("accepts an ignored BiRefNet workflow prompt", () => {
    const client = createGenerationClient({ apiKey: "test" });
    const image = { type: "image" as const, source: { type: "url" as const, url: "https://example.com/source.png" } };

    expect(client.getModel("birefnet-general")?.content.input.map((input) => input.type)).toEqual(["text", "image"]);
    expect(() => client.validate({ model: "birefnet-general", content: [image] })).not.toThrow();
    expect(() =>
      client.validate({
        model: "birefnet-general",
        content: [{ type: "text", text: "remove the background" }, image],
      }),
    ).not.toThrow();
  });

  it("enforces valid krea2 image sizes", () => {
    const client = createGenerationClient({ apiKey: "test" });
    const size = client.getModel("krea2")?.parameters?.size;
    if (!size || size.type !== "string") throw new Error("krea2 size parameter is unavailable");
    expect(size.dimensions).toEqual({ min: 256, max: 1024, multipleOf: 16 });

    for (const value of [size.default, ...(size.examples ?? [])]) {
      const resolved = client.validate({
        model: "krea2",
        content: [{ type: "text", text: "an editorial portrait" }],
        parameters: { size: value },
      });
      expect(resolved.parameters.size).toBe(value);
    }

    const requestWithSize = (value: string) => ({
      model: "krea2",
      content: [{ type: "text" as const, text: "an editorial portrait" }],
      parameters: { size: value },
    });
    expect(() => client.validate(requestWithSize("1024"))).toThrow("Parameter size must be formatted as WIDTHxHEIGHT");
    expect(() => client.validate(requestWithSize("240x1024"))).toThrow("Parameter size dimensions must be >= 256");
    expect(() => client.validate(requestWithSize("1040x1024"))).toThrow("Parameter size dimensions must be <= 1024");
    expect(() => client.validate(requestWithSize("1000x1024"))).toThrow(
      "Parameter size dimensions must be multiples of 16",
    );
  });

  it("does not expose unsupported krea2 quality settings", () => {
    const client = createGenerationClient({ apiKey: "test" });
    expect(client.getModel("krea2")?.parameters).not.toHaveProperty("quality");
    expect(() =>
      client.validate({
        model: "krea2",
        content: [{ type: "text", text: "an editorial portrait" }],
        parameters: { quality: "high" },
      }),
    ).toThrow("Unknown parameter: quality");
  });

  it("keeps Gemini Lite output fixed at 1K", () => {
    const client = createGenerationClient({ apiKey: "test" });
    const lite = client.getModel("gemini-3.1-flash-lite-image");
    const preview = client.getModel("gemini-3.1-flash-image-preview");

    expect(lite?.parameters).not.toHaveProperty("image_size");
    expect(preview?.parameters?.image_size).toMatchObject({
      default: "2K",
      enum: ["512", "1K", "2K", "4K"],
    });
    expect(() =>
      client.validate({
        model: "gemini-3.1-flash-lite-image",
        content: [{ type: "text", text: "a product photo" }],
        parameters: { image_size: "2K" },
      }),
    ).toThrow("Unknown parameter: image_size");
  });

  it("uses ratio as the only Seedance aspect-ratio parameter", () => {
    const client = createGenerationClient({ apiKey: "test" });
    for (const model of ["seedance-2-0", "seedance-2-0-fast", "seedance-2-5"]) {
      expect(client.getModel(model)?.parameters).toHaveProperty("ratio");
      expect(client.getModel(model)?.parameters).not.toHaveProperty("aspect_ratio");
    }
  });

  it("keeps provider-managed Seedance parameters internal", () => {
    const client = createGenerationClient({ apiKey: "test" });
    for (const model of ["seedance-2-0", "seedance-2-0-fast", "seedance-2-5"]) {
      for (const parameter of ["fps", "generate_audio", "return_last_frame", "watermark"]) {
        expect(client.getModel(model)?.parameters).not.toHaveProperty(parameter);
      }
    }
  });

  it("publishes both MiniMax H3 model declarations without local size limits", () => {
    const client = createGenerationClient({ apiKey: "test" });

    for (const model of ["minimax-h3", "minimax-h3-unrestricted"]) {
      const declaration = client.getModel(model);
      expect(declaration?.category, model).toBe("video");
      expect(declaration?.adapter).toEqual({ type: "minimax.h3VideoGenerations" });
      expect(declaration?.parameters?.resolution).toMatchObject({
        type: "string",
        default: "768P",
      });
      expect(declaration?.parameters?.resolution).not.toHaveProperty("enum");

      const resolved = client.validate({
        model,
        content: [{ type: "text", text: "a simple motion study" }],
        parameters: { duration: 42, resolution: model === "minimax-h3-unrestricted" ? "1920x1080" : "4K" },
      });
      expect(resolved.parameters).toMatchObject({
        duration: 42,
        resolution: model === "minimax-h3-unrestricted" ? "1920x1080" : "4K",
      });
    }
  });

  it("publishes model-specific Seedance resolutions", () => {
    const client = createGenerationClient({ apiKey: "test" });

    expect(client.getModel("seedance-2-0")?.parameters?.resolution).toMatchObject({
      default: "1080p",
      enum: ["480p", "720p", "1080p", "2K"],
    });
    expect(client.getModel("seedance-2-0-fast")?.parameters?.resolution).toMatchObject({
      default: "720p",
      enum: ["480p", "720p"],
    });
    expect(client.getModel("seedance-2-5")?.parameters?.resolution).toMatchObject({
      default: "1080p",
      enum: ["480p", "720p", "1080p"],
    });
    expect(client.getModel("seedance-2-0")?.pricing).toEqual({
      unit: "1m_tokens",
      min: 2.4,
      max: 7.7,
      note: "BytePlus list USD; varies by resolution and video input",
    });
    expect(client.getModel("seedance-2-0-fast")?.pricing).toEqual({
      unit: "1m_tokens",
      min: 3.3,
      max: 5.6,
      note: "BytePlus list USD; varies by resolution and video input",
    });
    expect(client.getModel("seedance-2-5")?.pricing).toEqual({
      unit: "1m_tokens",
      min: 6.4,
      max: 11.7,
      note: "BytePlus list USD; varies by resolution and video input",
    });
    expect(() =>
      client.validate({
        model: "seedance-2-0-fast",
        content: [{ type: "text", text: "a quick motion study" }],
        parameters: { resolution: "1080p" },
      }),
    ).toThrow("Parameter resolution must be one of: 480p, 720p");
    expect(() =>
      client.validate({
        model: "seedance-2-5",
        content: [{ type: "text", text: "a quick motion study" }],
        parameters: { resolution: "2K" },
      }),
    ).toThrow("Parameter resolution must be one of: 480p, 720p, 1080p");
  });

  it("publishes the supported NoobXL image sizes", () => {
    const client = createGenerationClient({ apiKey: "test" });
    const expected = ["1024x1024", "896x1152", "1152x896", "1344x768", "768x1344"];

    for (const model of ["noobxl-t2i-onediff", "noobxl-i2i-ipa-onediff"]) {
      const size = client.getModel(model)?.parameters?.size;
      expect(size, model).toMatchObject({ type: "string", default: "1024x1024", enum: expected });
    }
  });

  it("does not publish the retired Qwen preview field", async () => {
    const client = createGenerationClient({ apiKey: "test" });
    for (const model of ["qwen-tts", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"]) {
      expect(client.stringifyModelConfig(model)).not.toContain("preview_text");
    }
    expect(await readFile(join(process.cwd(), "README.md"), "utf8")).not.toContain("preview_text");
  });

  it("validates every built-in model example and selects every operation in one", () => {
    const client = createGenerationClient({ apiKey: "test" });
    for (const model of client.listModels()) {
      for (const example of model.examples ?? []) {
        const label = `${model.model}: ${example.title ?? "example"}`;
        expect(example.request.model, label).toBe(model.model);
        expect(() => client.validate(example.request), label).not.toThrow();
      }
      const selected = new Set(model.examples?.map((example) => example.request.parameters?.operation));
      expect(
        Object.keys(model.operations ?? {}).filter((operation) => !selected.has(operation)),
        model.model,
      ).toEqual([]);
    }
  });

  it("parses model declarations with operations and rejects operations that a request cannot select", () => {
    const declaration = {
      schema: "neta.generation.model.v1",
      model: "custom.operations",
      adapter: { type: "custom.adapter" },
      content: { input: [{ type: "text", required: true }] },
      parameters: {
        operation: { type: "string", enum: ["draw", "edit"] },
        seed: { type: "integer", optional: true },
      },
      operations: {
        draw: { title: "Draw", description: "Draw an image.", parameters: { size: { type: "string" } } },
        edit: { content: { input: [{ type: "image", required: true }] } },
      },
    };
    const parse = (value: unknown) => parseGenerationModelDeclaration(JSON.stringify(value), "custom.json");
    const selector = (spec: Record<string, unknown>) => ({
      ...declaration,
      parameters: { ...declaration.parameters, operation: { type: "string", enum: ["draw", "edit"], ...spec } },
    });
    const operations = (value: unknown) => ({ ...declaration, operations: value });

    expect(parse(declaration)).toEqual(declaration);
    expect(parse(selector({ optional: true, default: "draw" })).parameters?.operation).toMatchObject({
      default: "draw",
    });
    const meshy = stringifyBuiltinModelConfig("meshy");
    expect(parseGenerationModelDeclaration(meshy, "meshy.yaml")).toEqual(createGenerationClient().getModel("meshy"));

    for (const invalid of [
      { ...declaration, parameters: { seed: declaration.parameters.seed } },
      selector({ type: "integer" }),
      selector({ enum: ["edit", "draw"] }),
      selector({ enum: ["draw"] }),
      selector({ enum: undefined }),
      selector({ optional: true }),
      { ...selector({ enum: [] }), operations: {} },
      operations([]),
      operations({ ...declaration.operations, edit: "edit" }),
      operations({ ...declaration.operations, edit: { title: 1 } }),
      operations({ ...declaration.operations, edit: { content: { input: {} } } }),
      operations({ ...declaration.operations, edit: { parameters: { size: { type: "color" } } } }),
      operations({ ...declaration.operations, edit: { parameters: { seed: { type: "integer" } } } }),
      operations({ ...declaration.operations, edit: { parameters: { operation: { type: "string" } } } }),
      operations({ ...declaration.operations, edit: { content: { input: [{ type: "text" }] } } }),
    ]) {
      expect(() => parse(invalid), JSON.stringify(invalid)).toThrow("Invalid model declaration: custom.json");
    }
  });

  it("parses published model declaration files", async () => {
    const declarations = await readGenerationModelDeclarationsFromDirectory(join(process.cwd(), "models"));
    const client = createGenerationClient({ apiKey: "test" });
    const runtimeDeclarations = client.listModels().map((declaration) => ({
      ...declaration,
      content: {
        input: declaration.content.input.map((input) => ({
          ...input,
          ...(input.sources ? { sources: input.sources.filter((source) => source !== "base64") } : {}),
        })),
      },
    }));

    expect(declarations).toEqual(runtimeDeclarations);

    expect(declarations.map((declaration) => declaration.model).sort()).toEqual(
      client
        .listModels()
        .map((model) => model.model)
        .sort(),
    );
  });

  it("quotes every song2 abc_mode value so YAML 1.1 parsers read strings", async () => {
    const raw = await readFile(join(process.cwd(), "models", "song2.yaml"), "utf8");

    // YAML 1.1 reads a bare off as false, so values stay quoted for when off is offered again; the control shows the
    // parser below discriminates.
    expect(parseYaml("v: off", { version: "1.1" })).toEqual({ v: false });
    expect(parseYaml(raw, { version: "1.1" }).parameters.abc_mode.enum).toEqual(["full", "melody"]);

    const values = parseDocument(raw).getIn(["parameters", "abc_mode", "enum"], true);
    if (!isSeq(values)) throw new Error("abc_mode.enum is not a sequence");
    expect(values.items.map((value) => (isScalar(value) ? value.type : undefined))).toEqual([
      "QUOTE_DOUBLE",
      "QUOTE_DOUBLE",
    ]);
  });

  it("does not declare song2 cfg_scale or abc_mode off yet", async () => {
    const raw = await readFile(join(process.cwd(), "models", "song2.yaml"), "utf8");
    const published = parseGenerationModelDeclaration(raw, "song2.yaml");
    const builtin = createGenerationClient().getModel("song2");

    for (const declaration of [published, builtin]) {
      expect(Object.keys(declaration?.parameters ?? {})).toEqual(["abc_mode", "seed", "return_abc"]);
      expect(declaration?.parameters?.abc_mode).toMatchObject({ enum: ["full", "melody"] });
    }
    expect(raw).not.toMatch(/cfg_scale|\boff\b/);
  });

  it("loads models/song2.yaml on its own and enforces what it declares", async () => {
    const raw = await readFile(join(process.cwd(), "models", "song2.yaml"), "utf8");
    const client = createGenerationClient({
      apiKey: "test",
      models: [parseGenerationModelDeclaration(raw, "song2.yaml")],
      includeBuiltinModels: false,
    });
    const content: GenerationContentBlock[] = [
      { type: "text", text: "bright J-pop", meta: { role: "prompt" } },
      { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } },
    ];

    expect(() =>
      client.validate({ model: "song2", content, parameters: { abc_mode: "melody", seed: 7, return_abc: true } }),
    ).not.toThrow();
    expect(() => client.validate({ model: "song2", content, parameters: { cfg_scale: 1 } })).toThrow(
      "Unknown parameter: cfg_scale",
    );
    expect(() => client.validate({ model: "song2", content, parameters: { abc_mode: "off" } })).toThrow(
      "must be one of: full, melody",
    );
  });

  it("does not offer song2 cfg_scale or abc_mode off in the README", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("`song2` generates"), readme.indexOf("## 3D generation"));

    expect(section).toContain("| `abc_mode` |");
    expect(section).not.toMatch(/cfg_scale|\boff\b/);
  });

  it("exports model declarations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "generation-"));
    try {
      const file = join(dir, "gpt-image-2.yaml");
      await exportBuiltinModelConfig("gpt-image-2", file);
      const client = createGenerationClient({ apiKey: "test" });
      expect(client.stringifyModelConfig("gpt-image-2")).toContain("schema: neta.generation.model.v1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
