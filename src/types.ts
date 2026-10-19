import type { OpenRouter, SDKOptions } from "@openrouter/sdk";
import type { RequestOptions as OpenRouterRequestOptions } from "@openrouter/sdk/lib/sdks.js";
import type { DecisionsRequest, DecisionsResponse } from "@openrouter/sdk/models";
import type { CreateApiAlphaDecisionsRequest } from "@openrouter/sdk/models/operations";
import type {
  Questions,
  RequestOptions,
  SystemOneRequest,
  SystemOneResult,
  TypeSafeClient,
  TypeSafeClientConfig,
} from "@typesafe-ai/sdk";

export const MODEL_SCHEMA = "neta.generation.model.v1" as const;

export const GENERATION_MODEL_CATEGORIES = ["image", "video", "audio", "3d", "decision"] as const;

export type GenerationModelCategory = (typeof GENERATION_MODEL_CATEGORIES)[number];

export const GENERATION_PRICING_UNITS = ["image", "second", "request", "1m_tokens"] as const;

export type GenerationPricingUnit = (typeof GENERATION_PRICING_UNITS)[number];

/**
 * Display-only unit price for a model catalog. `unit` names what one charge
 * covers; `amount` is the exact unit price, or a `min`/`max` pair when the
 * price depends on request parameters (resolution, duration, quality).
 */
export type GenerationModelPricing = {
  unit: GenerationPricingUnit;
  /** Short qualifier shown with the price, e.g. "std-pro". */
  note?: string;
} & ({ amount: number; min?: never; max?: never } | { amount?: never; min: number; max: number });

export type GenerationSource = { type: "url"; url: string } | { type: "base64"; mediaType: string; data: string };

export type GenerationContentBlockMeta = Record<string, unknown>;

export type GenerationContentBlock =
  | { type: "text"; text: string; meta?: GenerationContentBlockMeta }
  | { type: "image"; source: GenerationSource; meta?: GenerationContentBlockMeta }
  | { type: "video"; source: GenerationSource; meta?: GenerationContentBlockMeta }
  | { type: "audio"; source: GenerationSource; meta?: GenerationContentBlockMeta }
  /** A 3D asset file such as a GLB, FBX, OBJ, USDZ, or STL model, or an FBX/BVH motion clip. */
  | { type: "3d"; source: GenerationSource; meta?: GenerationContentBlockMeta };

export type GenerationResult = {
  content: GenerationContentBlock[];
  requestId?: string;
  cost?: number;
};

export type SystemOneResultWithMetadata<Q extends Questions = Questions> = {
  result: SystemOneResult<Q>;
  requestId?: string;
  cost?: number;
};

export type DecisionsResultWithMetadata = {
  result: DecisionsResponse;
  requestId?: string;
  cost?: number;
};

export type GenerationContentSpec = {
  type: GenerationContentBlock["type"];
  required?: boolean;
  min?: number;
  max?: number;
  sources?: Array<GenerationSource["type"]>;
  roles?: string[];
  roleRequired?: boolean;
  merge?: "newline" | "space" | "concat";
  meta?: Record<string, unknown>;
  description?: string;
};

export type GenerationDimensionsSpec = {
  separator?: "x" | "*";
  min?: number;
  max?: number;
  multipleOf?: number;
};

export type GenerationParameterSpec =
  | {
      type: "string";
      optional?: boolean;
      default?: string;
      enum?: string[];
      dimensions?: GenerationDimensionsSpec;
      description?: string;
      examples?: string[];
    }
  | {
      type: "number";
      optional?: boolean;
      default?: number;
      min?: number;
      max?: number;
      /** Values must be whole multiples of this step, for example 0.5. */
      multipleOf?: number;
      description?: string;
      examples?: number[];
    }
  | {
      type: "integer";
      optional?: boolean;
      default?: number;
      min?: number;
      max?: number;
      multipleOf?: number;
      description?: string;
      examples?: number[];
    }
  | {
      type: "boolean";
      optional?: boolean;
      default?: boolean;
      description?: string;
      examples?: boolean[];
    }
  | {
      type: "array";
      optional?: boolean;
      default?: Array<string | number>;
      items: GenerationArrayItemSpec;
      /** Minimum item count. */
      min?: number;
      /** Maximum item count. */
      max?: number;
      /** Items must not repeat. */
      unique?: boolean;
      description?: string;
      examples?: Array<Array<string | number>>;
    };

