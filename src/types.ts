import type { SystemOneRequest, TypeSafeClient, TypeSafeClientConfig } from "@typesafe-ai/sdk";

export const MODEL_SCHEMA = "neta.generation.model.v1" as const;

export const GENERATION_MODEL_CATEGORIES = ["image", "video", "audio", "decision"] as const;

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
  | { type: "audio"; source: GenerationSource; meta?: GenerationContentBlockMeta };

export type GenerationResult = {
  content: GenerationContentBlock[];
  requestId?: string;
  cost?: number;
};

export type GenerationContentSpec = {
  type: "text" | "image" | "video" | "audio";
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
      description?: string;
      examples?: number[];
    }
  | {
      type: "integer";
      optional?: boolean;
      default?: number;
      min?: number;
      max?: number;
      description?: string;
      examples?: number[];
    }
  | {
      type: "boolean";
      optional?: boolean;
      default?: boolean;
      description?: string;
      examples?: boolean[];
    };

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

export type CreateGenerationClientOptions = {
  apiKey?: string;
  baseUrl?: string;
  models?: GenerationModelDeclaration[];
  includeBuiltinModels?: boolean;
  fetch?: typeof fetch;
  sourceResolver?: GenerationSourceResolver;
  adapters?: Record<string, GenerationAdapter>;
  debug?: boolean | GenerationDebugOptions;
  /** Official TypeSafe SDK settings. Uses apiKey and fetch from this generation client. */
  systemOne?: Omit<TypeSafeClientConfig, "apiKey" | "fetch">;
};

export type GenerationClient = {
  /** Evaluates state and typed questions with the official TypeSafe SDK. */
  systemOne: TypeSafeClient["systemOne"];
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
  /** Generates content and returns observed request metadata such as requestId and cost when available. */
  generateResult(request: GenerateRequest): Promise<GenerationResult>;
};
