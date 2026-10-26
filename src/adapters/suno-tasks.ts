import {
  FAILURE_CATEGORY_HEADER,
  failureCategoryOf,
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationValidationError,
} from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import { taskPollTicks } from "../task-poll.js";
import type {
  GenerationAdapterInput,
  GenerationContentBlock,
  GenerationContentSpec,
  GenerationSource,
} from "../types.js";
import { compactObject } from "../utils.js";
import { mergeTextBlocks } from "../validation.js";

const REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_MAX_WAIT_SEC = 600;
const DEFAULT_MUSIC_VERSION = "chirp-v5";

const OPERATION_PATHS: Record<
  string,
  { path: string; poll: boolean; defaultMusicVersion?: boolean; textField?: string; requireText?: boolean }
> = {
  music: { path: "/suno/submit/music", poll: true, defaultMusicVersion: true, textField: "prompt" },
  lyrics: { path: "/suno/submit/lyrics", poll: true, textField: "prompt", requireText: true },
  concat: { path: "/suno/submit/concat", poll: true },
  upsample_tags: { path: "/suno/submit/upsample-tags", poll: false, textField: "original_tags", requireText: true },
  upload_audio: { path: "/suno/uploads/audio", poll: true },
};

const FINAL_SUCCESS_STATUSES = new Set(["success", "succeeded", "completed"]);
const FINAL_FAILURE_STATUSES = new Set(["failure", "failed", "error", "cancelled", "canceled", "expired"]);

type TaskResponse<T = unknown> = {
  code?: unknown;
  message?: unknown;
  data?: T;
};

type SunoTaskDto = {
  task_id?: unknown;
  taskBatchId?: unknown;
  task_batch_id?: unknown;
  action?: unknown;
  status?: unknown;
  taskStatus?: unknown;
  task_status?: unknown;
  fail_reason?: unknown;
  failReason?: unknown;
  result_url?: unknown;
  progress?: unknown;
  submit_time?: unknown;
  start_time?: unknown;
  finish_time?: unknown;
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function successCode(value: unknown): boolean {
  const code = String(value ?? "")
    .trim()
    .toLowerCase();
  return code === "success" || code === "200" || code === "0";
}

function requireSuccess<T>(response: TaskResponse<T>, fallbackMessage: string): T {
  if (!successCode(response.code)) {
    throw new GenerationProviderError(fallbackMessage, {
      details: {
        code: response.code,
        message: response.message,
        data: response.data,
      },
    });
  }
  return response.data as T;
}

function extractTaskId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  for (const key of ["task_id", "id", "taskBatchId"]) {
    const taskId = asString(value[key]);
    if (taskId) return taskId;
  }
  return undefined;
}

function normalizeStatus(value: unknown): string {
  const status = String(value ?? "")
    .trim()
    .toLowerCase();
  if (status === "finished") return "success";
  if (status === "fail" || status === "rejected") return "failed";
  return status;
}

function normalizeTask(operation: string, data: unknown): SunoTaskDto | null {
  if (Array.isArray(data)) return data.length > 0 ? normalizeTask(operation, data[0]) : null;
  if (!isRecord(data)) return null;
  if ("status" in data || "taskStatus" in data || "task_status" in data || "task_id" in data || "taskBatchId" in data) {
    const hasProviderEnvelope =
      "taskStatus" in data || "task_status" in data || "taskBatchId" in data || "task_batch_id" in data;
    return {
      ...data,
      task_id: data.task_id ?? data.taskBatchId ?? data.task_batch_id,
      status: data.status ?? data.taskStatus ?? data.task_status,
      fail_reason: data.fail_reason ?? data.failReason,
      data: data.data ?? (hasProviderEnvelope ? data : undefined),
    } as SunoTaskDto;
  }
  if (Array.isArray(data.data) && data.data.length > 0) return normalizeTask(operation, data.data[0]);
  return { action: operation, status: "SUCCESS", data };
}

function getOperation(input: GenerationAdapterInput): string {
  const fixedOperation = asString(input.declaration.adapter.operation);
  const requestedOperation = asString(input.parameters.operation);
  if (fixedOperation && requestedOperation && fixedOperation !== requestedOperation) {
    throw new GenerationValidationError(
      `${input.declaration.model} uses Suno operation ${fixedOperation}; parameters.operation cannot override it`,
    );
  }
  const operation = fixedOperation ?? requestedOperation ?? "music";
  if (!OPERATION_PATHS[operation]) throw new GenerationValidationError(`Unsupported Suno operation: ${operation}`);
  return operation;
}

