import type { GenerationModelDeclaration, GenerationModelPricing, GenerationOperationSpec } from "./types.js";
import { MODEL_SCHEMA } from "./types.js";
import { cloneJson } from "./utils.js";

const seedanceListPriceNote = "BytePlus list USD; varies by resolution and video input";

function seedanceTokenPricing(min: number, max: number): GenerationModelPricing {
  return { unit: "1m_tokens", min, max, note: seedanceListPriceNote };
}

const imageSizeParameters = {
  size: {
    type: "string",
    optional: true,
    default: "1024x1024",
    description: "Output image size.",
    examples: ["auto", "1024x1024", "1536x1024", "1024x1536", "2048x2048", "2048x1152", "3840x2160", "2160x3840"],
  },
  quality: {
    type: "string",
    optional: true,
    default: "auto",
    enum: ["auto", "low", "medium", "high"],
    description: "Image quality.",
  },
  background: {
    type: "string",
    optional: true,
    enum: ["auto", "opaque", "transparent"],
    description: "Requested background. Transparent output requires png or webp.",
  },
  output_format: {
    type: "string",
    optional: true,
    enum: ["png", "jpeg", "webp"],
    description: "Requested output file format. JPEG cannot preserve a transparent background.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const krea2ImageParameters = {
  size: {
    type: "string",
    optional: true,
    default: "1024x1024",
    description:
      "Output image size as WIDTHxHEIGHT. Both dimensions must be between 256 and 1024 and must be multiples of 16.",
    dimensions: { min: 256, max: 1024, multipleOf: 16 },
    examples: ["1024x1024", "1024x768", "768x1024", "768x768", "512x512", "256x256"],
  },
} satisfies GenerationModelDeclaration["parameters"];

const zImageTurboParameters = {
  size: {
    type: "string",
    optional: true,
    default: "1024*1024",
    enum: ["1024*1024", "1536*1024", "1024*1536", "2048*2048"],
    description: "Output image size.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const qwenImageEditParameters = {
  size: {
    type: "string",
    optional: true,
    default: "1024x1024",
    description: "Output image size.",
    examples: ["1024x1024", "768x1024", "1024x768"],
  },
} satisfies GenerationModelDeclaration["parameters"];

const noobxlImageParameters = {
  size: {
    type: "string",
    optional: true,
    default: "1024x1024",
    enum: ["1024x1024", "896x1152", "1152x896", "1344x768", "768x1344"],
    description: "Output image size.",
  },
  negative_prompt: {
    type: "string",
    optional: true,
    description: "Content to avoid in generated images.",
  },
  seed: {
    type: "integer",
    optional: true,
    min: 0,
    description: "Random seed for reproducibility.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const noobxlImageToImageParameters = {
  ...noobxlImageParameters,
  controlnet_weight: {
    type: "number",
    optional: true,
    min: 0,
    max: 2,
    description: "ControlNet tile weight. The provider default is 0.8.",
  },
  ipadapter_face_image_ref: {
    type: "string",
    optional: true,
    description: "Optional face reference image URL for IP-Adapter.",
  },
  ipadapter_face_weight: {
    type: "number",
    optional: true,
    min: 0,
    max: 2,
    description: "IP-Adapter face weight. The provider default is 0.6 when a face reference is supplied.",
  },
} satisfies GenerationModelDeclaration["parameters"];

function seedanceVideoParameters(defaults: { resolution: string; resolutions?: string[]; maxWait: number }) {
  return {
    duration: {
      type: "integer",
      optional: true,
      default: 5,
      min: 4,
      max: 15,
      description: "Video duration in seconds.",
    },
    resolution: {
      type: "string",
      optional: true,
      default: defaults.resolution,
      enum: defaults.resolutions ?? ["480p", "720p", "1080p", "4k"],
      description: "Output video resolution.",
    },
    ratio: {
      type: "string",
      optional: true,
      default: "16:9",
      enum: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "adaptive"],
      description: "Output aspect ratio. Use adaptive to let the model choose.",
    },
    seed: { type: "integer", optional: true, description: "Random seed for reproducibility." },
    camera_fixed: {
      type: "boolean",
      optional: true,
      default: false,
      description: "Fix camera position when supported.",
    },
    poll_interval: {
      type: "integer",
      optional: true,
      default: 1,
      min: 1,
      max: 30,
      description: "Seconds between task status checks.",
    },
    max_wait: {
      type: "integer",
      optional: true,
      default: defaults.maxWait,
      min: 30,
      max: 1800,
      description: "Maximum seconds to wait for task completion.",
    },
  } satisfies GenerationModelDeclaration["parameters"];
}

const seedanceContentInput = [
  { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Video prompt." },
  {
    type: "image",
    required: false,
    max: 9,
    sources: ["url"],
    roles: ["first_frame", "last_frame", "reference_image"],
    description: "Optional public URL image input. Use meta.role as first_frame, last_frame, or reference_image.",
  },
  {
    type: "video",
    required: false,
    max: 1,
    sources: ["url"],
    roles: ["reference_video"],
    roleRequired: true,
    description: "Optional public URL reference video input. Use meta.role as reference_video.",
  },
  {
    type: "audio",
    required: false,
    max: 3,
    sources: ["url"],
    roles: ["reference_audio"],
    roleRequired: true,
    description:
      "Optional public URL reference audio. Use meta.role reference_audio. Audio cannot be the only media input; include at least one image or video.",
  },
] satisfies GenerationModelDeclaration["content"]["input"];

const minimaxH3ContentInput = [
  { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Video prompt." },
  {
    type: "image",
    required: false,
    max: 12,
    sources: ["url"],
    roles: ["first_frame", "last_frame", "reference_image"],
    roleRequired: true,
    description: "Optional image inputs. Use meta.role to select a frame or reference image.",
  },
  {
    type: "video",
    required: false,
    max: 3,
    sources: ["url"],
    roles: ["reference_video"],
    roleRequired: true,
    description: "Optional reference video inputs. Use meta.role reference_video.",
  },
  {
    type: "audio",
    required: false,
    max: 3,
    sources: ["url"],
    roles: ["reference_audio"],
    roleRequired: true,
    description: "Optional reference audio inputs. Use meta.role reference_audio.",
  },
] satisfies GenerationModelDeclaration["content"]["input"];

const minimaxH3VideoCommonParameters = {
  duration: {
    type: "integer",
    optional: true,
    default: 5,
    description: "Video duration in seconds.",
  },
  ratio: {
    type: "string",
    optional: true,
    default: "16:9",
    enum: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    description: "Output aspect ratio. Use adaptive when media inputs determine the ratio.",
  },
  aigc_watermark: {
    type: "boolean",
    optional: true,
    default: false,
    description: "Enable the generated-video watermark.",
  },
  poll_interval: {
    type: "integer",
    optional: true,
    default: 1,
    min: 1,
    max: 30,
    description: "Seconds between task status checks.",
  },
  max_wait: {
    type: "integer",
    optional: true,
    default: 1800,
    min: 30,
    max: 1800,
    description: "Maximum seconds to wait for task completion.",
  },
} satisfies GenerationModelDeclaration["parameters"];

function minimaxH3VideoParameters() {
  return {
    ...minimaxH3VideoCommonParameters,
    resolution: {
      type: "string" as const,
      optional: true,
      default: "768P",
      description: "Output video resolution or an explicit WIDTHxHEIGHT canvas.",
    },
  } satisfies GenerationModelDeclaration["parameters"];
}

function klingVideoParameters(options: {
  maxDuration: number;
  negativePrompt?: boolean;
  seed?: boolean;
  sound?: boolean;
}) {
  const parameters: GenerationModelDeclaration["parameters"] = {
    duration: {
      type: "integer",
      optional: true,
      default: 5,
      min: 5,
      max: options.maxDuration,
      description: "Video duration in seconds.",
    },
    aspect_ratio: {
      type: "string",
      optional: true,
      default: "16:9",
      enum: ["16:9", "9:16", "1:1"],
      description: "Output aspect ratio.",
    },
    mode: {
      type: "string",
      optional: true,
      default: "std",
      enum: ["std", "pro"],
      description: "Kling generation mode.",
    },
    cfg_scale: {
      type: "number",
      optional: true,
      default: 0.5,
      min: 0,
      max: 1,
      description: "Prompt adherence scale.",
    },
    poll_interval: {
      type: "integer",
      optional: true,
      default: 5,
      min: 1,
      max: 30,
      description: "Seconds between task status checks.",
    },
    max_wait: {
      type: "integer",
      optional: true,
      default: 900,
      min: 30,
      max: 1800,
      description: "Maximum seconds to wait for task completion.",
    },
  };
  if (options.negativePrompt) {
    parameters.negative_prompt = {
      type: "string",
      optional: true,
      description: "Negative prompt.",
    };
  }
  if (options.seed) {
    parameters.seed = {
      type: "integer",
      optional: true,
      description: "Random seed for reproducibility.",
    };
  }
  if (options.sound) {
    parameters.sound = {
      type: "string",
      optional: true,
      enum: ["on", "off"],
      description: "Enable or disable generated sound when supported.",
    };
  }
  return parameters;
}

const sunoTaskParameters = {
  poll_interval: {
    type: "integer",
    optional: true,
    default: 5,
    min: 1,
    max: 60,
    description: "Seconds between task status checks.",
  },
  max_wait: {
    type: "integer",
    optional: true,
    default: 600,
    min: 30,
    max: 3600,
    description: "Maximum seconds to wait for task completion.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const sunoCommonMetaFields = {
  title: { type: "string", optional: true, description: "Suno song title." },
  tags: { type: "string", optional: true, description: "Comma-separated Suno music style tags." },
  gpt_description_prompt: { type: "string", optional: true, description: "Suno inspiration-mode prompt." },
  negative_tags: { type: "string", optional: true, description: "Styles to avoid." },
  generation_type: { type: "string", optional: true, description: "Suno generation type." },
  make_instrumental: { type: "boolean", optional: true, default: false, description: "Generate instrumental music." },
  metadata: { type: "object", optional: true, description: "Suno provider metadata payload." },
  metadata_params: {
    type: "object",
    optional: true,
    description: "Suno task-specific metadata payload.",
  },
} satisfies NonNullable<GenerationModelDeclaration["meta"]>["fields"];

const sunoTaskVariants = {
  extend: { required: ["continue_clip_id"] },
  upload_extend: { required: ["continue_clip_id"] },
  infill: { required: ["continue_clip_id", "metadata_params"] },
  fixed_infill: { required: ["continue_clip_id", "metadata_params"] },
  infill_intro: { required: ["continue_clip_id", "metadata_params"] },
  infill_outro: { required: ["continue_clip_id", "metadata_params"] },
  cover_infill: { required: ["continue_clip_id", "metadata_params"] },
  cover_extend: { required: ["continue_clip_id"] },
  artist_infill: { required: ["continue_clip_id", "metadata_params"] },
  artist_consistency: { required: ["persona_id", "artist_clip_id"] },
  cover: { required: ["task_id", "continue_clip_id"] },
  image_to_song: { requiredContent: ["image"], required: ["metadata_params"] },
  video_to_song: { requiredContent: ["video"], required: ["metadata_params"] },
  concat: { required: ["clip_id"] },
  sound: { required: ["metadata_params"] },
  underpainting: { required: ["metadata_params"] },
  overpainting: { required: ["metadata_params"] },
  remaster: { required: ["metadata_params"] },
  vox: { required: ["artist_clip_id"] },
  chop_sample_condition: { required: ["metadata_params"] },
  mashup_condition: { required: ["metadata_params"] },
  playlist_condition: { required: ["metadata_params"] },
} satisfies NonNullable<GenerationModelDeclaration["meta"]>["taskVariants"];

function sunoContentInput(
  options: { text?: "required" | "optional" | "none"; audio?: boolean; image?: boolean; video?: boolean } = {},
): GenerationModelDeclaration["content"]["input"] {
  const input: GenerationModelDeclaration["content"]["input"] = [];
  if (options.text !== "none") {
    input.push({
      type: "text",
      required: options.text === "required",
      max: 16,
      merge: "newline",
      description:
        "Prompt text. The adapter maps merged text to the operation's text field when that field is not provided.",
    });
  }
  if (options.audio) {
    input.push({
      type: "audio",
      required: true,
      max: 1,
      sources: ["url", "base64"],
      description: "Reference audio.",
    });
  }
  if (options.image) {
    input.push({
      type: "image",
      required: true,
      max: 1,
      sources: ["url", "base64"],
      description: "Reference image.",
    });
  }
  if (options.video) {
    input.push({
      type: "video",
      required: true,
      max: 1,
      sources: ["url", "base64"],
      description: "Reference video.",
    });
  }
  return input;
}

const sunoVersions = [
  { model: "suno_music_chirp_fenix", title: "Suno Music Chirp Fenix v5.5", mv: "chirp-fenix" },
] as const;

const sunoMusicExample = {
  title: "Music generation",
  request: {
    model: "suno_music_chirp_fenix",
    content: [{ type: "text", text: "uplifting cinematic pop with warm piano and clear chorus" }],
    meta: {
      title: "Warm Horizon",
      tags: "cinematic pop, warm piano",
      make_instrumental: false,
    },
  },
} satisfies NonNullable<GenerationModelDeclaration["examples"]>[number];

function sunoVersionModel(version: (typeof sunoVersions)[number]): GenerationModelDeclaration {
  return {
    schema: MODEL_SCHEMA,
    model: version.model,
    title: version.title,
    category: "audio",
    description:
      "High-quality music generation model for soundtracks and background music. Produces two MP3 tracks and two JPG cover images per request.",
    adapter: { type: "suno.tasks", operation: "music", payload: { mv: version.mv } },
    content: {
      input: sunoContentInput({ text: "required" }),
    },
    parameters: sunoTaskParameters,
    meta: {
      fields: sunoCommonMetaFields,
      ...(version.model === "suno_music_chirp_fenix"
        ? {
            fields: {
              ...sunoCommonMetaFields,
              lyrics: {
                type: "string",
                optional: true,
                description: "Explicit lyrics; omit to let Suno write lyrics from the prompt.",
              },
            },
          }
        : {}),
    },
    ...(version.model === "suno_music_chirp_fenix" ? { examples: [sunoMusicExample] } : {}),
  };
}

function sunoTaskModel(options: {
  model: string;
  title: string;
  description: string;
  task: string;
  mv?: string;
  content?: Parameters<typeof sunoContentInput>[0];
  fields?: NonNullable<GenerationModelDeclaration["meta"]>["fields"];
  examples?: GenerationModelDeclaration["examples"];
}): GenerationModelDeclaration {
  return {
    schema: MODEL_SCHEMA,
    model: options.model,
    title: options.title,
    description: options.description,
    adapter: {
      type: "suno.tasks",
      operation: "music",
      task: options.task,
      payload: { mv: options.mv ?? "chirp-v5" },
    },
    content: {
      input: sunoContentInput(options.content ?? { text: "optional" }),
    },
    parameters: sunoTaskParameters,
    meta: {
      fields: {
        ...sunoCommonMetaFields,
        ...options.fields,
      },
      taskVariants: sunoTaskVariants,
    },
    ...(options.examples ? { examples: options.examples } : {}),
  };
}

const sunoModels = [
  ...sunoVersions.map(sunoVersionModel),
  {
    schema: MODEL_SCHEMA,
    model: "suno_style_tags",
    title: "Suno Style Tags",
    description: "Suno style tag upsampling model.",
    adapter: { type: "suno.tasks", operation: "upsample_tags" },
    content: {
      input: sunoContentInput({ text: "required" }),
    },
  },
  {
    schema: MODEL_SCHEMA,
    model: "suno_upload_audio",
    title: "Suno Upload Audio",
    description: "Suno reference-audio upload model.",
    adapter: { type: "suno.tasks", operation: "upload_audio", defaults: { name: "reference-audio", timeout: 120 } },
    content: {
      input: sunoContentInput({ text: "none", audio: true }),
    },
    parameters: sunoTaskParameters,
    meta: {
      fields: {
        name: { type: "string", optional: true, description: "Upload name." },
        timeout: { type: "integer", optional: true, description: "Upload timeout in seconds." },
      },
    },
  },
  sunoTaskModel({
    model: "suno_image_to_song_chirp_v5",
    title: "Suno Image to Song Chirp v5.0",
    description: "Suno image-to-song task with a fixed chirp-v5 engine.",
    task: "image_to_song",
    content: { text: "optional", image: true },
    fields: {
      metadata_params: { type: "object", description: "Image-to-song metadata payload." },
    },
  }),
  sunoTaskModel({
    model: "suno_video_to_song_chirp_v5",
    title: "Suno Video to Song Chirp v5.0",
    description: "Suno video-to-song task with a fixed chirp-v5 engine.",
    task: "video_to_song",
    content: { text: "optional", video: true },
    fields: {
      metadata_params: { type: "object", description: "Video-to-song metadata payload." },
    },
  }),
  sunoTaskModel({
    model: "suno_sound_chirp_v5",
    title: "Suno Sound Chirp v5.0",
    description: "Suno sound-effect generation task with a fixed chirp-v5 engine.",
    task: "sound",
    content: { text: "optional" },
    fields: {
      metadata_params: { type: "object", description: "Sound task metadata payload." },
    },
  }),
  sunoTaskModel({
    model: "suno_cover_chirp_v5",
    title: "Suno Cover Chirp v5.0",
    description: "Suno cover task with a fixed chirp-v5 engine.",
    task: "cover",
    content: { text: "optional" },
    fields: {
      cover_clip_id: { type: "string", description: "Clip id to cover." },
      task_id: { type: "string", description: "Source Suno task id used for cover routing." },
      continue_clip_id: { type: "string", description: "Source clip id used for cover generation." },
      continue_at: { type: "number", optional: true, description: "Source clip continuation position in seconds." },
    },
  }),
  sunoTaskModel({
    model: "suno_infill_chirp_v5",
    title: "Suno Infill Chirp v5.0",
    description: "Suno local edit task with a fixed chirp-v5 engine.",
    task: "infill",
    content: { text: "optional" },
    fields: {
      continue_clip_id: { type: "string", description: "Clip id to edit." },
      metadata_params: { type: "object", description: "Infill timing and replacement metadata." },
    },
  }),
  sunoTaskModel({
    model: "suno_vox_chirp_v5",
    title: "Suno Vox Chirp v5.0",
    description: "Suno hum-to-song task with a fixed chirp-v5 engine.",
    task: "vox",
    content: { text: "optional" },
    fields: {
      artist_clip_id: { type: "string", description: "Reference hum or vocal clip id." },
    },
  }),
] satisfies GenerationModelDeclaration[];

type GeminiImageModelOptions = {
  imageSize?: {
    default: string;
    values: string[];
    example: string;
  };
};

function geminiImageModel(
  model: string,
  title: string,
  description: string,
  options: GeminiImageModelOptions = {},
): GenerationModelDeclaration {
  const parameters: NonNullable<GenerationModelDeclaration["parameters"]> = {
    aspect_ratio: {
      type: "string",
      optional: true,
      default: "1:1",
      enum: ["1:1", "16:9", "4:3", "3:2", "3:4", "2:3", "9:16", "5:4", "4:5", "21:9", "1:4", "4:1", "1:8", "8:1"],
      description: "Output aspect ratio.",
    },
  };
  if (options.imageSize) {
    parameters.image_size = {
      type: "string",
      optional: true,
      default: options.imageSize.default,
      enum: options.imageSize.values,
      description: "Output image resolution.",
    };
  }

  return {
    schema: MODEL_SCHEMA,
    model,
    title,
    category: "image",
    description,
    adapter: { type: "gemini.generateContent" },
    content: {
      input: [
        { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Prompt text." },
        {
          type: "image",
          required: false,
          max: 14,
          sources: ["url", "base64"],
          description: "Optional reference images.",
        },
      ],
    },
    parameters,
    examples: [
      {
        title: "Basic image",
        request: {
          model,
          content: [
            { type: "text", text: "a vibrant infographic explaining photosynthesis with clear readable labels" },
          ],
          parameters: {
            aspect_ratio: "16:9",
            ...(options.imageSize ? { image_size: options.imageSize.example } : {}),
          },
        },
      },
    ],
  };
}

function qwenTtsModel(
  model: string,
  title: string,
  description: string,
  options: { minimumTextCodePoints?: number } = {},
): GenerationModelDeclaration {
  const text = options.minimumTextCodePoints
    ? "这是一段长度足够并且表达清晰自然的语音合成测试文本。"
    : "这是一次清晰自然的语音合成测试。";
  return {
    schema: MODEL_SCHEMA,
    model,
    title,
    description,
    adapter: { type: "openai.audioSpeech" },
    content: {
      input: [
        {
          type: "text",
          required: true,
          min: 1,
          max: 1,
          description: options.minimumTextCodePoints
            ? `Exactly one non-empty text block to speak, with at least ${options.minimumTextCodePoints} Unicode code points.`
            : "Exactly one non-empty text block to speak.",
        },
        {
          type: "audio",
          required: false,
          max: 1,
          sources: ["url"],
          description: "Clone: one URL; no voice_prompt. Dependency: use prior generated audio.",
        },
      ],
    },
    meta: {
      fields: {
        voice_prompt: {
          type: "string",
          optional: true,
          description: "Design: custom voice text; no reference audio.",
        },
      },
    },
    examples: [
      {
        title: "Voice design",
        request: {
          model,
          content: [{ type: "text", text }],
          meta: { voice_prompt: "一位沉稳干练的男性播音员声音，吐字清晰有力" },
        },
      },
      {
        title: "Voice clone",
        request: {
          model,
          content: [
            { type: "text", text },
            { type: "audio", source: { type: "url", url: "https://example.com/reference.mp3" } },
          ],
        },
      },
    ],
  };
}

const audioSpeechModels = [
  qwenTtsModel(
    "qwen-tts",
    "Qwen TTS",
    "Modes: voice_prompt design OR one-reference clone. Default: unspecified Qwen design. Text: any length. Conflict: ask user; never combine/reinterpret. Dependency: clone prior generated audio.",
  ),
  qwenTtsModel(
    "qwen-audio-3.0-tts-plus",
    "Qwen Audio 3.0 TTS Plus",
    "Modes: voice_prompt design OR one-reference clone. Text: >=15 Unicode code points. Conflict: ask user; never combine/reinterpret. Dependency: clone prior generated audio.",
    { minimumTextCodePoints: 15 },
  ),
  qwenTtsModel(
    "qwen-audio-3.0-tts-flash",
    "Qwen Audio 3.0 TTS Flash",
    "Modes: voice_prompt design OR one-reference clone. Text: >=15 Unicode code points. Conflict: ask user; never combine/reinterpret. Dependency: clone prior generated audio.",
    { minimumTextCodePoints: 15 },
  ),
  {
    schema: MODEL_SCHEMA,
    model: "scene3",
    title: "Scene 3",
    category: "audio",
    description:
      "Modes: built-in voice, or clone from up to 16 reference recordings. Direction: controls written in the text (see the text input), and the instructions parameter for a note on every sentence. Not supported: speed, response_format, voice, voice_prompt, stream, or a separate language parameter (write the language in the text, e.g. [language: ja]). Dependency: clone prior generated audio.",
    adapter: { type: "openai.audioSpeech" },
    content: {
      input: [
        {
          type: "text",
          required: true,
          min: 1,
          max: 1,
          description:
            "Exactly one non-empty text block to speak. Controls written in the text: a cue such as [sighs], [laughs] or [pause] acts where it stands; <whisper>…</whisper> sets the delivery of the enclosed words; a [style] prefix such as [with bright eager excitement] sets the delivery of its line; <|speaker:N|> starts the turn of speaker N, from 0 to 15; [language: xx] at the end of a line names the main language; [audio tokens: N] at the end of a line hints its length, about 21.5 per second of audio. Hints are not spoken.",
        },
        {
          type: "audio",
          required: false,
          max: 16,
          sources: ["url"],
          description:
            "Clone: up to 16 reference recording URLs. With `<|speaker:N|>` tags in the text, the N-th recording (from 0) is that speaker's voice; without tags they are joined into one voice. meta.text: optional transcript of that recording, transcribed downstream when omitted. Dependency: use prior generated audio.",
        },
      ],
    },
    parameters: {
      drama_value: {
        type: "number",
        optional: true,
        default: 0.5,
        min: 0,
        max: 1,
        description:
          "How lively the delivery is, from 0 to 1 (default 0.5, the recommended setting). Higher values give more varied intonation and fewer pauses; lower values are steadier. The effect is subtle: for a clear change of tone, use `instructions` or direction cues in the text. With the same `seed`, `drama_value` and input, the audio is the same.",
      },
      seed: {
        type: "integer",
        optional: true,
        min: 0,
        description: "Random seed for reproducibility.",
      },
      instructions: {
        type: "string",
        optional: true,
        description: "Director's note applied to every sentence. At most 300 characters; [ ] < > | are removed.",
      },
    },
    examples: [
      {
        title: "Built-in voice with directions",
        request: {
          model: "scene3",
          content: [
            {
              type: "text",
              text: "[sighs] We missed the last train again. [laughs] Well, at least the night is warm.",
            },
          ],
        },
      },
      {
        title: "Reference clone",
        request: {
          model: "scene3",
          content: [
            { type: "text", text: "使用参考音频的声音朗读这段文本。" },
            { type: "audio", source: { type: "url", url: "https://example.com/reference.mp3" } },
          ],
        },
      },
      {
        title: "Reference clone with its transcript",
        request: {
          model: "scene3",
          content: [
            { type: "text", text: "使用参考音频的声音朗读这段文本。" },
            {
              type: "audio",
              source: { type: "url", url: "https://example.com/reference.mp3" },
              meta: { text: "参考音频里实际说的话。" },
            },
          ],
        },
      },
      {
        title: "Two speakers, livelier delivery",
        request: {
          model: "scene3",
          content: [
            { type: "text", text: "<|speaker:0|>[gasps] You came back! <|speaker:1|>[laughs] I said I would." },
            { type: "audio", source: { type: "url", url: "https://example.com/speaker-0.mp3" } },
            { type: "audio", source: { type: "url", url: "https://example.com/speaker-1.mp3" } },
          ],
          parameters: { drama_value: 0.8 },
        },
      },
    ],
  },
] satisfies GenerationModelDeclaration[];

const meshyTaskParameters = {
  poll_interval: {
    type: "integer",
    optional: true,
    default: 5,
    min: 1,
    max: 60,
    description: "Seconds between task status checks.",
  },
  max_wait: {
    type: "integer",
    optional: true,
    default: 3600,
    min: 60,
    max: 7200,
    description: "Maximum seconds to wait for the task. Meshy recommends waiting at least 60 minutes.",
  },
} satisfies GenerationModelDeclaration["parameters"];

function meshyTargetFormats(formats: string[], whenOmitted: string) {
  return {
    target_formats: {
      type: "array",
      optional: true,
      items: { type: "string", enum: formats },
      min: 1,
      unique: true,
      description: `3D file formats to generate. ${whenOmitted}`,
    },
  } satisfies GenerationModelDeclaration["parameters"];
}

const meshyGenerationTargetFormats = meshyTargetFormats(
  ["glb", "obj", "fbx", "stl", "usdz", "3mf"],
  "Meshy generates every format except 3mf when omitted.",
);

function meshyAiModel(models: string[], description: string) {
  return {
    ai_model: { type: "string", optional: true, enum: models, description },
  } satisfies GenerationModelDeclaration["parameters"];
}

const meshyGeometryParameters = {
  model_type: {
    type: "string",
    optional: true,
    enum: ["standard", "smart-topology"],
    description:
      "Mesh generation type. Meshy defaults to standard; smart-topology uses meshy-t2 and outputs triangles.",
  },
  ...meshyAiModel(
    ["latest", "meshy-7.1", "meshy-6", "meshy-6-lite", "meshy-t2"],
    "Meshy model. Meshy defaults to latest (Meshy 7.1) for standard and to meshy-t2 for smart-topology.",
  ),
} satisfies GenerationModelDeclaration["parameters"];

function meshyPolygonParameters(polycountDescription: string) {
  return {
    topology: {
      type: "string",
      optional: true,
      enum: ["quad", "triangle"],
      description: "Mesh topology. Meshy defaults to triangle.",
    },
    target_polycount: {
      type: "integer",
      optional: true,
      min: 100,
      max: 300000,
      description: polycountDescription,
    },
    decimation_mode: {
      type: "integer",
      optional: true,
      min: 1,
      max: 4,
      description: "Adaptive polycount level from 1 (ultra) to 4 (low). Overrides target_polycount.",
    },
  } satisfies GenerationModelDeclaration["parameters"];
}

const meshySmartTopologyPolycount =
  "Target face count: 100 to 300,000 with should_remesh on a standard model, 100 to 15,000 with smart-topology.";

function meshyRemeshPhaseParameters(polycountDescription: string) {
  return {
    should_remesh: {
      type: "boolean",
      optional: true,
      description:
        "Run the remesh phase. Meshy defaults to false for Meshy 6 and Meshy 7 models and to true for others.",
    },
    ...meshyPolygonParameters(polycountDescription),
  } satisfies GenerationModelDeclaration["parameters"];
}

const meshyTextureParameters = {
  enable_pbr: {
    type: "boolean",
    optional: true,
    description: "Generate metallic, roughness, and normal maps in addition to the base color.",
  },
  texture_resolution: {
    type: "string",
    optional: true,
    enum: ["2k", "4k", "8k"],
    description: "Base color texture resolution. Meshy defaults to 2k; 4k and 8k are not available with meshy-6-lite.",
  },
} satisfies GenerationModelDeclaration["parameters"];

function meshyImageInputParameters(polycountDescription: string) {
  return {
    should_texture: {
      type: "boolean",
      optional: true,
      description: "Generate textures. Set to false for an untextured mesh. Meshy defaults to true.",
    },
    ...meshyTextureParameters,
    ...meshyRemeshPhaseParameters(polycountDescription),
    save_pre_remeshed_model: {
      type: "boolean",
      optional: true,
      description: "Also return the GLB from before the remesh phase.",
    },
    image_enhancement: {
      type: "boolean",
      optional: true,
      description: "Optimize the input images. Set to false to keep their exact appearance. Meshy defaults to true.",
    },
    remove_lighting: {
      type: "boolean",
      optional: true,
      description: "Remove highlights and shadows from the base color texture. Meshy defaults to true.",
    },
    multi_view_thumbnails: {
      type: "boolean",
      optional: true,
      description: "Also render front, right, back, and left thumbnails.",
    },
  } satisfies GenerationModelDeclaration["parameters"];
}

const meshyPoseParameters = {
  pose_mode: {
    type: "string",
    optional: true,
    enum: ["a-pose", "t-pose"],
    description: "Generate the subject in an A pose or a T pose. No pose is applied when omitted.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const meshyModerationParameters = {
  moderation: {
    type: "boolean",
    optional: true,
    description: "Screen the inputs for harmful content before generation.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const meshyThumbnailParameters = {
  alpha_thumbnail: {
    type: "boolean",
    optional: true,
    description: "Also render a transparent-background thumbnail.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const meshySizeParameters = {
  auto_size: {
    type: "boolean",
    optional: true,
    description: "Estimate the real-world height of the object and resize the model to it.",
  },
  origin_at: {
    type: "string",
    optional: true,
    enum: ["bottom", "center"],
    description: "Origin position when auto_size is enabled. Meshy defaults to bottom.",
  },
} satisfies GenerationModelDeclaration["parameters"];

const meshyModelFileInput = {
  type: "3d",
  required: true,
  min: 1,
  max: 1,
  sources: ["url"],
  description:
    "Model file (GLB, GLTF, OBJ, FBX, or STL, up to 100 MB). A block with meta.task_id from a Meshy task that this operation accepts references the task instead of the file.",
} satisfies GenerationModelDeclaration["content"]["input"][number];

function meshyTextInput(required: boolean, description: string) {
  return {
    type: "text",
    required,
    ...(required ? { min: 1 } : {}),
    max: 16,
    merge: "newline",
    description,
  } satisfies GenerationModelDeclaration["content"]["input"][number];
}

const meshyOperations = {
  "text-to-3d": {
    title: "Text To 3D",
    description:
      "Generates an untextured 3D model from a text prompt. Pass the result to the text-to-3d-refine operation to texture it.",
    content: {
      input: [meshyTextInput(true, "Description of the object, up to 800 characters.")],
    },
    parameters: {
      ...meshyGeometryParameters,
      geometry_resolution: {
        type: "string",
        optional: true,
        enum: ["standard", "2k", "4k"],
        description: "Geometry pass. 2k and 4k run the Ultra pass and require meshy-7.1 or latest.",
      },
      ...meshyRemeshPhaseParameters(meshySmartTopologyPolycount),
      ...meshyPoseParameters,
      ...meshyModerationParameters,
      ...meshyGenerationTargetFormats,
      ...meshyThumbnailParameters,
      ...meshySizeParameters,
    },
  },
  "text-to-3d-refine": {
    title: "Text To 3D Refine",
    description:
      "Textures a model from the text-to-3d operation. Texturing can be guided by a text prompt or by an image, but not both.",
    content: {
      input: [
        {
          type: "3d",
          required: true,
          min: 1,
          max: 1,
          sources: ["url"],
          description: "A text-to-3d output block. Its meta.task_id selects the preview task.",
        },
        meshyTextInput(false, "Texture prompt, up to 800 characters."),
        {
          type: "image",
          required: false,
          max: 1,
          sources: ["url"],
          description: "Texture guide image (JPG, PNG, or WebP, up to 20 MB).",
        },
      ],
    },
    parameters: {
      ...meshyTextureParameters,
      ...meshyAiModel(
        ["latest", "meshy-7.1", "meshy-6", "meshy-6-lite"],
        "Texture model. Meshy defaults to the model of the preview task.",
      ),
      remove_lighting: {
        type: "boolean",
        optional: true,
        description: "Remove highlights and shadows from the base color texture. Takes effect with meshy-6.",
      },
      ...meshyModerationParameters,
      ...meshyGenerationTargetFormats,
      ...meshyThumbnailParameters,
      ...meshySizeParameters,
    },
  },
  "image-to-3d": {
    title: "Image To 3D",
    description: "Generates a textured 3D model from one image.",
    content: {
      input: [
        {
          type: "image",
          required: true,
          min: 1,
          max: 2,
          sources: ["url"],
          roles: ["texture"],
          description:
            "Input image (JPG, PNG, or WebP, up to 20 MB), and optionally a texture guide image with meta.role texture.",
        },
        meshyTextInput(false, "Texture prompt, up to 800 characters. Use either this or a texture guide image."),
      ],
    },
    parameters: {
      ...meshyGeometryParameters,
      geometry_resolution: {
        type: "string",
        optional: true,
        enum: ["standard", "2k", "4k"],
        description: "Geometry pass. 2k and 4k run the Ultra pass and require meshy-7.1 or latest.",
      },
      ...meshyImageInputParameters(meshySmartTopologyPolycount),
      ...meshyPoseParameters,
      ...meshyModerationParameters,
      ...meshyGenerationTargetFormats,
      ...meshyThumbnailParameters,
      ...meshySizeParameters,
    },
  },
  "multi-image-to-3d": {
    title: "Multi-Image To 3D",
    description: "Generates a textured 3D model from 1 to 4 images of the same object taken from different angles.",
    content: {
      input: [
        {
          type: "image",
          required: true,
          min: 1,
          max: 8,
          sources: ["url"],
          roles: ["texture"],
          description:
            "1 to 4 views of the object, front view first, and optionally up to 4 texture guide images with meta.role texture.",
        },
        meshyTextInput(false, "Texture prompt, up to 800 characters. Use either this or texture guide images."),
      ],
    },
    parameters: {
      ...meshyAiModel(
        ["latest", "meshy-7.1", "meshy-6", "meshy-6-lite"],
        "Meshy model. Meshy defaults to latest (Meshy 7.1); more than one texture guide image requires meshy-7.1 or latest.",
      ),
      geometry_resolution: {
        type: "string",
        optional: true,
        enum: ["standard", "2k"],
        description: "Geometry pass. 2k runs the Ultra pass and requires meshy-7.1 or latest.",
      },
      ...meshyImageInputParameters(
        "Target face count with should_remesh, from 100 to 300,000. Meshy defaults to 30,000.",
      ),
      ...meshyPoseParameters,
      ...meshyModerationParameters,
      ...meshyGenerationTargetFormats,
      ...meshyThumbnailParameters,
      ...meshySizeParameters,
    },
  },
  retexture: {
    title: "Retexture",
    description: "Applies a new texture to a 3D model, guided by a style prompt or by style images.",
    content: {
      input: [
        meshyModelFileInput,
        meshyTextInput(false, "Style prompt, up to 800 characters. Use either this or style images."),
        {
          type: "image",
          required: false,
          max: 4,
          sources: ["url"],
          description:
            "One style image, or 2 to 4 views of the object, front view first, which require ai_model meshy-7.",
        },
      ],
    },
    parameters: {
      ...meshyAiModel(
        ["latest", "meshy-7", "meshy-6", "meshy-6-lite"],
        "Meshy model. Meshy defaults to latest (Meshy 7).",
      ),
      enable_original_uv: {
        type: "boolean",
        optional: true,
        description: "Keep the existing UV layout of the model. Recommended for models that Meshy generated.",
      },
      ...meshyTextureParameters,
      remove_lighting: {
        type: "boolean",
        optional: true,
        description:
          "Remove highlights and shadows from the base color texture. Takes effect with meshy-6 at 2k or 4k.",
      },
      ...meshyGenerationTargetFormats,
      ...meshyThumbnailParameters,
    },
  },
  remesh: {
    title: "Remesh",
    description:
      "Rebuilds the mesh of a 3D model at a target topology and polycount, and converts it to other formats.",
    content: { input: [meshyModelFileInput] },
    parameters: {
      ...meshyTargetFormats(
        ["glb", "fbx", "obj", "usdz", "blend", "stl", "3mf"],
        "Meshy generates only GLB when omitted.",
      ),
      ...meshyPolygonParameters("Target face count, from 100 to 300,000. Meshy defaults to 30,000."),
      ...meshyThumbnailParameters,
    },
  },
  rigging: {
    title: "Rigging",
    description:
      "Adds a skeleton to a textured humanoid model and returns the rigged character with walking and running animations.",
    content: {
      input: [
        {
          ...meshyModelFileInput,
          description:
            "Textured humanoid GLB, up to 100 MB and 300,000 faces. A block with meta.task_id from a Meshy task references the task instead of the file.",
        },
        {
          type: "image",
          required: false,
          max: 1,
          sources: ["url"],
          description: "UV-unwrapped base color texture of the model (PNG, up to 20 MB).",
        },
      ],
    },
    parameters: {
      height_meters: {
        type: "number",
        optional: true,
        description: "Approximate height of the character in meters; must be positive. Meshy defaults to 1.7.",
      },
    },
  },
  "text-to-motion": {
    title: "Text To Motion",
    description:
      "Generates a motion clip from a text description. Apply it to a rigged character with the animation operation.",
    content: {
      input: [meshyTextInput(true, "Description of the motion, up to 400 characters.")],
    },
    parameters: {
      duration: {
        type: "number",
        min: 2,
        max: 10,
        multipleOf: 0.5,
        description: "Clip duration in seconds, from 2 to 10 in steps of 0.5.",
      },
      mode: {
        type: "string",
        optional: true,
        enum: ["prime", "swift"],
        description: "prime gives the highest quality and outputs FBX; swift is faster, costs less, and outputs BVH.",
      },
    },
  },
  animation: {
    title: "Animation",
    description:
      "Applies preset actions from the Meshy animation library, or a text-to-motion clip, to a character from the rigging operation.",
    content: {
      input: [
        {
          type: "3d",
          required: true,
          min: 1,
          max: 2,
          sources: ["url"],
          roles: ["motion"],
          description:
            "A rigging output block, whose meta.task_id selects the rigging task, and optionally a text-to-motion output block with meta.role motion.",
        },
      ],
    },
    parameters: {
      action_id: {
        type: "integer",
        optional: true,
        min: 0,
        description: "Preset action ID from the Meshy animation library.",
      },
      action_ids: {
        type: "array",
        optional: true,
        items: { type: "integer", min: 0 },
        min: 1,
        max: 10,
        unique: true,
        description: "1 to 10 preset action IDs, returned as one file with one clip per action in this order.",
      },
      post_process: {
        type: "string",
        optional: true,
        enum: ["change_fps", "fbx2usdz", "extract_armature"],
        description: "Post-processing applied to the animation output.",
      },
      fps: {
        type: "integer",
        optional: true,
        min: 24,
        max: 60,
        description: "Frame rate for post_process change_fps: 24, 25, 30, or 60. Meshy defaults to 30.",
      },
    },
  },
} satisfies Record<string, GenerationOperationSpec>;

const meshyModel = {
  schema: MODEL_SCHEMA,
  model: "meshy",
  title: "Meshy",
  category: "3d",
  description:
    "Generates, textures, remeshes, rigs, and animates 3D models. parameters.operation selects the function.",
  adapter: { type: "meshy.tasks" },
  content: { input: [] },
  parameters: {
    operation: {
      type: "string",
      enum: Object.keys(meshyOperations),
      description: "Function to run. operations declares the content inputs and parameters of each function.",
    },
    ...meshyTaskParameters,
  },
  operations: meshyOperations,
  examples: [
    {
      title: "Text to 3D preview",
      request: {
        model: "meshy",
        content: [{ type: "text", text: "a wooden treasure chest with iron bands" }],
        parameters: { operation: "text-to-3d", target_formats: ["glb", "usdz"] },
      },
    },
    {
      title: "Refine a preview",
      request: {
        model: "meshy",
        content: [
          {
            type: "3d",
            source: { type: "url", url: "https://example.com/preview.glb" },
            meta: { task_id: "task_preview_id" },
          },
          { type: "text", text: "weathered oak planks and dark iron" },
        ],
        parameters: { operation: "text-to-3d-refine", enable_pbr: true },
      },
    },
    {
      title: "Image to 3D",
      request: {
        model: "meshy",
        content: [{ type: "image", source: { type: "url", url: "https://example.com/character.png" } }],
        parameters: { operation: "image-to-3d", pose_mode: "a-pose", target_formats: ["glb"] },
      },
    },
    {
      title: "Multi-image to 3D",
      request: {
        model: "meshy",
        content: [
          { type: "image", source: { type: "url", url: "https://example.com/front.png" } },
          { type: "image", source: { type: "url", url: "https://example.com/side.png" } },
          { type: "image", source: { type: "url", url: "https://example.com/back.png" } },
        ],
        parameters: { operation: "multi-image-to-3d", target_formats: ["glb"] },
      },
    },
    {
      title: "Retexture from a style prompt",
      request: {
        model: "meshy",
        content: [
          { type: "3d", source: { type: "url", url: "https://example.com/model.glb" } },
          { type: "text", text: "polished marble with gold trim" },
        ],
        parameters: { operation: "retexture", enable_original_uv: true },
      },
    },
    {
      title: "Remesh to quads",
      request: {
        model: "meshy",
        content: [{ type: "3d", source: { type: "url", url: "https://example.com/model.glb" } }],
        parameters: { operation: "remesh", topology: "quad", target_polycount: 10000, target_formats: ["glb", "fbx"] },
      },
    },
    {
      title: "Rig a character",
      request: {
        model: "meshy",
        content: [{ type: "3d", source: { type: "url", url: "https://example.com/character.glb" } }],
        parameters: { operation: "rigging", height_meters: 1.8 },
      },
    },
    {
      title: "Text to motion",
      request: {
        model: "meshy",
        content: [{ type: "text", text: "a person jumps forward and lands softly" }],
        parameters: { operation: "text-to-motion", duration: 3, mode: "prime" },
      },
    },
    {
      title: "Apply preset actions",
      request: {
        model: "meshy",
        content: [
          {
            type: "3d",
            source: { type: "url", url: "https://example.com/rigged.glb" },
            meta: { task_id: "task_rigging_id" },
          },
        ],
        parameters: { operation: "animation", action_ids: [10, 25, 92] },
      },
    },
    {
      title: "Apply a text-to-motion clip",
      request: {
        model: "meshy",
        content: [
          {
            type: "3d",
            source: { type: "url", url: "https://example.com/rigged.glb" },
            meta: { task_id: "task_rigging_id" },
          },
          {
            type: "3d",
            source: { type: "url", url: "https://example.com/clip.fbx" },
            meta: { task_id: "task_motion_id", role: "motion" },
          },
        ],
        parameters: { operation: "animation" },
      },
    },
  ],
} satisfies GenerationModelDeclaration;

const builtinModels = [
  {
    schema: MODEL_SCHEMA,
    model: "volc.seedasr.auc",
    title: "Doubao ASR 2.0",
    description:
      "Transcribe one HTTP(S) audio URL into text with duration and sentence timestamps in seconds. Requires a gateway with JSON audio transcription support and an enabled Volcengine speech resource.",
    adapter: { type: "newapi.audioTranscription" },
    content: {
      input: [
        {
          type: "audio",
          required: true,
          min: 1,
          max: 1,
          sources: ["url"],
          description: "Audio URL accessible to Volcengine for the entire transcription job.",
        },
        {
          type: "text",
          required: false,
          description: "Optional prompt text accepted and ignored. Transcription uses only the audio and parameters.",
        },
      ],
    },
    parameters: {
      audio_format: {
        type: "string",
        optional: true,
        enum: ["wav", "mp3", "ogg", "raw"],
        description:
          "Audio format. Inferred from the URL path extension when omitted; required for extensionless URLs.",
      },
      language: {
        type: "string",
        optional: true,
        description:
          "Volcengine language code such as zh-CN or en-US. Omit to use the provider default recognition languages.",
      },
      max_wait: {
        type: "integer",
        optional: true,
        default: 330,
        min: 1,
        max: 1800,
        description: "SDK request timeout in seconds. Does not extend gateway or provider timeouts.",
      },
    },
    examples: [
      {
        title: "Transcribe a recording",
        request: {
          model: "volc.seedasr.auc",
          content: [
            { type: "text", text: "Transcribe this recording." },
            { type: "audio", source: { type: "url", url: "https://example.com/recording.wav" } },
          ],
          parameters: { audio_format: "wav", language: "zh-CN" },
        },
      },
    ],
  },
  ...audioSpeechModels,
  {
    schema: MODEL_SCHEMA,
    model: "song2",
    title: "Song 2",
    category: "audio",
    description:
      "Full-song generation with vocals from a style description and lyrics, optionally following an ABC score. Produces one MP3 per request.",
    adapter: { type: "newapi.audioGenerations" },
    content: {
      input: [
        {
          type: "text",
          required: true,
          min: 2,
          max: 3,
          roles: ["prompt", "lyrics", "abc"],
          roleRequired: true,
          description:
            "Text blocks by meta.role: prompt is the style description, lyrics the words to sing (up to 4000 characters), and optional abc is a score in the model's own ABC dialect, such as one returned with return_abc.",
        },
      ],
    },
    parameters: {
      abc_mode: {
        type: "string",
        optional: true,
        enum: ["full", "melody"],
        description:
          "How a score is used: full follows its melody and chords; melody follows only the melody and rejects chord marks. Omitted: inferred from the score, else full.",
      },
      seed: {
        type: "integer",
        optional: true,
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        description: "Random seed for reproducibility.",
      },
      return_abc: {
        type: "boolean",
        optional: true,
        description: "Also return the score the song used, as a text block with meta.role abc.",
      },
      abc_continue: {
        type: "boolean",
        optional: true,
        description: "Continue the given abc as a score opening, then sing it. Requires abc.",
      },
      harmony: {
        type: "object",
        optional: true,
        description:
          "Section order to follow: an object with follow, a list of % section names. Only follow is supported.",
      },
      lyric_schedule: {
        type: "object",
        optional: true,
        description:
          "When lyric sections become visible: sections of start_sec and lyric [c0, c1] code point offsets, optional lead_sec, behind and mode mask.",
      },
    },
    examples: [
      {
        title: "Song from style and lyrics",
        request: {
          model: "song2",
          content: [
            { type: "text", text: "bright J-pop, female vocal, piano", meta: { role: "prompt" } },
            { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } },
          ],
        },
      },
      {
        title: "Song that returns its score",
        request: {
          model: "song2",
          content: [
            { type: "text", text: "bright J-pop, female vocal, piano", meta: { role: "prompt" } },
            { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } },
          ],
          parameters: { seed: 7, return_abc: true },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "gpt-image-2",
    title: "GPT Image 2",
    category: "image",
    description:
      "Excels at photorealism, fine detail, text rendering, and sophisticated layouts. It accepts uploaded images as base or reference images and is particularly well suited to realistic imagery, mock website screenshots, infographics, and highly stylized, visually striking illustrations. Strong natural-language understanding and broad world knowledge help it follow complex prompts. Non-photorealistic styles may develop fine-grained texture and lighting artifacts, which can be corrected through prompt refinement or reference images. Low cost, but relatively slow.",
    adapter: { type: "openai.images" },
    content: {
      input: [
        { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Prompt text." },
        {
          type: "image",
          required: false,
          max: 16,
          sources: ["url", "base64"],
          description: "Optional reference images.",
        },
      ],
    },
    parameters: imageSizeParameters,
    examples: [
      {
        title: "Basic image",
        request: {
          model: "gpt-image-2",
          content: [{ type: "text", text: "a cyberpunk cat in neon rain" }],
          parameters: { size: "1024x1024", quality: "auto" },
        },
      },
      {
        title: "Transparent background",
        request: {
          model: "gpt-image-2",
          content: [{ type: "text", text: "a ceramic cup isolated on a transparent background" }],
          parameters: { size: "1024x1024", quality: "high", background: "transparent", output_format: "png" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "krea2",
    title: "Krea 2",
    category: "image",
    description:
      "Designed for visually refined image generation with broad aesthetic diversity. Strong natural-language understanding helps it follow detailed prompts. Text-only input; reference images are not supported. Relatively fast and low cost.",
    adapter: { type: "openai.images" },
    content: {
      input: [{ type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Prompt text." }],
    },
    parameters: krea2ImageParameters,
    examples: [
      {
        title: "Text-to-image",
        request: {
          model: "krea2",
          content: [{ type: "text", text: "an elegant editorial portrait with sculptural lighting" }],
          parameters: { size: "1024x1024" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "z-image-turbo",
    title: "Z-Image Turbo",
    category: "image",
    description:
      "Fast text-to-image model. Z-Image Turbo accepts prompt text only and does not support reference images.",
    adapter: { type: "openai.images" },
    content: {
      input: [{ type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Prompt text." }],
    },
    parameters: zImageTurboParameters,
    examples: [
      {
        title: "Text to image",
        request: {
          model: "z-image-turbo",
          content: [
            { type: "text", text: "a clean product-style image of a small red toy robot standing on a white desk" },
          ],
          parameters: { size: "1024*1024" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "qwen-image-edit",
    title: "Qwen Image Edit",
    category: "image",
    description: "Neta Qwen image editing with one source image URL and an edit instruction.",
    adapter: { type: "openai.imageEdits" },
    content: {
      input: [
        { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Edit instruction." },
        {
          type: "image",
          required: true,
          min: 1,
          max: 1,
          sources: ["url"],
          description: "Source image URL to edit.",
        },
      ],
    },
    parameters: qwenImageEditParameters,
    examples: [
      {
        title: "Edit image",
        request: {
          model: "qwen-image-edit",
          content: [
            { type: "text", text: "change the background to a clean white studio backdrop" },
            { type: "image", source: { type: "url", url: "https://example.com/input.png" } },
          ],
          parameters: { size: "1024x1024" },
        },
      },
    ],
  },
  geminiImageModel(
    "gemini-3.1-flash-image-preview",
    "Gemini 3.1 Flash Image Preview",
    "Excels at text rendering, UI components and icons, commercial visuals, and image editing. It handles both photorealistic and non-photorealistic styles reliably, producing clean, consistent images while preserving key features from references. Strong natural-language understanding and broad world knowledge help it follow complex prompts. Its images are generally less expressive than those from gpt-image-2, and its style-transfer capabilities are weaker. Moderate speed, but relatively expensive.",
    { imageSize: { default: "2K", values: ["512", "1K", "2K", "4K"], example: "1K" } },
  ),
  geminiImageModel(
    "gemini-3.1-flash-lite-image",
    "Gemini 3.1 Flash Lite Image",
    "Excels at text rendering, UI components and icons, commercial visuals, and image editing. It supports both photorealistic and non-photorealistic styles, producing clean, consistent results while preserving key features from references. Strong natural-language understanding and broad world knowledge help it follow complex prompts. This Lite variant produces fixed 1K output and is optimized for fast generation at a moderate price.",
  ),
  {
    schema: MODEL_SCHEMA,
    model: "video-upscale-native",
    title: "Video Upscale",
    category: "video",
    description: "Upscales a video. Recommended input: long edge under 1080 pixels.",
    adapter: { type: "video.upscaleNative" },
    content: {
      input: [
        {
          type: "video",
          required: true,
          min: 1,
          max: 1,
          sources: ["url"],
          description: "Public video URL to upscale.",
        },
      ],
    },
    examples: [
      {
        title: "Upscale video",
        request: {
          model: "video-upscale-native",
          content: [{ type: "video", source: { type: "url", url: "https://example.com/input.mp4" } }],
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "kling-text-to-video",
    title: "Kling Text To Video",
    category: "video",
    description:
      "One of the more affordable text-to-video models, well suited to short-form social media content and rapid creative validation.",
    adapter: { type: "kling.videoGenerations" },
    content: {
      input: [{ type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Video prompt." }],
    },
    parameters: klingVideoParameters({ maxDuration: 10, negativePrompt: true, seed: true }),
    examples: [
      {
        title: "Text to video",
        request: {
          model: "kling-text-to-video",
          content: [{ type: "text", text: "a small paper boat floating on calm water, cinematic motion" }],
          parameters: { duration: 5, aspect_ratio: "16:9", mode: "std" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "kling-image-to-video",
    title: "Kling Image To Video",
    category: "video",
    description:
      "Animates a reference image into a short video. It has the same cost as Kling text-to-video and more permissive content moderation than Seedance.",
    adapter: { type: "kling.videoGenerations" },
    content: {
      input: [
        { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Video prompt." },
        {
          type: "image",
          required: false,
          max: 2,
          sources: ["url", "base64"],
          description:
            "First frame and optional tail frame image input. Provider-native image input may be passed in meta.",
        },
      ],
    },
    parameters: klingVideoParameters({ maxDuration: 10, negativePrompt: true, seed: true }),
    examples: [
      {
        title: "Image to video",
        request: {
          model: "kling-image-to-video",
          content: [
            { type: "text", text: "gently turn toward the camera with soft natural motion" },
            { type: "image", source: { type: "url", url: "https://example.com/input.png" } },
          ],
          parameters: { duration: 5, aspect_ratio: "16:9" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "kling-omni-video",
    title: "Kling Omni Video",
    category: "video",
    description: "Kling Omni-Video generation model.",
    adapter: { type: "kling.videoGenerations" },
    content: {
      input: [
        {
          type: "text",
          required: false,
          max: 16,
          merge: "newline",
          description: "Optional video prompt. Use Kling Omni placeholders such as <<<image_1>>> with image_list.",
        },
        {
          type: "image",
          required: false,
          max: 2,
          sources: ["url", "base64"],
          description: "Optional simple image input. Provider-native Omni media arrays belong in request meta.",
        },
      ],
    },
    parameters: klingVideoParameters({ maxDuration: 15, sound: true }),
    meta: {
      fields: {
        multi_shot: {
          type: "boolean",
          optional: true,
          description: "Enable Kling Omni multi-shot mode.",
        },
        shot_type: {
          type: "string",
          optional: true,
          description: "Kling Omni shot type.",
        },
      },
    },
    examples: [
      {
        title: "Omni text to video",
        request: {
          model: "kling-omni-video",
          content: [{ type: "text", text: "a small paper boat floating on calm water, cinematic motion" }],
          parameters: { duration: 5, aspect_ratio: "16:9", mode: "std" },
        },
      },
      {
        title: "Omni image to video",
        request: {
          model: "kling-omni-video",
          content: [{ type: "text", text: "<<<image_1>>> gently turns toward the camera with soft natural motion" }],
          parameters: { duration: 5, aspect_ratio: "16:9" },
          meta: {
            image_list: [{ image_url: "https://example.com/input.png", type: "first_frame" }],
          },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "kling-multi-image-to-video",
    title: "Kling Multi-Image Reference To Video",
    category: "video",
    description: "Kling multi-image reference video generation model.",
    adapter: { type: "kling.videoGenerations" },
    content: {
      input: [
        { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Video prompt." },
        {
          type: "image",
          required: false,
          max: 4,
          sources: ["url", "base64"],
          description: "Reference image inputs. Provider-native image_list input may be passed in meta.",
        },
      ],
    },
    parameters: klingVideoParameters({ maxDuration: 10, negativePrompt: true, seed: true }),
    examples: [
      {
        title: "Multi-image reference to video",
        request: {
          model: "kling-multi-image-to-video",
          content: [
            { type: "text", text: "combine the references into one cinematic shot" },
            { type: "image", source: { type: "url", url: "https://example.com/reference-1.png" } },
            { type: "image", source: { type: "url", url: "https://example.com/reference-2.png" } },
          ],
          parameters: { duration: 5, aspect_ratio: "16:9" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "noobxl-t2i-onediff",
    title: "NoobXL T2I OneDiff",
    category: "image",
    description:
      "Anime-specialized NoobXL text-to-image model for anime-style illustrations. It works best with English Danbooru tags, which can invoke specific anime characters and illustrator styles. Natural-language understanding is limited. Fast and extremely low cost.",
    allowUnknownParameters: true,
    adapter: { type: "openai.images" },
    content: {
      input: [{ type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Prompt text." }],
    },
    parameters: noobxlImageParameters,
    examples: [
      {
        title: "Text to image",
        request: {
          model: "noobxl-t2i-onediff",
          content: [{ type: "text", text: "anime key visual, luminous city at night, crisp linework" }],
          parameters: { size: "1024x1024", negative_prompt: "low quality, blurry" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "noobxl-i2i-ipa-onediff",
    title: "NoobXL I2I IPA OneDiff",
    category: "image",
    description:
      "Anime-specialized NoobXL image-to-image model that redraws a single uploaded image using it as a style or character reference. It works best with English Danbooru tags, which can invoke specific anime characters and illustrator styles. Natural-language understanding is limited. Fast and extremely low cost.",
    allowUnknownParameters: true,
    adapter: { type: "openai.images" },
    content: {
      input: [
        { type: "text", required: true, min: 1, max: 16, merge: "newline", description: "Prompt text." },
        {
          type: "image",
          required: true,
          min: 1,
          max: 1,
          sources: ["url", "base64"],
          description: "Single source image.",
        },
      ],
    },
    parameters: noobxlImageToImageParameters,
    examples: [
      {
        title: "Image to image",
        request: {
          model: "noobxl-i2i-ipa-onediff",
          content: [
            { type: "text", text: "keep the character identity, redraw as a polished anime illustration" },
            { type: "image", source: { type: "url", url: "https://example.com/reference.png" } },
          ],
          parameters: { size: "1024x1024", controlnet_weight: 0.8 },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "birefnet-general",
    title: "BiRefNet General",
    category: "image",
    description:
      "Single-image background removal model that produces images with transparent backgrounds. Well suited to image post-processing and creating web assets. Fast and extremely low cost.",
    adapter: { type: "openai.images" },
    content: {
      input: [
        {
          type: "text",
          required: false,
          max: 16,
          merge: "newline",
          description: "Optional workflow prompt. Accepted for compatibility but ignored by the model.",
        },
        {
          type: "image",
          required: true,
          min: 1,
          max: 1,
          sources: ["url", "base64"],
          description: "Single source image.",
        },
      ],
    },
    examples: [
      {
        title: "Remove background",
        request: {
          model: "birefnet-general",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/portrait.png" } }],
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "minimax-h3",
    title: "MiniMax H3",
    category: "video",
    description: "MiniMax H3 video generation with 768P output.",
    adapter: { type: "minimax.h3VideoGenerations" },
    content: { input: minimaxH3ContentInput },
    parameters: minimaxH3VideoParameters(),
    examples: [
      {
        title: "Text to video",
        request: {
          model: "minimax-h3",
          content: [{ type: "text", text: "a red cube rotating on a white table" }],
          parameters: { duration: 5, resolution: "768P", ratio: "16:9" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "minimax-h3-unrestricted",
    title: "MiniMax H3 Unrestricted",
    category: "video",
    description: "MiniMax H3 video generation with caller-selected output dimensions.",
    adapter: { type: "minimax.h3VideoGenerations" },
    content: { input: minimaxH3ContentInput },
    parameters: minimaxH3VideoParameters(),
    examples: [
      {
        title: "Custom resolution",
        request: {
          model: "minimax-h3-unrestricted",
          content: [{ type: "text", text: "a red cube rotating on a white table" }],
          parameters: { duration: 15, resolution: "1920x1080", ratio: "16:9" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "seedance-2-0",
    title: "Seedance 2.0",
    category: "video",
    description:
      "High-quality video generation model that accepts text, image, video, and audio inputs. Supports resolutions from 480p to 4k and is well suited to final deliverables.",
    pricing: seedanceTokenPricing(2.4, 7.7),
    adapter: { type: "ark.videoGenerations" },
    content: { input: seedanceContentInput },
    parameters: seedanceVideoParameters({ resolution: "1080p", maxWait: 900 }),
    examples: [
      {
        title: "Text to video",
        request: {
          model: "seedance-2-0",
          content: [
            {
              type: "text",
              text: "a cat playing piano in a cozy jazz club, cinematic lighting, smooth camera movement",
            },
          ],
          parameters: { duration: 5, resolution: "1080p", ratio: "16:9" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "seedance-2-0-fast",
    title: "Seedance 2.0 Fast",
    category: "video",
    description:
      "Fast video generation model that accepts text, image, video, and audio inputs. Faster and less expensive than seedance-2-0, making it well suited to creative validation and draft iteration.",
    pricing: seedanceTokenPricing(3.3, 5.6),
    adapter: { type: "ark.videoGenerations" },
    content: { input: seedanceContentInput },
    parameters: seedanceVideoParameters({ resolution: "720p", resolutions: ["480p", "720p"], maxWait: 600 }),
    examples: [
      {
        title: "Text to video",
        request: {
          model: "seedance-2-0-fast",
          content: [
            {
              type: "text",
              text: "a cat playing piano in a cozy jazz club, cinematic lighting, smooth camera movement",
            },
          ],
          parameters: { duration: 5, resolution: "720p", ratio: "16:9" },
        },
      },
    ],
  },
  {
    schema: MODEL_SCHEMA,
    model: "seedance-2-5",
    title: "Seedance 2.5",
    category: "video",
    description:
      "Seedance 2.5 video generation with text, image, video, and audio inputs. Supports 480p to 1080p. Priced above Seedance 2.0 on BytePlus list USD; 4K is not offered.",
    pricing: seedanceTokenPricing(6.4, 11.7),
    adapter: { type: "ark.videoGenerations" },
    content: { input: seedanceContentInput },
    parameters: seedanceVideoParameters({
      resolution: "1080p",
      resolutions: ["480p", "720p", "1080p"],
      maxWait: 900,
    }),
    examples: [
      {
        title: "Text to video",
        request: {
          model: "seedance-2-5",
          content: [
            {
              type: "text",
              text: "a cat playing piano in a cozy jazz club, cinematic lighting, smooth camera movement",
            },
          ],
          parameters: { duration: 5, resolution: "1080p", ratio: "16:9" },
        },
      },
    ],
  },
  ...["jev-latest", "jev-1.13.0"].map(
    (model): GenerationModelDeclaration => ({
      schema: MODEL_SCHEMA,
      model,
      title: model === "jev-latest" ? "Jev Latest" : "Jev 1.13.0",
      category: "decision",
      description:
        "Evaluates state against named questions using systemOne(). Supports Noul likelihoods, Choice categories, and Score rubrics with typed answers.",
      adapter: { type: "typesafe.systemOne" },
      content: { input: [] },
      systemOneExamples: [
        {
          title: "Classify a support ticket",
          request: {
            model,
            state: { ticket: "I was charged twice for my subscription." },
            questions: {
              refund: { type: "noul", instructions: "Does the customer need a refund?" },
              team: {
                type: "choice",
                instructions: "Which team should handle this ticket?",
                criteria: { billing: "Charges and refunds", technical: "Bugs and outages" },
              },
            },
          },
        },
      ],
    }),
  ),
  {
    schema: MODEL_SCHEMA,
    model: "openai/gpt-6-luna-decisions",
    title: "Luna Decisions",
    category: "decision",
    description:
      "Evaluates text, JSON, or PNG/JPEG/WebP base64 images against up to 200 named Noul, Choice, and Score questions using decisions().",
    adapter: { type: "openrouter.decisions" },
    content: { input: [] },
    decisionsExamples: [
      {
        title: "Classify a support ticket",
        request: {
          model: "openai/gpt-6-luna-decisions",
          state: "I was charged twice for my subscription.",
          questions: {
            refund: { type: "noul", instructions: "Does the customer need a refund?" },
            team: {
              type: "choice",
              instructions: "Which team should handle this ticket?",
              criteria: { billing: "Charges and refunds", technical: "Bugs and outages" },
            },
          },
        },
      },
    ],
  },
  ...sunoModels,
  meshyModel,
] satisfies GenerationModelDeclaration[];

export const builtinGenerationModels: GenerationModelDeclaration[] = cloneJson(builtinModels);

export function getBuiltinGenerationModel(model: string): GenerationModelDeclaration | null {
  return cloneJson(builtinModels.find((declaration) => declaration.model === model) ?? null);
}

export function listBuiltinGenerationModels(): GenerationModelDeclaration[] {
  return cloneJson(builtinModels);
}
