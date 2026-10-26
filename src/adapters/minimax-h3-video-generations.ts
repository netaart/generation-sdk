import {
  FAILURE_CATEGORY_HEADER,
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationValidationError,
} from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import { taskPollTicks } from "../task-poll.js";
import type { GenerationAdapterInput, GenerationContentBlock, GenerationSource } from "../types.js";
import { compactObject, getBlockMeta } from "../utils.js";
import { mergeTextBlocks } from "../validation.js";

const REQUEST_TIMEOUT_MS = 1_860_000;
const DEFAULT_POLL_INTERVAL_SEC = 1;
const DEFAULT_MAX_WAIT_SEC = 1800;
const MAX_MEDIA_COUNT = 12;
const MAX_REFERENCE_IMAGES = 9;
const MAX_REFERENCE_VIDEOS = 3;
const MAX_REFERENCE_AUDIO = 3;
const DEFAULT_RATIO = "16:9";
const ADAPTIVE_RATIO = "adaptive";
const H3_RATIOS = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

type H3Mode = "text" | "frame" | "reference";
type H3MediaKind = "image" | "video" | "audio";
type H3InputMedia = { kind: H3MediaKind; source: GenerationSource; role: string | undefined };
type H3ResolvedMedia = { kind: H3MediaKind; url: string; role: string };

type H3ContentItem = {
  type: "text" | "image_url" | "video_url" | "audio_url";
  text?: string;
  image_url?: { url: string };
  video_url?: { url: string };
  audio_url?: { url: string };
  role?: string;
};

type H3CreateResponse = Record<string, unknown>;
type H3TaskResponse = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStatus(value: unknown): string {
  const status = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["success", "succeed", "succeeded", "completed"].includes(status)) return "succeeded";
  if (["queued", "processing", "in_progress", "running", "submitted", "not_start"].includes(status)) {
    return "processing";
  }
  if (["failure", "failed", "error", "cancelled", "canceled", "expired"].includes(status)) return "failed";
  return status || "unknown";
}

function getMediaRole(block: GenerationContentBlock): string | undefined {
  const role = getBlockMeta(block)?.role;
  return typeof role === "string" && role.trim() ? role.trim() : undefined;
}

function getH3InputMedia(input: GenerationAdapterInput): H3InputMedia[] {
  return input.request.content
    .filter(
      (block): block is Extract<GenerationContentBlock, { type: "image" | "video" | "audio" }> =>
        block.type === "image" || block.type === "video" || block.type === "audio",
    )
    .map((block) => ({ kind: block.type, source: block.source, role: getMediaRole(block) }));
}

function classifyMedia(media: H3InputMedia[]): H3Mode {
  let firstFrames = 0;
  let lastFrames = 0;
  let referenceImages = 0;
  let referenceVideos = 0;
  let referenceAudio = 0;

  for (const item of media) {
    if (!item.role) {
      throw new GenerationValidationError(`${item.kind} input must use a MiniMax H3 role`);
    }
    if (item.kind === "image") {
      if (item.role === "first_frame") firstFrames += 1;
      else if (item.role === "last_frame") lastFrames += 1;
      else if (item.role === "reference_image") referenceImages += 1;
      else throw new GenerationValidationError(`image role is not supported by MiniMax H3: ${item.role}`);
    } else if (item.kind === "video") {
      if (item.role !== "reference_video") {
        throw new GenerationValidationError(`video role must be reference_video for MiniMax H3`);
      }
      referenceVideos += 1;
    } else {
      if (item.role !== "reference_audio") {
        throw new GenerationValidationError(`audio role must be reference_audio for MiniMax H3`);
      }
      referenceAudio += 1;
    }
  }

  if (firstFrames > 1 || lastFrames > 1) {
    throw new GenerationValidationError("MiniMax H3 supports at most one first_frame and one last_frame image");
  }
  if (referenceImages > MAX_REFERENCE_IMAGES) {
    throw new GenerationValidationError(`MiniMax H3 supports at most ${MAX_REFERENCE_IMAGES} reference images`);
  }
  if (referenceVideos > MAX_REFERENCE_VIDEOS) {
    throw new GenerationValidationError(`MiniMax H3 supports at most ${MAX_REFERENCE_VIDEOS} reference videos`);
  }
  if (referenceAudio > MAX_REFERENCE_AUDIO) {
    throw new GenerationValidationError(`MiniMax H3 supports at most ${MAX_REFERENCE_AUDIO} reference audio files`);
  }
  if (media.length > MAX_MEDIA_COUNT) {
    throw new GenerationValidationError(
      `MiniMax H3 supports at most ${MAX_MEDIA_COUNT} media items; received ${referenceImages} reference images, ${referenceVideos} reference videos, ${referenceAudio} reference audio inputs, and ${firstFrames + lastFrames} frame images`,
    );
  }

  const hasFrames = firstFrames + lastFrames > 0;
  const hasReferences = referenceImages + referenceVideos + referenceAudio > 0;
  if (hasFrames && hasReferences) {
    throw new GenerationValidationError("MiniMax H3 cannot mix frame images with reference materials");
  }
  if (hasFrames) return "frame";
  if (hasReferences) return "reference";
  return "text";
}

