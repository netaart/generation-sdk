import {
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationTransportError,
  GenerationValidationError,
} from "../errors.js";
import { fetchTextWithTimeout, joinUrl } from "../http.js";
import { taskPollTicks } from "../task-poll.js";
import type {
  GenerationAdapter,
  GenerationAdapterInput,
  GenerationContentBlock,
  GenerationSource,
  GenerationSourceResolver,
  ResolvedGenerationRequest,
} from "../types.js";
import { compactObject } from "../utils.js";
import { mergeTextBlocks } from "../validation.js";

// 任务成功之后的那次查询要等网关把全部结果文件归档完成。单次请求的超时低于 Node fetch 默认 300 秒的响应头超时，
// 归档时间更长时本次查询超时，下一次轮询继续等待网关正在进行的同一次归档。
const REQUEST_TIMEOUT_MS = 240_000;
const DEFAULT_POLL_INTERVAL_SEC = 5;
const DEFAULT_MAX_WAIT_SEC = 3600;
// 单次查询的网络错误、超时、408、429 和 5xx 不代表任务失败，下一次轮询继续查询；连续失败这么多次之后放弃。
const MAX_CONSECUTIVE_POLL_FAILURES = 10;
// operation 选择功能，poll_interval 和 max_wait 控制等待，这些参数不发送给 Meshy。
const SDK_PARAMETERS = new Set(["operation", "poll_interval", "max_wait"]);

// Meshy 文档列出的可以作为 input_task_id 的任务类型；其他类型的任务改为发送模型文件的链接。
const RETEXTURE_INPUT_TASK_TYPES = ["text-to-3d-preview", "text-to-3d-refine", "image-to-3d", "remesh"];
const REMESH_INPUT_TASK_TYPES = ["text-to-3d-preview", "text-to-3d-refine", "image-to-3d", "retexture"];

const RESULT_FILE_ORDER = [
  "rigged_character_glb_url",
  "rigged_character_fbx_url",
  "animation_glb_url",
  "animation_fbx_url",
  "motion_url",
];
const MODEL_FILE_ORDER = ["glb", "fbx", "obj", "usdz", "stl", "3mf", "blend"];
// input_task_id 让 Meshy 读取任务的主要模型，只有这些字段的文件是这个模型。
const MAIN_MODEL_FIELDS = new Set(MODEL_FILE_ORDER.map((format) => `model_urls.${format}`));
const VIEW_ORDER = ["front", "right", "back", "left"];
const TEXTURE_ORDER = ["base_color", "metallic", "roughness", "normal", "emission"];
const ANIMATION_FPS = [24, 25, 30, 60];

type MediaBlock = Extract<GenerationContentBlock, { type: "image" | "3d" }>;
type BodyFields = Record<string, unknown>;

type MeshyContent = {
  prompt: string;
  /** Image blocks, except texture-role images on operations that declare the texture role. */
  images: MediaBlock[];
  textures: MediaBlock[];
  /** 3D blocks, except motion-role blocks on operations that declare the motion role. */
  models: MediaBlock[];
  motions: MediaBlock[];
};

type MeshyOperation = {
  path: string;
  /** Validates the content and returns the request body; media fields hold PendingSource values. */
  plan(content: MeshyContent, parameters: BodyFields): BodyFields;
};

class PendingSource {
  constructor(readonly source: GenerationSource) {}
}

