import { GenerationProviderError, GenerationTimeoutError, GenerationValidationError } from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import { taskPollTicks } from "../task-poll.js";
import type { GenerationAdapterInput, GenerationContentBlock, GenerationSource } from "../types.js";
import { compactObject, getBlockMeta } from "../utils.js";
import { mergeTextBlocks } from "../validation.js";

// Keep per-request timeout comfortably above max_wait so polling controls total wait time.
const REQUEST_TIMEOUT_MS = 1_860_000;
const DEFAULT_POLL_INTERVAL_SEC = 1;
const DEFAULT_MAX_WAIT_SEC = 600;

type ArkCreateTaskResponse = { id?: unknown; task_id?: unknown; status?: unknown };

type ArkTaskStatusResponse = {
  data?: {
    status?: unknown;
    result_url?: unknown;
    progress?: unknown;
    first_frame?: unknown;
    data?: {
      status?: unknown;
      content?: { video_url?: unknown; first_frame?: unknown };
      resolution?: unknown;
      ratio?: unknown;
      duration?: unknown;
      framespersecond?: unknown;
      seed?: unknown;
      generate_audio?: unknown;
      model?: unknown;
      usage?: unknown;
    };
  };
};

type MediaMode = "image" | "frame" | "reference";
type VisualKind = "image" | "video";
type MediaKind = VisualKind | "audio";
type InputMedia = { kind: MediaKind; source: GenerationSource; role: string | undefined };
type ResolvedMedia = { kind: MediaKind; url: string; role: string | undefined };
type VisualInputMedia = InputMedia & { kind: VisualKind };
type VisualResolvedMedia = ResolvedMedia & { kind: VisualKind };

const MAX_REFERENCE_AUDIO = 3;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isSeedance25Model(model: string): boolean {
  return /^seedance[-_.]?2[-_.]?5$/i.test(model);
}

function seedance25LockedRatioKind(
  mode: MediaMode | null,
  visual: readonly VisualInputMedia[],
): "first/last-frame" | "edit/extend" | null {
  if (mode === "frame") return "first/last-frame";
  if (visual.some((item) => item.kind === "video")) return "edit/extend";
  return null;
}

function resolveRatio(
  model: string,
  mode: MediaMode | null,
  visual: readonly VisualInputMedia[],
  parameters: Record<string, unknown>,
  requestParameters: Record<string, unknown> | undefined,
): string {
  const requested = asString(requestParameters?.ratio);
  const locked = isSeedance25Model(model) ? seedance25LockedRatioKind(mode, visual) : null;
  if (!locked) return requested ?? asString(parameters.ratio) ?? "16:9";
  if (requested !== undefined && requested !== "adaptive") {
    throw new GenerationValidationError(`Seedance 2.5 ${locked} tasks require ratio=adaptive, got "${requested}"`);
  }
  return "adaptive";
}

function normalizeStatus(value: string): string {
  const status = value.toLowerCase();
  return status === "success" ? "succeeded" : status;
}

