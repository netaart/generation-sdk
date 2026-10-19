import { HTTPClient, OpenRouter } from "@openrouter/sdk";
import type { RequestOptions as OpenRouterRequestOptions } from "@openrouter/sdk/lib/sdks.js";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { getGenerationAdapter, tryGetGenerationAdapter } from "./adapters/index.js";
import { builtinGenerationModels } from "./builtins.js";
import {
  readGenerationModelDeclarationsFromDirectory,
  readGenerationModelDeclarationsFromFiles,
  stringifyGenerationModelDeclaration,
  writeGenerationModelDeclaration,
  writeGenerationModelDeclarations,
} from "./config.js";
import { GenerationConfigError } from "./errors.js";
import { createDebugFetch, createRouterMetadataFetch, joinUrl, validateRouterMetadata } from "./http.js";
import {
  extractGenerationResultFields,
  extractGenerationResultHeaderFields,
  type GenerationResultFields,
  type GenerationResultHeaderFields,
} from "./response-fields.js";
import { defaultGenerationSourceResolver } from "./source.js";
import type {
  CreateGenerationClientOptions,
  GenerateRequest,
  GenerationClientWithResult,
  GenerationDebugConfig,
  GenerationModelDeclaration,
  GenerationResult,
  ResolvedGenerationRequest,
} from "./types.js";
import { cloneJson } from "./utils.js";
import {
  mergeGenerationMeta,
  resolveGenerationMeta,
  resolveGenerationOperation,
  resolveGenerationParameters,
  validateGenerationContent,
} from "./validation.js";

const DEFAULT_BASE_URL = "https://router.neta.art";
const REDACTED = "[REDACTED]";
const SECRET_DEBUG_KEY_PATTERN = /^(authorization|api[-_]?key|token|thoughtSignature)$/i;
const BASE64_DEBUG_KEY_PATTERN = /^(b64_json|data)$/i;
const MEDIA_PAYLOAD_KEYS = new Set([
  "audio",
  "audio_url",
  "image",
  "image_tail",
  "image_url",
  "first_frame",
  "mask",
  "result_url",
  "static_mask",
  "url",
  "video",
  "video_url",
  "watermark_url",
]);

function isUrlLike(value: string): boolean {
  return /^(https?:|s3:|gs:|file:|blob:)\/\//i.test(value.trim());
}

function isBase64Like(value: string): boolean {
  const compact = value.trim().replace(/\s/g, "");
  if (compact.length < 256 || compact.length % 4 === 1) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact);
}

function shouldRedactString(key: string | undefined, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^data:/i.test(trimmed)) return true;
  if (isBase64Like(trimmed)) return true;
  return !!key && MEDIA_PAYLOAD_KEYS.has(key.toLowerCase()) && !isUrlLike(trimmed);
}

function redactDebugEvent<T>(value: T, options: { redactSecrets: boolean }, key?: string): T {
  if (typeof value === "string") return (shouldRedactString(key, value) ? REDACTED : value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDebugEvent(item, options, key)) as T;
  if (!value || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (BASE64_DEBUG_KEY_PATTERN.test(childKey) || (options.redactSecrets && SECRET_DEBUG_KEY_PATTERN.test(childKey))) {
      output[childKey] = REDACTED;
    } else {
      output[childKey] = redactDebugEvent(child, options, childKey);
    }
  }
  return output as T;
}

function defaultDebugLogger(event: unknown): void {
  console.error(JSON.stringify(event, null, 2));
}

function resolveDebugConfig(debug: CreateGenerationClientOptions["debug"]): GenerationDebugConfig | undefined {
  if (!debug) return undefined;
  if (debug === true) {
    return {
      enabled: true,
      includeSensitive: false,
      includeResponseBody: true,
      logger: (event) => defaultDebugLogger(redactDebugEvent(event, { redactSecrets: true })),
    };
  }
  if (!debug.enabled) return undefined;
  const includeSensitive = debug.includeSensitive ?? false;
  const logger = debug.logger ?? defaultDebugLogger;
  return {
    enabled: true,
    includeSensitive,
    includeResponseBody: debug.includeResponseBody ?? true,
    logger: (event) => logger(redactDebugEvent(event, { redactSecrets: !includeSensitive })),
  };
}

function resolveModels(options: CreateGenerationClientOptions): GenerationModelDeclaration[] {
  const includeBuiltinModels = options.includeBuiltinModels ?? !options.models;
  const models = [...(includeBuiltinModels ? builtinGenerationModels : []), ...(options.models ?? [])];
  const byModel = new Map<string, GenerationModelDeclaration>();
  for (const model of models) byModel.set(model.model, cloneJson(model));
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

function createResultFieldCaptureFetch(
  fetchFn: typeof fetch,
  onFields: (
    fields: GenerationResultFields | undefined,
    headerFields: GenerationResultHeaderFields | undefined,
  ) => void,
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchFn(input, init);
    const headerFields = extractGenerationResultHeaderFields(response.headers);
    const contentType = response.headers.get("content-type") ?? "";
    let fields: GenerationResultFields | undefined;
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      try {
        fields = extractGenerationResultFields(await response.clone().json());
      } catch {
        // No JSON body, no result fields.
      }
    }
    onFields(fields, headerFields);
    return response;
  }) as typeof fetch;
}