const OPERATIONS: Record<string, MeshyOperation> = {
  "text-to-3d": {
    path: "/meshy/openapi/v2/text-to-3d",
    plan: (content, parameters) => ({ ...parameters, mode: "preview", prompt: requirePrompt(content) }),
  },
  "text-to-3d-refine": {
    path: "/meshy/openapi/v2/text-to-3d",
    plan(content, parameters) {
      const preview = one(content.models, "3d preview model");
      const texture = atMostOne(content.images, "texture image");
      rejectTextAndImage(content.prompt, texture !== undefined, "texture");
      return {
        ...parameters,
        mode: "refine",
        preview_task_id: requireTaskId(preview, "preview_task_id", "text-to-3d-preview"),
        ...optional("texture_prompt", content.prompt || undefined),
        ...optional("texture_image_url", texture && pending(texture)),
      };
    },
  },
  "image-to-3d": {
    path: "/meshy/openapi/v1/image-to-3d",
    plan(content, parameters) {
      const image = one(content.images, "input image");
      const texture = atMostOne(content.textures, "texture image");
      rejectTextAndImage(content.prompt, texture !== undefined, "texture");
      return {
        ...parameters,
        image_url: pending(image),
        ...optional("texture_prompt", content.prompt || undefined),
        ...optional("texture_image_url", texture && pending(texture)),
      };
    },
  },
  "multi-image-to-3d": {
    path: "/meshy/openapi/v1/multi-image-to-3d",
    plan(content, parameters) {
      const images = between(content.images, 1, 4, "input image");
      const textures = between(content.textures, 0, 4, "texture image");
      rejectTextAndImage(content.prompt, textures.length > 0, "texture");
      if (textures.length > 1) requireAiModel(parameters, [undefined, "latest", "meshy-7.1"], "Several texture images");
      return {
        ...parameters,
        image_urls: images.map(pending),
        ...optional("texture_prompt", content.prompt || undefined),
        ...imageList("texture_image_url", "texture_image_urls", textures),
      };
    },
  },
  retexture: {
    path: "/meshy/openapi/v1/retexture",
    plan(content, parameters) {
      const model = one(content.models, "3d model");
      const styles = between(content.images, 0, 4, "style image");
      rejectTextAndImage(content.prompt, styles.length > 0, "style");
      if (!content.prompt && styles.length === 0) {
        throw new GenerationValidationError("Meshy retexture requires a style text or 1 to 4 style images");
      }
      if (styles.length > 1) requireAiModel(parameters, ["meshy-7"], "Several style images");
      return {
        ...parameters,
        ...modelInput(model, RETEXTURE_INPUT_TASK_TYPES),
        ...optional("text_style_prompt", content.prompt || undefined),
        ...imageList("image_style_url", "multiview_image_urls", styles),
      };
    },
  },
  remesh: {
    path: "/meshy/openapi/v1/remesh",
    plan: (content, parameters) => ({
      ...parameters,
      ...modelInput(one(content.models, "3d model"), REMESH_INPUT_TASK_TYPES),
    }),
  },
  rigging: {
    path: "/meshy/openapi/v1/rigging",
    plan(content, parameters) {
      const model = one(content.models, "3d model");
      const texture = atMostOne(content.images, "texture image");
      return {
        ...parameters,
        ...modelInput(model),
        ...optional("texture_image_url", texture && pending(texture)),
      };
    },
  },
  animation: {
    path: "/meshy/openapi/v1/animations",
    plan(content, { post_process, fps, ...parameters }) {
      const rig = one(content.models, "rigged 3d model");
      const motion = atMostOne(content.motions, "motion");
      const actions = [parameters.action_id, parameters.action_ids, motion].filter((value) => value !== undefined);
      if (actions.length !== 1) {
        throw new GenerationValidationError(
          "Meshy animation requires exactly one of parameters.action_id, parameters.action_ids, or a 3d block with meta.role motion",
        );
      }
      if (fps !== undefined && post_process !== "change_fps") {
        throw new GenerationValidationError("Parameter fps requires post_process change_fps");
      }
      if (fps !== undefined && !ANIMATION_FPS.includes(Number(fps))) {
        throw new GenerationValidationError(`Parameter fps must be one of: ${ANIMATION_FPS.join(", ")}`);
      }
      return {
        ...parameters,
        rig_task_id: requireTaskId(rig, "rig_task_id", "rig"),
        ...optional("motion_task_id", motion && requireTaskId(motion, "motion_task_id", "text-to-motion")),
        ...optional("post_process", post_process && compactObject({ operation_type: post_process, fps })),
      };
    },
  },
  "text-to-motion": {
    path: "/meshy/openapi/v1/text-to-motion",
    plan: (content, parameters) => ({ ...parameters, prompt: requirePrompt(content) }),
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function pending(block: MediaBlock): PendingSource {
  return new PendingSource(block.source);
}

function optional(field: string, value: unknown): BodyFields {
  return value === undefined ? {} : { [field]: value };
}

function requirePrompt(content: MeshyContent): string {
  if (!content.prompt) throw new GenerationValidationError("Meshy requires a non-empty text prompt");
  return content.prompt;
}

function between(blocks: MediaBlock[], min: number, max: number, label: string): MediaBlock[] {
  if (blocks.length < min || blocks.length > max) {
    const expected = min === max ? `${min}` : `${min} to ${max}`;
    throw new GenerationValidationError(`Meshy expects ${expected} ${label} block(s), got ${blocks.length}`);
  }
  return blocks;
}

function one(blocks: MediaBlock[], label: string): MediaBlock {
  const [block] = between(blocks, 1, 1, label);
  if (!block) throw new GenerationValidationError(`Meshy expects 1 ${label} block`);
  return block;
}

function atMostOne(blocks: MediaBlock[], label: string): MediaBlock | undefined {
  return between(blocks, 0, 1, label)[0];
}

function rejectTextAndImage(text: string, hasImage: boolean, purpose: string): void {
  if (text && hasImage) {
    throw new GenerationValidationError(`Meshy accepts a ${purpose} text or ${purpose} images, not both`);
  }
}

// 引用的任务必须来自对应的 Meshy 接口并且没有过期；内容块带有 meta.task_type 和 meta.task_expires_at 时在提交之前检查。
function requireTaskId(block: MediaBlock, field: string, taskType: string): string {
  const taskId = asString(block.meta?.task_id);
  if (!taskId) {
    throw new GenerationValidationError(`Meshy ${field} requires a 3d block with meta.task_id from a ${taskType} task`);
  }
  const actual = asString(block.meta?.task_type);
  if (actual && actual !== taskType) {
    throw new GenerationValidationError(`Meshy ${field} requires a ${taskType} task, got ${actual}`);
  }
  if (taskExpired(block)) {
    throw new GenerationValidationError(
      `Meshy ${field} references task ${taskId}, which expired at ${String(block.meta?.task_expires_at)}`,
    );
  }
  return taskId;
}

// Meshy 在 expires_at 之后删除任务，引用它会返回 404。
function taskExpired(block: MediaBlock): boolean {
  const expiresAt = Date.parse(asString(block.meta?.task_expires_at) ?? "");
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function requireAiModel(parameters: BodyFields, accepted: Array<string | undefined>, subject: string): void {
  const aiModel = parameters.ai_model;
  if (typeof aiModel === "string" ? !accepted.includes(aiModel) : !accepted.includes(undefined)) {
    const names = accepted.filter((name) => name !== undefined).join(" or ");
    throw new GenerationValidationError(`${subject} require parameters.ai_model ${names}`);
  }
}

// 一张图片使用单张图片的字段，多张图片使用列表字段。
function imageList(singleField: string, listField: string, blocks: MediaBlock[]): BodyFields {
  const [first, ...rest] = blocks;
  if (!first) return {};
  return rest.length === 0 ? { [singleField]: pending(first) } : { [listField]: blocks.map(pending) };
}

// 3D 输入块是可以引用的任务的主要模型时发送 input_task_id：带有 meta.task_id，任务类型是 Meshy 接受的类型，
// 文件来自 model_urls 的主要格式，任务没有过期。其他情况发送文件链接，例如 pre_remeshed_glb 和过期任务的归档副本。
function modelInput(block: MediaBlock, acceptedTaskTypes?: string[]): BodyFields {
  const taskId = asString(block.meta?.task_id);
  const taskType = asString(block.meta?.task_type);
  const field = asString(block.meta?.field);
  const referable =
    taskId !== undefined &&
    (!acceptedTaskTypes || !taskType || acceptedTaskTypes.includes(taskType)) &&
    (!field || MAIN_MODEL_FIELDS.has(field)) &&
    !taskExpired(block);
  return referable ? { input_task_id: taskId } : { model_url: pending(block) };
}

function declaredRoles(input: ResolvedGenerationRequest, type: MediaBlock["type"]): string[] {
  return input.declaration.content.input.find((spec) => spec.type === type)?.roles ?? [];
}

function classifyContent(input: ResolvedGenerationRequest): MeshyContent {
  const imageRoles = declaredRoles(input, "image");
  const modelRoles = declaredRoles(input, "3d");
  const content: MeshyContent = {
    prompt: mergeTextBlocks(input.declaration, input.request.content),
    images: [],
    textures: [],
    models: [],
    motions: [],
  };
  for (const block of input.request.content) {
    if (block.type === "image") {
      const isTexture = imageRoles.includes("texture") && block.meta?.role === "texture";
      (isTexture ? content.textures : content.images).push(block);
    } else if (block.type === "3d") {
      const isMotion = modelRoles.includes("motion") && block.meta?.role === "motion";
      (isMotion ? content.motions : content.models).push(block);
    }
  }
  return content;
}

function getOperation(input: ResolvedGenerationRequest): MeshyOperation {
  const name = asString(input.parameters.operation);
  const operation = name && Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name] : undefined;
  if (!operation) throw new GenerationValidationError(`Unsupported Meshy operation: ${String(name)}`);
  return operation;
}

// 请求体由声明过的 parameters 和内容块组成；请求 meta 和内容块的其他 meta 不会发送给 Meshy。
function planBody(input: ResolvedGenerationRequest): BodyFields {
  const parameters = Object.fromEntries(Object.entries(input.parameters).filter(([key]) => !SDK_PARAMETERS.has(key)));
  return getOperation(input).plan(classifyContent(input), parameters);
}

async function resolveValue(value: unknown, resolve: GenerationSourceResolver): Promise<unknown> {
  if (value instanceof PendingSource) return resolve(value.source);
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveValue(item, resolve)));
  return value;
}