export type GenerationArrayItemSpec =
  | { type: "string"; enum?: string[] }
  | { type: "integer"; min?: number; max?: number };

export type GenerationMetaFieldSpec =
  | GenerationParameterSpec
  | { type: "object"; optional?: boolean; description?: string };

export type GenerationMetaTaskVariantSpec = {
  description?: string;
  required?: string[];
  requiredContent?: Array<GenerationContentSpec["type"]>;
  sendTask?: boolean;
};

export type GenerationMetaSpec = {
  fields?: Record<string, GenerationMetaFieldSpec>;
  taskField?: string;
  taskVariants?: Record<string, GenerationMetaTaskVariantSpec>;
};

/** One function of a model: the content inputs and parameters it adds to the model's own. */
export type GenerationOperationSpec = {
  title?: string;
  description?: string;
  content?: {
    input: GenerationContentSpec[];
  };
  parameters?: Record<string, GenerationParameterSpec>;
};

export type GenerationModelDeclaration = {
  schema: typeof MODEL_SCHEMA;
  model: string;
  title?: string;
  /** Product catalog class. */
  category?: GenerationModelCategory;
  /** Display-only unit price in USD, maintained per deployment. */
  pricing?: GenerationModelPricing;
  description?: string;
  /** Hide from default discovery while keeping exact-ID lookup and runtime use available. */
  hidden?: boolean;
  allowUnknownParameters?: boolean;
  adapter: {
    type: string;
  } & Record<string, unknown>;
  content: {
    input: GenerationContentSpec[];
  };
  parameters?: Record<string, GenerationParameterSpec>;
  /**
   * Functions of the model, selected by the string parameter `operation`, whose `enum` lists these keys. A request uses
   * the model's content inputs and parameters plus those of the selected operation.
   */
  operations?: Record<string, GenerationOperationSpec>;
  meta?: GenerationMetaSpec;
  examples?: Array<{
    title?: string;
    request: GenerateRequest;
  }>;
  /** Examples passed directly to systemOne(), using the official TypeSafe request type. */
  systemOneExamples?: Array<{
    title?: string;
    request: SystemOneRequest;
  }>;
  /** Examples passed as decisionsRequest to decisions(), using the official OpenRouter request type. */
  decisionsExamples?: Array<{
    title?: string;
    request: DecisionsRequest;
  }>;
};

export type GenerateRequest = {
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  /** @deprecated Use meta. */
  metadata?: Record<string, unknown>;
  apiKey?: string;
  baseUrl?: string;
};

export type ResolvedGenerationRequest = {
  declaration: GenerationModelDeclaration;
  request: GenerateRequest;
  parameters: Record<string, unknown>;
  meta: Record<string, unknown>;
};

export type GenerationSourceResolver = (source: GenerationSource) => Promise<string> | string;

export type GenerationDebugEvent =
  | {
      type: "request";
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: unknown;
    }
  | {
      type: "response";
      url: string;
      status: number;
      statusText: string;
      headers: Record<string, string>;
      trace: Record<string, string>;
      elapsedMs: number;
      body?: unknown;
    };

export type GenerationDebugLogger = (event: GenerationDebugEvent) => void;

export type GenerationDebugOptions = {
  enabled?: boolean;
  includeSensitive?: boolean;
  includeResponseBody?: boolean;
  logger?: GenerationDebugLogger;
};