async function resolveMedia(input: GenerationAdapterInput, media: H3InputMedia[]): Promise<H3ResolvedMedia[]> {
  return Promise.all(
    media.map(async (item) => ({
      kind: item.kind,
      role: item.role as string,
      url: await input.context.resolveSource(item.source),
    })),
  );
}

function buildContent(prompt: string, media: H3ResolvedMedia[]): H3ContentItem[] {
  return [
    { type: "text", text: prompt },
    ...media.map((item) => {
      if (item.kind === "image") return { type: "image_url" as const, image_url: { url: item.url }, role: item.role };
      if (item.kind === "video") return { type: "video_url" as const, video_url: { url: item.url }, role: item.role };
      return { type: "audio_url" as const, audio_url: { url: item.url }, role: item.role };
    }),
  ];
}

function resolveResolution(value: unknown): string {
  return asString(value) ?? "768P";
}

function resolveDuration(value: unknown): number {
  return asInteger(value, 5);
}

function resolveRatio(value: unknown, mode: H3Mode): string {
  const requested = asString(value) ?? DEFAULT_RATIO;
  if (!(H3_RATIOS as readonly string[]).includes(requested)) {
    throw new GenerationValidationError(`MiniMax H3 ratio must be one of: ${H3_RATIOS.join(", ")}`);
  }
  return mode === "text" && requested === ADAPTIVE_RATIO ? DEFAULT_RATIO : requested;
}

function extractTaskId(response: H3CreateResponse): string {
  const data = isRecord(response.data) ? response.data : undefined;
  const taskId = asString(response.task_id) ?? asString(response.id) ?? asString(data?.task_id) ?? asString(data?.id);
  if (!taskId) {
    throw new GenerationProviderError("MiniMax H3 provider did not return a task id", { details: { response } });
  }
  return taskId;
}

function isTaskPayload(value: Record<string, unknown>): boolean {
  return ["status", "task", "result_url", "video_url", "url", "error", "progress", "fail_reason"].some(
    (key) => key in value,
  );
}

function unwrapTaskPayload(response: H3TaskResponse): Record<string, unknown> {
  const data = isRecord(response.data) ? response.data : undefined;
  return data && !isTaskPayload(response) ? data : response;
}

function extractTaskStatus(response: H3TaskResponse) {
  const payload = unwrapTaskPayload(response);
  const task = isRecord(payload.task) ? payload.task : payload;
  const metadata = isRecord(payload.metadata) ? payload.metadata : isRecord(task.metadata) ? task.metadata : undefined;
  const content = isRecord(task.content) ? task.content : undefined;
  const status = normalizeStatus(payload.status ?? task.status);
  const videoUrl =
    asString(metadata?.url) ??
    asString(payload.result_url) ??
    asString(payload.video_url) ??
    asString(payload.url) ??
    asString(task.result_url) ??
    asString(task.video_url) ??
    asString(task.url) ??
    asString(content?.video_url) ??
    asString(content?.url);
  const error = isRecord(payload.error) ? payload.error : isRecord(task.error) ? task.error : undefined;
  const message =
    asString(error?.message) ??
    asString(payload.fail_reason) ??
    asString(payload.message) ??
    asString(task.fail_reason) ??
    asString(task.message) ??
    asString(response.message);
  const outputMetadata = compactObject({
    progress: payload.progress ?? task.progress,
    resolution: payload.resolution ?? task.resolution,
    duration: payload.duration ?? task.duration,
    ratio: payload.ratio ?? task.ratio,
  });
  return { status: error && status === "unknown" ? "failed" : status, videoUrl, message, metadata: outputMetadata };
}

