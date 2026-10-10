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
import { createDebugFetch, joinUrl } from "./http.js";
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
  GenerationClient,
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
    if (fields || headerFields) onFields(fields, headerFields);
    return response;
  }) as typeof fetch;
}

export function createGenerationClient(options: CreateGenerationClientOptions = {}): GenerationClientWithResult {
  const models = resolveModels(options);
  const byModel = new Map(models.map((declaration) => [declaration.model, declaration]));
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (!fetchFn) throw new GenerationConfigError("A fetch implementation is required");
  const debug = resolveDebugConfig(options.debug);
  const adapterFetch = debug ? createDebugFetch(fetchFn, debug) : fetchFn;
  const systemOneConfig = {
    ...options.systemOne,
    baseURL: options.systemOne?.baseURL ?? joinUrl(options.baseUrl ?? DEFAULT_BASE_URL, "typesafe"),
    defaultModel: options.systemOne?.defaultModel ?? "jev-latest",
  };
  let systemOneClient: TypeSafeClient | undefined;

  function requireModel(model: string): GenerationModelDeclaration {
    const declaration = byModel.get(model);
    if (!declaration) throw new GenerationConfigError(`Generation model is unavailable: ${model}`);
    return declaration;
  }

  function validateRequest(request: GenerateRequest): ResolvedGenerationRequest {
    const declaration = requireModel(request.model);
    if (declaration.adapter.type === "typesafe.systemOne") {
      throw new GenerationConfigError(`Model ${request.model} requires systemOne() with state and questions`);
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

  const client: GenerationClientWithResult = {
    systemOne(request, requestOptions) {
      const declaration = requireModel(request.model ?? systemOneConfig.defaultModel);
      if (declaration.adapter.type !== "typesafe.systemOne") {
        throw new GenerationConfigError(`Model does not support systemOne(): ${declaration.model}`);
      }
      if (!systemOneClient) {
        if (!options.apiKey) throw new GenerationConfigError("apiKey is required");
        systemOneClient = new TypeSafeClient({
          ...systemOneConfig,
          apiKey: options.apiKey,
          fetch: adapterFetch,
        });
      }
      return systemOneClient.systemOne(request, requestOptions);
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
): Promise<GenerationClient> {
  const models = await readGenerationModelDeclarationsFromFiles(filePaths);
  return createGenerationClient({ ...options, models, includeBuiltinModels: options.includeBuiltinModels ?? true });
}

export async function createGenerationClientFromDirectory(
  directory: string,
  options: Omit<CreateGenerationClientOptions, "models"> = {},
): Promise<GenerationClient> {
  const models = await readGenerationModelDeclarationsFromDirectory(directory);
  return createGenerationClient({ ...options, models, includeBuiltinModels: options.includeBuiltinModels ?? true });
}

export async function createGenerationClientFromFile(
  filePath: string,
  options: Omit<CreateGenerationClientOptions, "models"> = {},
): Promise<GenerationClient> {
  return createGenerationClientFromFiles([filePath], options);
}