async function buildPayload(input: GenerationAdapterInput, operation: string): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {
    ...asRecord(input.declaration.adapter.defaults),
    ...input.meta,
  };
  const config = OPERATION_PATHS[operation];

  const prompt = mergeTextBlocks(input.declaration, input.request.content);
  const descriptionMode = operation === "music" && input.declaration.model === "suno_music_chirp_fenix";
  if (descriptionMode && prompt && payload.gpt_description_prompt === undefined) {
    payload.gpt_description_prompt = prompt;
  }
  if (descriptionMode && payload.lyrics !== undefined) {
    if (payload.prompt === undefined) payload.prompt = payload.lyrics;
    delete payload.lyrics;
  } else if (prompt && config?.textField && payload[config.textField] === undefined && !descriptionMode) {
    payload[config.textField] = prompt;
  }
  const audioBlock = input.request.content.find(
    (block): block is Extract<GenerationContentBlock, { type: "audio" }> => block.type === "audio",
  );
  if (audioBlock && payload.url === undefined) payload.url = await input.context.resolveSource(audioBlock.source);

  const imageBlock = input.request.content.find(
    (block): block is Extract<GenerationContentBlock, { type: "image" }> => block.type === "image",
  );
  let imageUrl: string | undefined;
  if (imageBlock) {
    imageUrl = await input.context.resolveSource(imageBlock.source);
    if (payload.image_url === undefined) payload.image_url = imageUrl;
  }

  const videoBlock = input.request.content.find(
    (block): block is Extract<GenerationContentBlock, { type: "video" }> => block.type === "video",
  );
  let videoUrl: string | undefined;
  if (videoBlock) {
    videoUrl = await input.context.resolveSource(videoBlock.source);
    if (payload.video_url === undefined) payload.video_url = videoUrl;
  }

  applyFixedPayload(input, payload, asRecord(input.declaration.adapter.payload));
  const fixedTask = asString(input.declaration.adapter.task);
  if (fixedTask) applyFixedPayload(input, payload, { task: fixedTask });

  const task = asString(payload.task);
  if (task === "image_to_song" && imageUrl) setMetadataParam(payload, "image_url", imageUrl);
  if (task === "video_to_song" && videoUrl) setMetadataParam(payload, "video_url", videoUrl);
  if (task === "cover" && payload.clip_id === undefined) {
    const coverClipId = asString(payload.cover_clip_id);
    if (coverClipId) payload.clip_id = coverClipId;
  }

  normalizeMusicTaskPayload(input, operation, payload);

  if (config?.defaultMusicVersion && payload.mv === undefined && payload.model_name === undefined) {
    payload.mv = DEFAULT_MUSIC_VERSION;
  }

  validateSunoPayload(operation, payload);
  return payload;
}

function applyFixedPayload(
  input: GenerationAdapterInput,
  payload: Record<string, unknown>,
  fixed: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(fixed)) {
    if (value === undefined) continue;
    if (payload[key] !== undefined && payload[key] !== value) {
      throw new GenerationValidationError(
        `${input.declaration.model} fixes Suno ${key}; meta.${key} cannot override it`,
      );
    }
    payload[key] = value;
  }
}

function setMetadataParam(payload: Record<string, unknown>, key: string, value: string): void {
  const metadataParams = isRecord(payload.metadata_params) ? payload.metadata_params : {};
  if (metadataParams[key] === undefined) metadataParams[key] = value;
  payload.metadata_params = metadataParams;
}

function contentCount(content: GenerationContentBlock[], type: GenerationContentSpec["type"]): number {
  return content.filter((block) => block.type === type).length;
}

function normalizeMusicTaskPayload(
  input: GenerationAdapterInput,
  operation: string,
  payload: Record<string, unknown>,
): void {
  if (operation !== "music") return;
  const taskField = input.declaration.meta?.taskField ?? "task";
  const task = asString(payload[taskField]);
  if (!task) return;
  const taskVariant = input.declaration.meta?.taskVariants?.[task];
  if (!taskVariant) throw new GenerationValidationError(`Unsupported Suno music task: ${task}`);
  for (const key of taskVariant.required ?? []) {
    if (payload[key] === undefined || payload[key] === null || payload[key] === "") {
      throw new GenerationValidationError(`Suno task ${task} requires meta.${key}`);
    }
  }
  for (const type of taskVariant.requiredContent ?? []) {
    if (contentCount(input.request.content, type) === 0) {
      throw new GenerationValidationError(`Suno task ${task} requires ${type} content`);
    }
  }
  if (taskVariant.sendTask === false) delete payload[taskField];
}