async function requestJson(input: GenerationAdapterInput, path: string, init: RequestInit): Promise<unknown> {
  return (await requestJsonResponse(input, path, init)).body;
}

// 任务查询还要读取失败类别响应头：任务被审核拦截时，查询本身是 200。
async function requestJsonResponse(
  input: GenerationAdapterInput,
  path: string,
  init: RequestInit,
): Promise<{ body: unknown; category: string | undefined }> {
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
  const body = await response.text();
  let parsed: unknown = {};
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new GenerationProviderError("MiniMax H3 provider returned invalid JSON", { status: response.status, body });
  }
  if (!response.ok) {
    throw new GenerationProviderError("MiniMax H3 provider request failed", {
      status: response.status,
      body,
      ...(isRecord(parsed) ? { details: parsed } : {}),
    });
  }
  return { body: parsed, category: response.headers.get(FAILURE_CATEGORY_HEADER) ?? undefined };
}

export async function minimaxH3VideoGenerationsAdapter(
  input: GenerationAdapterInput,
): Promise<GenerationContentBlock[]> {
  const prompt = mergeTextBlocks(input.declaration, input.request.content);
  if (!prompt) throw new GenerationValidationError("Prompt text is required");

  const inputMedia = getH3InputMedia(input);
  const mode = classifyMedia(inputMedia);
  const media = await resolveMedia(input, inputMedia);
  const duration = resolveDuration(input.parameters.duration);
  const resolution = resolveResolution(input.parameters.resolution);
  const ratio = resolveRatio(input.parameters.ratio, mode);
  const pollIntervalSec = Math.max(1, asInteger(input.parameters.poll_interval, DEFAULT_POLL_INTERVAL_SEC));
  const maxWaitSec = Math.max(30, asInteger(input.parameters.max_wait, DEFAULT_MAX_WAIT_SEC));
  const aigcWatermark = asBoolean(input.parameters.aigc_watermark, false);
  const payload = {
    model: input.declaration.model,
    content: buildContent(prompt, media),
    resolution,
    duration,
    ratio,
    aigc_watermark: aigcWatermark,
  };

  const task = (await requestJson(input, "/v1/video/generations", {
    method: "POST",
    body: JSON.stringify(payload),
  })) as H3CreateResponse;
  const taskId = extractTaskId(task);

  for await (const _ of taskPollTicks(maxWaitSec * 1000, pollIntervalSec * 1000)) {
    const response = await requestJsonResponse(input, `/v1/video/generations/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });
    const rawStatus = response.body as H3TaskResponse;
    const status = extractTaskStatus(rawStatus);

    if (status.status === "succeeded") {
      if (!status.videoUrl) {
        throw new GenerationProviderError("MiniMax H3 generation succeeded but returned no video URL", {
          details: compactObject({ taskId, rawStatus, metadata: status.metadata }),
        });
      }
      return [
        {
          type: "video",
          source: { type: "url", url: status.videoUrl },
          meta: { task_id: taskId, status: status.status, ...status.metadata },
        },
      ];
    }
    if (status.status === "failed") {
      throw new GenerationProviderError(`MiniMax H3 generation failed${status.message ? `: ${status.message}` : ""}`, {
        details: compactObject({ taskId, rawStatus }),
        category: response.category,
      });
    }
  }

  throw new GenerationTimeoutError("Timed out waiting for MiniMax H3 video generation", { taskId });
}