async function resolveBody(planned: BodyFields, resolve: GenerationSourceResolver): Promise<BodyFields> {
  const entries = await Promise.all(
    Object.entries(planned).map(async ([key, value]) => [key, await resolveValue(value, resolve)] as const),
  );
  return Object.fromEntries(entries);
}

function errorMessage(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  return asString(body.message) ?? asString(asRecord(body.error).message) ?? asString(body.detail);
}

async function requestJson(input: GenerationAdapterInput, path: string, init: RequestInit): Promise<BodyFields> {
  const { response, text } = await fetchTextWithTimeout(
    input.context.fetch,
    joinUrl(input.context.baseUrl, path),
    {
      ...init,
      headers: {
        Authorization: `Bearer ${input.context.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    },
    REQUEST_TIMEOUT_MS,
  );
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    throw new GenerationProviderError(`Meshy returned invalid JSON (${response.status})`, {
      status: response.status,
      body: text,
    });
  }
  if (!response.ok) {
    const message = errorMessage(body);
    throw new GenerationProviderError(`Meshy request failed (${response.status})${message ? `: ${message}` : ""}`, {
      status: response.status,
      body: text,
    });
  }
  if (!isRecord(body)) {
    throw new GenerationProviderError("Meshy returned a non-object JSON body", { status: response.status, body: text });
  }
  return body;
}

function isTransientPollError(error: unknown): boolean {
  if (error instanceof GenerationTransportError || error instanceof GenerationTimeoutError) return true;
  if (!(error instanceof GenerationProviderError) || error.status === undefined) return false;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

// 提交成功之后积分已经扣除，提交之后的错误都带上任务 ID，原来的错误放在 cause。
function taskFailure(error: unknown, taskId: string, stage: string): GenerationProviderError {
  const provider = error instanceof GenerationProviderError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const failure = new GenerationProviderError(`Meshy task ${taskId} ${stage}: ${message}`, {
    ...(provider?.status === undefined ? {} : { status: provider.status }),
    ...(provider?.body === undefined ? {} : { body: provider.body }),
    details: { ...provider?.details, task_id: taskId },
    category: provider?.category,
  });
  failure.cause = error;
  return failure;
}

type FileEntry = { type: "3d" | "image" | "video"; field: string; url: string };

// 以 http(s):// 开头的字符串是文件链接；这样的值不能解析时，说明响应已经损坏，直接报错。
function fileUrl(field: string, value: unknown): string | undefined {
  const url = asString(value);
  if (!url || !/^https?:\/\//i.test(url)) return undefined;
  if (!URL.canParse(url)) throw new Error(`${field} is not a valid URL`);
  return url;
}

// 先列出 preferred 中的键，再按对象原有的顺序列出其余的键。
function urlEntries(
  type: FileEntry["type"],
  prefix: string | undefined,
  record: Record<string, unknown>,
  preferred: string[] = [],
): FileEntry[] {
  const keys = [
    ...preferred.filter((key) => key in record),
    ...Object.keys(record).filter((key) => !preferred.includes(key)),
  ];
  return keys.flatMap((key) => {
    const field = prefix ? `${prefix}.${key}` : key;
    const url = fileUrl(field, record[key]);
    return url ? [{ type, field, url }] : [];
  });
}

// 结果文件依次是 3D 文件（主要的 GLB 在最前）、图片和预览视频；image_urls、texture_image_url 等输入的回显不属于结果。
function taskFiles(task: BodyFields): FileEntry[] {
  const result = asRecord(task.result);
  const textures = Array.isArray(task.texture_urls) ? task.texture_urls : [];
  return [
    ...urlEntries("3d", "result", result, RESULT_FILE_ORDER),
    ...urlEntries("3d", "result.basic_animations", asRecord(result.basic_animations)),
    ...urlEntries("3d", "model_urls", asRecord(task.model_urls), MODEL_FILE_ORDER).filter(
      (entry) => entry.field !== "model_urls.mtl",
    ),
    ...urlEntries("image", undefined, {
      thumbnail_url: task.thumbnail_url,
      alpha_thumbnail_url: task.alpha_thumbnail_url,
    }),
    ...urlEntries("image", "thumbnail_urls", asRecord(task.thumbnail_urls), VIEW_ORDER),
    ...textures.flatMap((value, index) =>
      urlEntries("image", `texture_urls[${index}]`, asRecord(value), TEXTURE_ORDER),
    ),
    ...urlEntries("video", undefined, { video_url: task.video_url }),
  ];
}

function fileFormat(url: string): string | undefined {
  const name = new URL(url).pathname.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

function fileMeta(field: string, task: BodyFields): BodyFields {
  if (field === "model_urls.obj") return { mtl_url: fileUrl("model_urls.mtl", asRecord(task.model_urls).mtl) };
  if (field === "result.motion_url") return { duration_ms: asRecord(task.result).duration_ms };
  return {};
}

function outputBlocks(taskId: string, task: BodyFields): GenerationContentBlock[] {
  const expiresAt = typeof task.expires_at === "number" && task.expires_at > 0 ? task.expires_at : undefined;
  return taskFiles(task).map(
    (file): GenerationContentBlock => ({
      type: file.type,
      source: { type: "url", url: file.url },
      meta: compactObject({
        task_id: taskId,
        task_type: asString(task.type),
        field: file.field,
        format: file.type === "3d" ? fileFormat(file.url) : undefined,
        ...fileMeta(file.field, task),
        task_expires_at: expiresAt === undefined ? undefined : new Date(expiresAt).toISOString(),
      }),
    }),
  );
}

// 任务已经成功并且扣除积分：结果无法读取时的错误同样带上任务 ID。
function succeededBlocks(taskId: string, task: BodyFields): GenerationContentBlock[] {
  let blocks: GenerationContentBlock[];
  try {
    blocks = outputBlocks(taskId, task);
  } catch (error) {
    throw taskFailure(error, taskId, "returned a result that cannot be read");
  }
  if (blocks.length === 0) {
    throw new GenerationProviderError("Meshy task succeeded but returned no files", { details: { task_id: taskId } });
  }
  return blocks;
}

async function pollTask(
  input: GenerationAdapterInput,
  operation: MeshyOperation,
  taskId: string,
): Promise<GenerationContentBlock[]> {
  const pollIntervalSec = asInteger(input.parameters.poll_interval, DEFAULT_POLL_INTERVAL_SEC);
  const maxWaitSec = asInteger(input.parameters.max_wait, DEFAULT_MAX_WAIT_SEC);
  let failures = 0;
  for await (const _ of taskPollTicks(maxWaitSec * 1000, pollIntervalSec * 1000)) {
    let task: BodyFields;
    try {
      task = await requestJson(input, `${operation.path}/${encodeURIComponent(taskId)}`, { method: "GET" });
    } catch (error) {
      failures += 1;
      if (!isTransientPollError(error) || failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw taskFailure(error, taskId, "status check failed");
      }
      continue;
    }
    failures = 0;
    const status = asString(task.status);
    if (status === "SUCCEEDED") return succeededBlocks(taskId, task);
    if (status === "FAILED" || status === "CANCELED") {
      const reason = asString(asRecord(task.task_error).message);
      throw new GenerationProviderError(`Meshy task ${status.toLowerCase()}${reason ? `: ${reason}` : ""}`, {
        details: compactObject({ task_id: taskId, status, task_error: task.task_error }),
      });
    }
    if (status !== "PENDING" && status !== "IN_PROGRESS") {
      throw new GenerationProviderError(`Meshy task returned an unknown status: ${String(task.status)}`, {
        details: { task_id: taskId },
      });
    }
  }
  throw new GenerationTimeoutError("Timed out waiting for Meshy task", { task_id: taskId, path: operation.path });
}

function validateMeshyRequest(input: ResolvedGenerationRequest): void {
  planBody(input);
}

async function generateMeshyTask(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const operation = getOperation(input);
  const body = await resolveBody(planBody(input), input.context.resolveSource);
  const submitted = await requestJson(input, operation.path, { method: "POST", body: JSON.stringify(body) });
  const taskId = asString(submitted.result);
  if (!taskId)
    throw new GenerationProviderError("Meshy submit returned no task id", { body: JSON.stringify(submitted) });
  return pollTask(input, operation, taskId);
}

export const meshyTasksAdapter: GenerationAdapter = Object.assign(generateMeshyTask, {
  validate: validateMeshyRequest,
});