function validateSunoPayload(operation: string, payload: Record<string, unknown>): void {
  const config = OPERATION_PATHS[operation];
  const task = asString(payload.task);
  if (operation === "music" && task) {
    if (task === "lyrics") throw new GenerationValidationError("Use operation=lyrics instead of task=lyrics");
  }
  if (config?.requireText && !asString(payload[config.textField ?? "prompt"])) {
    throw new GenerationValidationError(`${config.textField ?? "prompt"} text is required`);
  }
  if (operation === "upload_audio" && !asString(payload.url)) {
    throw new GenerationValidationError("Audio url is required for Suno upload_audio");
  }
  if (operation === "concat" && !asString(payload.clip_id)) {
    throw new GenerationValidationError("clip_id is required for Suno concat");
  }
}

async function requestJson(input: GenerationAdapterInput, path: string, init: RequestInit): Promise<TaskResponse> {
  return (await requestJsonResponse(input, path, init)).body;
}

// 任务查询还要读取失败类别响应头：任务被审核拦截时，查询本身是 200。
async function requestJsonResponse(
  input: GenerationAdapterInput,
  path: string,
  init: RequestInit,
): Promise<{ body: TaskResponse; category: string | undefined }> {
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
  let parsed: TaskResponse;
  try {
    parsed = body ? (JSON.parse(body) as TaskResponse) : {};
  } catch {
    throw new GenerationProviderError("Suno provider returned invalid JSON", { status: response.status, body });
  }
  if (!response.ok) {
    throw new GenerationProviderError("Suno provider request failed", {
      status: response.status,
      details: { body: parsed },
      category: failureCategoryOf(parsed),
    });
  }
  return { body: parsed, category: response.headers.get(FAILURE_CATEGORY_HEADER) ?? undefined };
}

function appendUrlBlock(
  output: GenerationContentBlock[],
  type: "audio" | "video" | "image",
  url: unknown,
  meta: Record<string, unknown>,
): void {
  const value = asString(url);
  if (!value) return;
  output.push({ type, source: { type: "url", url: value } as GenerationSource, meta: compactObject(meta) });
}

function appendSunoContent(output: GenerationContentBlock[], value: unknown, meta: Record<string, unknown> = {}): void {
  if (Array.isArray(value)) {
    for (const item of value) appendSunoContent(output, item, meta);
    return;
  }
  if (!isRecord(value)) return;

  if (isRecord(value.clips)) {
    for (const clip of Object.values(value.clips)) appendSunoContent(output, clip, meta);
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) appendSunoContent(output, item, meta);
  }

  const itemMeta = compactObject({
    ...meta,
    id: value.id,
    clip_id: value.clipId ?? value.clip_id ?? meta.clip_id,
    task_id: value.task_id ?? value.taskId ?? meta.task_id,
    title: value.title,
    status: value.status ?? meta.status,
    model: value.model_name ?? value.modelName,
    duration: value.duration ?? (isRecord(value.metadata) ? value.metadata.duration : undefined),
    tags: value.tags ?? (isRecord(value.metadata) ? value.metadata.tags : undefined),
    prompt: value.prompt ?? (isRecord(value.metadata) ? value.metadata.prompt : undefined),
    progress: value.progress ?? meta.progress,
    progress_message: value.progressMsg ?? value.progress_msg,
    task_batch_id: value.taskBatchId ?? value.task_batch_id,
    continue_clip_id: value.continueClipId ?? value.continue_clip_id,
    input_type: value.inputType ?? value.input_type,
    make_instrumental: value.makeInstrumental ?? value.make_instrumental,
    created_at: value.createTime ?? value.created_at,
  });

  appendUrlBlock(
    output,
    "audio",
    value.audio_url ?? value.audioUrl ?? value.cld2AudioUrl ?? value.cld2_audio_url,
    itemMeta,
  );
  appendUrlBlock(output, "audio", value.vocal_audio_url ?? value.vocalAudioUrl, itemMeta);
  appendUrlBlock(output, "audio", value.instrumental_audio_url ?? value.instrumentalAudioUrl, itemMeta);
  appendUrlBlock(output, "audio", value.source_audio_url ?? value.sourceAudioUrl, itemMeta);
  appendUrlBlock(
    output,
    "video",
    value.video_url ?? value.videoUrl ?? value.cld2VideoUrl ?? value.cld2_video_url,
    itemMeta,
  );
  appendUrlBlock(
    output,
    "image",
    value.image_large_url ?? value.image_url ?? value.imageUrl ?? value.cld2ImageUrl ?? value.cld2_image_url,
    itemMeta,
  );

  const text = asString(value.upsampled_tags) ?? asString(value.text) ?? asString(value.lyrics);
  if (text) output.push({ type: "text", text, meta: itemMeta });

  if (isRecord(value.data)) appendSunoContent(output, value.data, itemMeta);
}