function getIntegerParameter(parameters: Record<string, unknown>, key: string, fallback: number): number {
  const value = parameters[key];
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function getMediaRole(
  block: Extract<GenerationContentBlock, { type: "image" | "video" | "audio" }>,
): string | undefined {
  const role = getBlockMeta(block)?.role;
  return typeof role === "string" && role ? role : undefined;
}

function isVisualMedia(item: InputMedia): item is VisualInputMedia {
  return item.kind === "image" || item.kind === "video";
}

function isVisualResolved(item: ResolvedMedia): item is VisualResolvedMedia {
  return item.kind === "image" || item.kind === "video";
}

function validateAudioInputs(audio: InputMedia[], visual: InputMedia[]): void {
  for (const item of audio) {
    if (item.role !== "reference_audio") {
      throw new GenerationValidationError("Audio input must use meta.role reference_audio");
    }
  }
  if (audio.length > MAX_REFERENCE_AUDIO) {
    throw new GenerationValidationError(`Seedance supports at most ${MAX_REFERENCE_AUDIO} reference_audio files`);
  }
  if (audio.length > 0 && visual.length === 0) {
    throw new GenerationValidationError("Seedance audio input requires at least one image or video");
  }
}

function isFrameImage(item: InputMedia): boolean {
  return item.kind === "image" && (item.role === "first_frame" || item.role === "last_frame");
}

function isReferenceMedia(item: InputMedia): boolean {
  return (
    (item.kind === "image" && item.role === "reference_image") ||
    (item.kind === "video" && item.role === "reference_video")
  );
}

function assertSingleRole(media: InputMedia[], role: string, message: string): void {
  if (media.filter((item) => item.role === role).length > 1) {
    throw new GenerationValidationError(message);
  }
}

function classifyMedia(media: VisualInputMedia[]): MediaMode | null {
  if (media.length === 0) return null;

  for (const item of media) {
    if (
      item.kind === "image" &&
      item.role &&
      item.role !== "first_frame" &&
      item.role !== "last_frame" &&
      item.role !== "reference_image"
    ) {
      throw new GenerationValidationError("Image input must use meta.role first_frame, last_frame, or reference_image");
    }
    if (item.kind === "video" && item.role !== "reference_video") {
      throw new GenerationValidationError("Video input must use meta.role reference_video");
    }
  }

  const hasFrame = media.some(isFrameImage);
  const hasReference = media.some(isReferenceMedia);
  const hasPlain = media.some((item) => item.kind === "image" && !item.role);
  const modes = [hasPlain, hasFrame, hasReference].filter(Boolean).length;
  if (modes > 1)
    throw new GenerationValidationError(
      "Cannot mix video media modes: use only plain image, first_frame/last_frame, or reference_image/reference_video",
    );
  if (hasReference) {
    assertSingleRole(media, "reference_video", "Reference mode supports at most one reference_video");
    return "reference";
  }
  if (hasFrame) {
    assertSingleRole(media, "first_frame", "Frame mode supports at most one first_frame image");
    assertSingleRole(media, "last_frame", "Frame mode supports at most one last_frame image");
    return "frame";
  }
  if (hasPlain) {
    if (media.filter((item) => item.kind === "image" && !item.role).length > 1) {
      throw new GenerationValidationError("Plain image mode supports at most one image");
    }
    return "image";
  }
  return null;
}

function buildVisualContent(media: VisualResolvedMedia[], mode: Exclude<MediaMode, "image">) {
  const content: Array<Record<string, unknown>> = [];
  for (const item of media) {
    if (mode === "frame" && (item.kind !== "image" || (item.role !== "first_frame" && item.role !== "last_frame"))) {
      throw new GenerationValidationError("Frame mode images must use meta.role first_frame or last_frame");
    }
    if (
      mode === "reference" &&
      !(
        (item.kind === "image" && item.role === "reference_image") ||
        (item.kind === "video" && item.role === "reference_video")
      )
    ) {
      throw new GenerationValidationError("Reference mode media must use meta.role reference_image or reference_video");
    }
    if (item.kind === "image") {
      content.push({ type: "image_url", image_url: { url: item.url }, role: item.role });
    } else {
      content.push({ type: "video_url", video_url: { url: item.url }, role: item.role });
    }
  }
  return content;
}

function buildAudioContent(media: ResolvedMedia[]): Array<Record<string, unknown>> {
  return media.map((item) => ({
    type: "audio_url",
    audio_url: { url: item.url },
    role: "reference_audio",
  }));
}

function buildPlainImageContent(media: VisualResolvedMedia[]): Array<Record<string, unknown>> {
  const image = media.find((item) => item.kind === "image");
  if (!image) return [];
  return [compactObject({ type: "image_url", image_url: { url: image.url }, role: image.role })];
}

async function resolveMedia(input: GenerationAdapterInput, media: InputMedia[]): Promise<ResolvedMedia[]> {
  return Promise.all(
    media.map(async (item) => ({
      kind: item.kind,
      role: item.role,
      url: await input.context.resolveSource(item.source),
    })),
  );
}

function extractTaskId(response: ArkCreateTaskResponse): string {
  const taskId = asString(response.task_id) ?? asString(response.id);
  if (!taskId) {
    throw new GenerationProviderError("Video generation provider did not return a task id", {
      details: { response },
    });
  }
  return taskId;
}

function normalizeTaskStatus(response: ArkTaskStatusResponse) {
  if (response.data) {
    const wrapper = response.data;
    const native = wrapper.data;
    const status = normalizeStatus(asString(native?.status) ?? asString(wrapper.status) ?? "unknown");
    const videoUrl = asString(wrapper.result_url) ?? asString(native?.content?.video_url);
    const firstFrameUrl = asString(wrapper.first_frame) ?? asString(native?.content?.first_frame);
    const metadata: Record<string, unknown> = {
      progress: wrapper.progress,
      resolution: native?.resolution,
      ratio: native?.ratio,
      duration: native?.duration,
      framespersecond: native?.framespersecond,
      seed: native?.seed,
      generate_audio: native?.generate_audio,
      model: native?.model,
      usage: native?.usage,
    };
    for (const key of Object.keys(metadata)) if (metadata[key] === undefined) delete metadata[key];
    return { status, videoUrl, firstFrameUrl, metadata };
  }
  return { status: "unknown", videoUrl: undefined, firstFrameUrl: undefined, metadata: {} };
}

async function requestJson(input: GenerationAdapterInput, path: string, init: RequestInit): Promise<unknown> {
  const response = await fetchWithTimeout(
    input.context.fetch,
    joinUrl(input.context.baseUrl, path),
    {
      ...init,
      headers: {
        Authorization: `Bearer ${input.context.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new GenerationProviderError("Video generation provider request failed", { status: response.status, body });
  }
  return response.json();
}

export async function arkVideoGenerationsAdapter(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const prompt = mergeTextBlocks(input.declaration, input.request.content);
  if (!prompt) throw new GenerationValidationError("Prompt text is required");

  const mediaBlocks = input.request.content.filter(
    (block): block is Extract<GenerationContentBlock, { type: "image" | "video" | "audio" }> =>
      block.type === "image" || block.type === "video" || block.type === "audio",
  );
  const inputMedia: InputMedia[] = mediaBlocks.map((block) => ({
    kind: block.type,
    source: block.source,
    role: getMediaRole(block),
  }));
  const visualInput = inputMedia.filter(isVisualMedia);
  const audioInput = inputMedia.filter((item) => item.kind === "audio");
  validateAudioInputs(audioInput, visualInput);

  const mode = classifyMedia(visualInput);
  const ratio = resolveRatio(input.declaration.model, mode, visualInput, input.parameters, input.request.parameters);
  const media = await resolveMedia(input, inputMedia);
  const visual = media.filter(isVisualResolved);
  const audio = media.filter((item) => item.kind === "audio");
  const resolution = asString(input.parameters.resolution) ?? "720p";
  const duration = getIntegerParameter(input.parameters, "duration", 5);
  const fps = getIntegerParameter(input.parameters, "fps", 24);
  const pollIntervalSec = getIntegerParameter(input.parameters, "poll_interval", DEFAULT_POLL_INTERVAL_SEC);
  const maxWaitSec = getIntegerParameter(input.parameters, "max_wait", DEFAULT_MAX_WAIT_SEC);
  const generateAudio = asBoolean(input.parameters.generate_audio) ?? true;
  const returnLastFrame = asBoolean(input.parameters.return_last_frame) ?? true;
  const cameraFixed = asBoolean(input.parameters.camera_fixed) ?? false;
  const watermark = asBoolean(input.parameters.watermark) ?? false;
  const seed = asNumber(input.parameters.seed);

  const payload: Record<string, unknown> = { model: input.declaration.model, prompt };
  const metadata: Record<string, unknown> = { duration, fps, generate_audio: generateAudio, resolution, ratio };
  if (seed !== undefined) metadata.seed = seed;
  if (returnLastFrame) metadata.return_last_frame = true;
  if (cameraFixed) metadata.camera_fixed = true;
  if (watermark) metadata.watermark = true;

  if (mode === "frame" || mode === "reference") {
    metadata.content = [...buildVisualContent(visual, mode), ...buildAudioContent(audio)];
  } else if (audio.length > 0) {
    metadata.content = [...buildPlainImageContent(visual), ...buildAudioContent(audio)];
  } else {
    const firstImage = visual.find((item) => item.kind === "image");
    if (firstImage) payload.image = firstImage.url;
  }
  payload.metadata = metadata;

  const task = (await requestJson(input, "/v1/video/generations", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as ArkCreateTaskResponse;
  const taskId = extractTaskId(task);

  for await (const _ of taskPollTicks(maxWaitSec * 1000, pollIntervalSec * 1000)) {
    const rawStatus = (await requestJson(input, `/v1/video/generations/${encodeURIComponent(taskId)}`, {
      method: "GET",
    })) as ArkTaskStatusResponse;
    const status = normalizeTaskStatus(rawStatus);

    if (status.status === "succeeded") {
      if (!status.videoUrl) {
        throw new GenerationProviderError("Video generation succeeded but returned no video URL", {
          details: compactObject({ taskId, rawStatus, metadata: status.metadata }),
        });
      }
      const output: GenerationContentBlock[] = [
        {
          type: "video",
          source: { type: "url", url: status.videoUrl },
          meta: { task_id: taskId, status: status.status, ...status.metadata },
        },
      ];
      if (status.firstFrameUrl)
        output.push({
          type: "image",
          source: { type: "url", url: status.firstFrameUrl },
          meta: { role: "first_frame", task_id: taskId },
        });
      return output;
    }

    if (["failed", "expired", "cancelled"].includes(status.status)) {
      throw new GenerationProviderError(`Video generation ${status.status}`, { details: { taskId, rawStatus } });
    }
  }

  throw new GenerationTimeoutError("Timed out waiting for video generation", { taskId });
}
