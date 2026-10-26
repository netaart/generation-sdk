export class GenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationError";
  }
}

export class GenerationConfigError extends GenerationError {
  constructor(message: string) {
    super(message);
    this.name = "GenerationConfigError";
  }
}

export class GenerationValidationError extends GenerationError {
  constructor(message: string) {
    super(message);
    this.name = "GenerationValidationError";
  }
}

export class GenerationUnsupportedAdapterError extends GenerationError {
  constructor(adapterType: string) {
    super(`Unsupported generation adapter: ${adapterType}`);
    this.name = "GenerationUnsupportedAdapterError";
  }
}

/** 网关给出的失败类别：审核失败是 `safety`，超时是 `timeout`，其他取值由网关定义。 */
export type GenerationFailureCategory = string;

/** 任务查询成功但任务失败时，网关只在这个响应头里给出失败类别。 */
export const FAILURE_CATEGORY_HEADER = "x-error-category";

export class GenerationProviderError extends GenerationError {
  readonly status: number | undefined;
  readonly body: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  /** 网关给出的失败类别；未传入时从错误响应体的 `new_api.failure_category` 读取。 */
  readonly category: GenerationFailureCategory | undefined;

  constructor(
    message = "Generation provider request failed",
    options?: {
      status?: number;
      body?: string;
      details?: Record<string, unknown>;
      category?: GenerationFailureCategory | undefined;
    },
  ) {
    super(message);
    this.name = "GenerationProviderError";
    this.status = options?.status;
    this.body = options?.body;
    this.details = options?.details;
    this.category = options?.category ?? failureCategoryFromBody(options?.body);
  }
}

/** 请求或任务被内容审核拦截。 */
export function isGenerationSafetyError(
  error: unknown,
): error is GenerationProviderError & { readonly category: "safety" } {
  return error instanceof GenerationProviderError && error.category === "safety";
}

/** 读取网关错误响应体里的 `new_api.failure_category`。 */
export function failureCategoryOf(body: unknown): GenerationFailureCategory | undefined {
  if (!body || typeof body !== "object") return undefined;
  const newApi = (body as { new_api?: unknown }).new_api;
  if (!newApi || typeof newApi !== "object") return undefined;
  const category = (newApi as { failure_category?: unknown }).failure_category;
  return typeof category === "string" && category ? category : undefined;
}

// 错误响应体可能不是 JSON（纯文本、HTML），这时没有失败类别。
function failureCategoryFromBody(body: string | undefined): GenerationFailureCategory | undefined {
  if (!body?.trimStart().startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return failureCategoryOf(parsed);
}

export type GenerationTransportErrorDetails = {
  method: string;
  host?: string;
  path: string;
  elapsedMs: number;
  causeName?: string;
  causeCode?: string;
  causeSyscall?: string;
  causeAddress?: string;
  causePort?: string | number;
};

export class GenerationTransportError extends GenerationProviderError {
  declare readonly details: GenerationTransportErrorDetails;

  constructor(details: GenerationTransportErrorDetails, cause: unknown) {
    super(transportErrorMessage(details), { details });
    this.name = "GenerationTransportError";
    this.cause = cause;
  }

  declare cause: unknown;
}

export class GenerationTimeoutError extends GenerationProviderError {
  constructor(message = "Generation request timed out", details?: Record<string, unknown>) {
    super(message, details ? { details } : undefined);
    this.name = "GenerationTimeoutError";
  }
}

function transportErrorMessage(details: GenerationTransportErrorDetails): string {
  return [
    "Generation transport failed",
    `method=${details.method}`,
    details.host ? `host=${details.host}` : undefined,
    `path=${details.path}`,
    `elapsed_ms=${details.elapsedMs}`,
    details.causeCode ? `cause_code=${details.causeCode}` : undefined,
    details.causeName ? `cause_name=${details.causeName}` : undefined,
    details.causeSyscall ? `cause_syscall=${details.causeSyscall}` : undefined,
    details.causeAddress ? `cause_address=${details.causeAddress}` : undefined,
    details.causePort !== undefined ? `cause_port=${details.causePort}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
}