type DecisionEntryPoint = "systemOne()" | "decisions()";

// 决策模型只通过各自官方 SDK 的入口调用。
const DECISION_ENTRY_POINTS = new Map<string, DecisionEntryPoint>([
  ["typesafe.systemOne", "systemOne()"],
  ["openrouter.decisions", "decisions()"],
]);

// 每次调用单独捕获最终响应中的费用和请求标识。
function createDecisionMetadataCapture(fetchFn: typeof fetch) {
  let captured: GenerationResultFields = {};
  const fetch = createResultFieldCaptureFetch(fetchFn, (fields, headerFields) => {
    const requestId = fields?.requestId ?? headerFields?.requestId ?? headerFields?.oneApiRequestId;
    captured = { ...fields, ...(requestId ? { requestId } : {}) };
  });
  return { fetch, fields: () => captured };
}

export function createGenerationClient(options: CreateGenerationClientOptions = {}): GenerationClientWithResult {
  const models = resolveModels(options);
  const byModel = new Map(models.map((declaration) => [declaration.model, declaration]));
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new GenerationConfigError("A fetch implementation is required");
  const debug = resolveDebugConfig(options.debug);
  const routerFetch = options.router
    ? createRouterMetadataFetch(fetchFn, validateRouterMetadata(options.router))
    : fetchFn;
  const adapterFetch = debug ? createDebugFetch(routerFetch, debug) : routerFetch;
  const systemOneConfig = {
    ...options.systemOne,
    baseURL: options.systemOne?.baseURL ?? joinUrl(options.baseUrl ?? DEFAULT_BASE_URL, "typesafe"),
    defaultModel: options.systemOne?.defaultModel ?? "jev-latest",
  };
  let systemOneClient: TypeSafeClient | undefined;
  // 官方 Decisions 接口只读取单次调用的 serverURL，客户端级 serverURL 对它无效；空字符串与官方一致视为未设置。
  const { serverURL: configuredServerURL, ...decisionsConfig } = options.decisions ?? {};
  const decisionsServerURL = configuredServerURL || joinUrl(options.baseUrl ?? DEFAULT_BASE_URL, "openrouter");
  let decisionsClient: OpenRouter | undefined;

  // 单次调用未给出 serverURL 时始终使用网关地址，避免官方函数退回 openrouter.ai。
  function decisionsCallOptions(requestOptions: OpenRouterRequestOptions | undefined): OpenRouterRequestOptions {
    return { ...requestOptions, serverURL: requestOptions?.serverURL || decisionsServerURL };
  }

  function requireModel(model: string): GenerationModelDeclaration {
    const declaration = byModel.get(model);
    if (!declaration) throw new GenerationConfigError(`Generation model is unavailable: ${model}`);
    return declaration;
  }

  function validateRequest(request: GenerateRequest): ResolvedGenerationRequest {
    const declaration = resolveGenerationOperation(requireModel(request.model), request.parameters);
    const entryPoint = DECISION_ENTRY_POINTS.get(declaration.adapter.type);
    if (entryPoint) {
      throw new GenerationConfigError(`Model ${request.model} requires ${entryPoint} with state and questions`);
    }
    validateGenerationContent(declaration, request.content);
    const parameters = resolveGenerationParameters(declaration, request.parameters);
    const meta = resolveGenerationMeta(
      declaration,
      mergeGenerationMeta({ ...(request.metadata ?? {}), ...(request.meta ?? {}) }, request.content),
      request.content,
    );
    const resolved = { declaration: cloneJson(declaration), request, parameters, meta };
    tryGetGenerationAdapter(declaration.adapter.type, options.adapters)?.validate?.(resolved);
    return { ...resolved, request: cloneJson(request) };
  }

  async function runAdapter(request: GenerateRequest, fetch: typeof globalThis.fetch) {
    const resolved = validateRequest(request);
    const apiKey = request.apiKey ?? options.apiKey;
    if (!apiKey) throw new GenerationConfigError("apiKey is required");
    const adapter = getGenerationAdapter(resolved.declaration.adapter.type, options.adapters);
    return adapter({
      ...resolved,
      context: {
        apiKey,
        baseUrl: request.baseUrl ?? options.baseUrl ?? DEFAULT_BASE_URL,
        fetch,
        resolveSource: options.sourceResolver ?? defaultGenerationSourceResolver,
      },
    });
  }

  function requireDecisionModel(model: string, entryPoint: DecisionEntryPoint): void {
    const declaration = requireModel(model);
    if (DECISION_ENTRY_POINTS.get(declaration.adapter.type) !== entryPoint) {
      throw new GenerationConfigError(`Model does not support ${entryPoint}: ${declaration.model}`);
    }
  }

  function createSystemOneClient(fetch: typeof globalThis.fetch): TypeSafeClient {
    if (!options.apiKey) throw new GenerationConfigError("apiKey is required");
    return new TypeSafeClient({ ...systemOneConfig, apiKey: options.apiKey, fetch });
  }

  function createDecisionsClient(fetch: typeof globalThis.fetch): OpenRouter {
    if (!options.apiKey) throw new GenerationConfigError("apiKey is required");
    // 网关在失败时可能已经扣费，默认不重试。
    return new OpenRouter({
      ...decisionsConfig,
      retryConfig: decisionsConfig.retryConfig ?? { strategy: "none" },
      apiKey: options.apiKey,
      httpClient: new HTTPClient({ fetcher: fetch }),
    });
  }

  const client: GenerationClientWithResult = {
    systemOne(request, requestOptions) {
      requireDecisionModel(request.model ?? systemOneConfig.defaultModel, "systemOne()");
      systemOneClient ??= createSystemOneClient(adapterFetch);
      return systemOneClient.systemOne(request, requestOptions);
    },

    async systemOneResult(request, requestOptions) {
      requireDecisionModel(request.model ?? systemOneConfig.defaultModel, "systemOne()");
      const capture = createDecisionMetadataCapture(adapterFetch);
      const result = await createSystemOneClient(capture.fetch).systemOne(request, requestOptions);
      return { result, ...capture.fields() };
    },

    async decisions(request, requestOptions) {
      requireDecisionModel(request.decisionsRequest.model, "decisions()");
      decisionsClient ??= createDecisionsClient(adapterFetch);
      return decisionsClient.alpha.decisions.create(request, decisionsCallOptions(requestOptions));
    },

    async decisionsResult(request, requestOptions) {
      requireDecisionModel(request.decisionsRequest.model, "decisions()");
      const capture = createDecisionMetadataCapture(adapterFetch);
      const result = await createDecisionsClient(capture.fetch).alpha.decisions.create(
        request,
        decisionsCallOptions(requestOptions),
      );
      return { result, ...capture.fields() };
    },

    validate(request: GenerateRequest) {
      return validateRequest(request);
    },

    async generate(request: GenerateRequest) {
      return runAdapter(request, adapterFetch);
    },

    async generateResult(request: GenerateRequest): Promise<GenerationResult> {
      let capturedFields: GenerationResultFields | undefined;
      let capturedBodyRequestId: string | undefined;
      let capturedRequestId: string | undefined;
      let capturedOneApiRequestId: string | undefined;
      const captureFetch = createResultFieldCaptureFetch(adapterFetch, (fields, headerFields) => {
        if (fields) capturedFields = { ...capturedFields, ...fields };
        if (fields?.requestId) capturedBodyRequestId = fields.requestId;
        if (headerFields?.requestId) capturedRequestId = headerFields.requestId;
        if (headerFields?.oneApiRequestId) capturedOneApiRequestId = headerFields.oneApiRequestId;
        const requestId = capturedBodyRequestId ?? capturedRequestId ?? capturedOneApiRequestId;
        if (requestId) capturedFields = { ...capturedFields, requestId };
      });
      const content = await runAdapter(request, captureFetch);
      return { content, ...(capturedFields ?? {}) };
    },

    listModels() {
      return cloneJson(models);
    },

    getModel(model: string) {
      const declaration = byModel.get(model);
      return declaration ? cloneJson(declaration) : null;
    },

    stringifyModelConfig(model: string, stringifyOptions = {}) {
      return stringifyGenerationModelDeclaration(requireModel(model), stringifyOptions);
    },

    exportModelConfig(model: string, filePath: string) {
      return writeGenerationModelDeclaration(requireModel(model), filePath);
    },

    exportModelConfigs(directory: string) {
      return writeGenerationModelDeclarations(models, directory);
    },
  };

  return client;
}

export async function createGenerationClientFromFiles(
  filePaths: string[],
  options: Omit<CreateGenerationClientOptions, "models"> = {},
): Promise<GenerationClientWithResult> {
  const models = await readGenerationModelDeclarationsFromFiles(filePaths);
  return createGenerationClient({ ...options, models, includeBuiltinModels: options.includeBuiltinModels ?? true });
}

export async function createGenerationClientFromDirectory(
  directory: string,
  options: Omit<CreateGenerationClientOptions, "models"> = {},
): Promise<GenerationClientWithResult> {
  const models = await readGenerationModelDeclarationsFromDirectory(directory);
  return createGenerationClient({ ...options, models, includeBuiltinModels: options.includeBuiltinModels ?? true });
}

export async function createGenerationClientFromFile(
  filePath: string,
  options: Omit<CreateGenerationClientOptions, "models"> = {},
): Promise<GenerationClientWithResult> {
  return createGenerationClientFromFiles([filePath], options);
}
