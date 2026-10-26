import {
  FAILURE_CATEGORY_HEADER,
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationValidationError,
} from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import { taskPollTicks } from "../task-poll.js";
import type { GenerationAdapterInput, GenerationContentBlock } from "../types.js";
import { compactObject } from "../utils.js";

const REQUEST_TIMEOUT_MS = 1_860_000;
const DEFAULT_POLL_INTERVAL_SEC = 1;
const DEFAULT_MAX_WAIT_SEC = 600;

type TaskResponse = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function unwrapTaskPayload(response: TaskResponse): TaskResponse {
  const data = isRecord(response.data) ? response.data : undefined;
  const hasTaskFields = ["status", "task", "result_url", "video_url", "url", "error", "progress", "fail_reason"].some(
    (key) => key in response,
  );
  return data && !hasTaskFields ? data : response;
}

function extractTaskId(response: TaskResponse): string {
  const data = isRecord(response.data) ? response.data : undefined;
  const taskId = asString(response.task_id) ?? asString(response.id) ?? asString(data?.task_id) ?? asString(data?.id);
  if (!taskId) {
    throw new GenerationProviderError("Video upscale provider did not return a task id", { details: { response } });
  }
  return taskId;
}

function extractTaskStatus(response: TaskResponse) {
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
    output_width: payload.output_width ?? task.output_width,
    output_height: payload.output_height ?? task.output_height,
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
    throw new GenerationProviderError("Video upscale provider returned invalid JSON", {
      status: response.status,
      body,
    });
  }
  if (!response.ok) {
    throw new GenerationProviderError("Video upscale provider request failed", {
      status: response.status,
      body,
      ...(isRecord(parsed) ? { details: parsed } : {}),
    });
  }
  return { body: parsed, category: response.headers.get(FAILURE_CATEGORY_HEADER) ?? undefined };
}

function validateResolvedUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GenerationValidationError("video-upscale-native requires an absolute http or https video URL");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new GenerationValidationError("video-upscale-native requires an absolute http or https video URL");
  }
}

export async function videoUpscaleNativeAdapter(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const video = input.request.content.find((block) => block.type === "video");
  if (!video || video.type !== "video") {
    throw new GenerationValidationError("video-upscale-native requires one video URL");
  }
  const videoUrl = await input.context.resolveSource(video.source);
  validateResolvedUrl(videoUrl);
  const pollIntervalSec = DEFAULT_POLL_INTERVAL_SEC;
  const maxWaitSec = DEFAULT_MAX_WAIT_SEC;

  const task = (await requestJson(input, "/v1/video/generations", {
    method: "POST",
    body: JSON.stringify({ model: input.declaration.model, video_url: videoUrl }),
  })) as TaskResponse;
  const taskId = extractTaskId(task);

  for await (const _ of taskPollTicks(maxWaitSec * 1000, pollIntervalSec * 1000)) {
    const response = await requestJsonResponse(input, `/v1/video/generations/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });
    const rawStatus = response.body as TaskResponse;
    const status = extractTaskStatus(rawStatus);

    if (status.status === "succeeded") {
      if (!status.videoUrl) {
        throw new GenerationProviderError("Video upscale succeeded but returned no video URL", {
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
      throw new GenerationProviderError(`Video upscale failed${status.message ? `: ${status.message}` : ""}`, {
        details: compactObject({ taskId, rawStatus }),
        category: response.category,
      });
    }
  }

  throw new GenerationTimeoutError("Timed out waiting for video upscale", { taskId });
}