function buildImmediateResult(operation: string, data: unknown, raw: unknown): GenerationContentBlock[] {
  const output: GenerationContentBlock[] = [];
  const metadata = compactObject({ operation, raw });
  appendSunoContent(output, data, metadata);
  if (output.length > 0) return output;

  const value = extractTaskId(data) ?? asString(data);
  if (value) output.push({ type: "text", text: value, meta: metadata });
  return requireSunoOutput(output, "Suno provider returned no output", { operation, raw });
}

function requireSunoOutput(
  output: GenerationContentBlock[],
  message: string,
  details: Record<string, unknown>,
): GenerationContentBlock[] {
  if (output.length === 0) throw new GenerationProviderError(message, { details });
  return output;
}

function buildResult(operation: string, task: SunoTaskDto, raw: unknown): GenerationContentBlock[] {
  const output: GenerationContentBlock[] = [];
  const metadata = compactObject({
    operation,
    task_id: task.task_id,
    action: task.action,
    status: task.status,
    fail_reason: task.fail_reason,
    progress: task.progress,
    submit_time: task.submit_time,
    start_time: task.start_time,
    finish_time: task.finish_time,
    raw,
  });
  appendSunoContent(output, task.data, metadata);
  appendUrlBlock(output, "audio", task.result_url, metadata);
  return requireSunoOutput(output, "Suno task succeeded but returned no output", { operation, task, raw });
}

async function pollSunoTask(
  input: GenerationAdapterInput,
  operation: string,
  taskId: string,
  pollIntervalSec: number,
  maxWaitSec: number,
): Promise<GenerationContentBlock[]> {
  for await (const _ of taskPollTicks(maxWaitSec * 1000, pollIntervalSec * 1000)) {
    let response: { body: TaskResponse; category: string | undefined };
    try {
      response = await requestJsonResponse(input, `/suno/fetch/${encodeURIComponent(taskId)}`, { method: "GET" });
    } catch (error) {
      if (error instanceof GenerationProviderError) throw error;
      continue;
    }
    const data = requireSuccess(response.body, "Suno task fetch failed");
    const task = normalizeTask(operation, data);
    if (!task) throw new GenerationProviderError("Suno task fetch returned invalid task data", { details: { data } });

    const status = normalizeStatus(task.status);
    if (FINAL_SUCCESS_STATUSES.has(status)) return buildResult(operation, task, data);
    if (FINAL_FAILURE_STATUSES.has(status)) {
      throw new GenerationProviderError("Suno task failed", {
        details: {
          task_id: taskId,
          status: task.status,
          fail_reason: task.fail_reason,
        },
        category: response.category,
      });
    }
  }
  throw new GenerationTimeoutError("Timed out waiting for Suno task", { task_id: taskId, operation });
}

export async function sunoTasksAdapter(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const operation = getOperation(input);
  const payload = await buildPayload(input, operation);
  const config = OPERATION_PATHS[operation];
  if (!config) throw new GenerationValidationError(`Unsupported Suno operation: ${operation}`);
  const raw = await requestJson(input, config.path, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const data = requireSuccess(raw, "Suno task submit failed");

  if (!config.poll) return buildImmediateResult(operation, data, raw);

  const taskId = extractTaskId(data);
  if (!taskId) return buildImmediateResult(operation, data, raw);

  const pollIntervalSec = asInteger(input.parameters.poll_interval, DEFAULT_POLL_INTERVAL_SEC);
  const maxWaitSec = asInteger(input.parameters.max_wait, DEFAULT_MAX_WAIT_SEC);
  return pollSunoTask(input, operation, taskId, pollIntervalSec, maxWaitSec);
}