export type GenerationDebugConfig = GenerationDebugOptions & {
  enabled: boolean;
  includeSensitive: boolean;
  includeResponseBody: boolean;
  logger: GenerationDebugLogger;
};

export type GenerationAdapterContext = {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
  resolveSource: GenerationSourceResolver;
};

export type GenerationAdapterInput = ResolvedGenerationRequest & {
  context: GenerationAdapterContext;
};

export type GenerationAdapter = ((input: GenerationAdapterInput) => Promise<GenerationContentBlock[]>) & {
  validate?: (input: ResolvedGenerationRequest) => void;
};

export type GenerationRouterMetadata = {
  /** Caller identity consumed by neta-router for analytics. */
  userUuid?: string;
  /** Caller platform written to archived media as x-oss-meta-platform. */
  platform?: string;
  /** Caller task id written to archived media as x-oss-meta-caller-task-id; requires platform. */
  callerTaskId?: string;
  /** Caller retry attempt count consumed by neta-router for analytics. */
  retry?: number;
};

export type CreateGenerationClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  models?: GenerationModelDeclaration[];
  includeBuiltinModels?: boolean;
  fetch?: typeof fetch;
  /** Internal neta-router metadata sent as X-Neta-* headers on every request, including task polling. */
  router?: GenerationRouterMetadata;
  sourceResolver?: GenerationSourceResolver;
  adapters?: Record<string, GenerationAdapter>;
  debug?: boolean | GenerationDebugOptions;
  /** Official TypeSafe SDK settings. Uses apiKey and fetch from this generation client. */
  systemOne?: Omit<TypeSafeClientConfig, "apiKey" | "fetch">;
  /** Official OpenRouter SDK settings for decisions(). Uses apiKey and fetch from this generation client; serverURL is the Decisions API root and defaults to `${baseUrl}/openrouter`. */
  decisions?: Omit<SDKOptions, "apiKey" | "httpClient" | "server">;
};

export type GenerationClient = {
  /** Evaluates state and typed questions with the official TypeSafe SDK. */
  systemOne: TypeSafeClient["systemOne"];
  /** Evaluates state and questions with the official OpenRouter SDK's Decisions API. */
  decisions: OpenRouter["alpha"]["decisions"]["create"];
  /** Validates the request and sends it to the model adapter. */
  generate(request: GenerateRequest): Promise<GenerationContentBlock[]>;
  /** Resolves model defaults and all available validation rules without requiring an API key or making a network request. */
  validate(request: GenerateRequest): ResolvedGenerationRequest;
  /** Returns cloned, machine-readable declarations for every available model. */
  listModels(): GenerationModelDeclaration[];
  /** Returns a cloned model declaration, including content constraints and request examples, or null when unavailable. */
  getModel(model: string): GenerationModelDeclaration | null;
  /** Serializes one available model declaration for agents and external tools. */
  stringifyModelConfig(model: string, options?: { format?: "yaml" | "json" }): string;
  /** Writes one available model declaration to a YAML file. */
  exportModelConfig(model: string, filePath: string): Promise<void>;
  /** Writes every available model declaration to a directory as YAML files. */
  exportModelConfigs(directory: string): Promise<void>;
};

export type GenerationClientWithResult = GenerationClient & {
  /** 返回官方答案及响应中提供的费用和请求标识。 */
  systemOneResult<const Q extends Questions>(
    request: SystemOneRequest<Q>,
    options?: RequestOptions,
  ): Promise<SystemOneResultWithMetadata<Q>>;
  /** 返回官方 Decisions 答案及响应中提供的费用和请求标识。 */
  decisionsResult(
    request: CreateApiAlphaDecisionsRequest,
    options?: OpenRouterRequestOptions,
  ): Promise<DecisionsResultWithMetadata>;
  /** Generates content and returns observed request metadata such as requestId and cost when available. */
  generateResult(request: GenerateRequest): Promise<GenerationResult>;
};
