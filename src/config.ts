import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { GenerationConfigError } from "./errors.js";
import {
  GENERATION_CONTENT_TYPES,
  GENERATION_MODEL_CATEGORIES,
  GENERATION_PRICING_UNITS,
  type GenerationModelCategory,
  type GenerationModelDeclaration,
  type GenerationModelPricing,
  MODEL_SCHEMA,
} from "./types.js";
import { cloneJson, slugifyFileName } from "./utils.js";

const DECLARATION_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isDimensionsSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.separator !== undefined && value.separator !== "x" && value.separator !== "*") return false;
  if (value.min !== undefined && !isPositiveInteger(value.min)) return false;
  if (value.max !== undefined && !isPositiveInteger(value.max)) return false;
  if (value.multipleOf !== undefined && !isPositiveInteger(value.multipleOf)) return false;
  return value.min === undefined || value.max === undefined || value.min <= value.max;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { min, max, ...rest } = value;
  return (
    Object.keys(rest).length === 0 &&
    (min !== undefined || max !== undefined) &&
    (min === undefined || isFiniteNumber(min)) &&
    (max === undefined || isFiniteNumber(max)) &&
    (min === undefined || max === undefined || min <= max)
  );
}

// 每种内容类型只能声明能从这种文件里读到的限制
const MEDIA_FIELDS: Record<string, readonly string[]> = {
  image: ["formats", "maxBytes", "width", "height", "aspectRatio", "pixels"],
  video: ["formats", "maxBytes", "width", "height", "aspectRatio", "pixels", "fps", "duration", "totalDuration"],
  audio: ["formats", "maxBytes", "duration", "totalDuration"],
};

function isMediaSpec(type: unknown, value: unknown): boolean {
  const fields = typeof type === "string" ? MEDIA_FIELDS[type] : undefined;
  if (!fields || !isRecord(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([key, item]) => {
    if (!fields.includes(key)) return false;
    if (key === "formats") {
      return Array.isArray(item) && item.length > 0 && item.every((format) => typeof format === "string" && format);
    }
    if (key === "maxBytes") return isPositiveInteger(item);
    return isRange(item);
  });
}

function isContentInputSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { requires, media } = value;
  return (
    (requires === undefined ||
      (Array.isArray(requires) &&
        requires.length > 0 &&
        requires.every((type) => (GENERATION_CONTENT_TYPES as readonly unknown[]).includes(type)))) &&
    (media === undefined || isMediaSpec(value.type, media))
  );
}

function isContentInputs(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.input) && value.input.every(isContentInputSpec);
}

// values 只用于数值参数，列出 min/max 范围之外另外允许的取值
function isParameterValues(type: unknown, values: unknown): boolean {
  if (values === undefined) return true;
  if (type !== "number" && type !== "integer") return false;
  return (
    Array.isArray(values) &&
    values.length > 0 &&
    values.every((item) => isFiniteNumber(item) && (type === "number" || Number.isInteger(item)))
  );
}

function isArrayItemSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "string") {
    return (
      value.enum === undefined || (Array.isArray(value.enum) && value.enum.every((item) => typeof item === "string"))
    );
  }
  return value.type === "integer";
}

function isParameterSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isParameterValues(value.type, value.values)) return false;
  if (value.type === "object") return true;
  if (value.type === "array") {
    return (
      isArrayItemSpec(value.items) &&
      (value.min === undefined || isNonNegativeInteger(value.min)) &&
      (value.max === undefined || isNonNegativeInteger(value.max)) &&
      (value.min === undefined || value.max === undefined || value.min <= value.max) &&
      (value.unique === undefined || typeof value.unique === "boolean")
    );
  }
  if (!["string", "number", "integer", "boolean"].includes(String(value.type))) return false;
  if (value.multipleOf !== undefined && !isPositiveNumber(value.multipleOf)) return false;
  return value.type !== "string" || value.dimensions === undefined || isDimensionsSpec(value.dimensions);
}

function isMetaFieldSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isParameterSpec(value) || String(value.type) === "object";
}

function isMetaTaskVariantSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.description === undefined || typeof value.description === "string") &&
    (value.required === undefined ||
      (Array.isArray(value.required) && value.required.every((item) => typeof item === "string"))) &&
    (value.requiredContent === undefined ||
      (Array.isArray(value.requiredContent) && value.requiredContent.every((item) => typeof item === "string"))) &&
    (value.sendTask === undefined || typeof value.sendTask === "boolean")
  );
}

function isDecisionExample(value: unknown, modelRequired: boolean): boolean {
  if (!isRecord(value) || !isRecord(value.request)) return false;
  const model = value.request.model;
  return (
    (value.title === undefined || typeof value.title === "string") &&
    (typeof model === "string" || (!modelRequired && model === undefined)) &&
    "state" in value.request &&
    isRecord(value.request.questions)
  );
}

function isGenerationModelCategory(value: unknown): value is GenerationModelCategory {
  return typeof value === "string" && (GENERATION_MODEL_CATEGORIES as readonly string[]).includes(value);
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isGenerationModelPricing(value: unknown): value is GenerationModelPricing {
  if (!isRecord(value)) return false;
  if (typeof value.unit !== "string" || !(GENERATION_PRICING_UNITS as readonly string[]).includes(value.unit))
    return false;
  if (value.note !== undefined && typeof value.note !== "string") return false;

  if (value.amount !== undefined) {
    if (value.min !== undefined || value.max !== undefined) return false;
    return isFiniteNonNegative(value.amount);
  }
  return isFiniteNonNegative(value.min) && isFiniteNonNegative(value.max) && value.min <= value.max;
}

function isMetaSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.fields === undefined ||
      (isRecord(value.fields) && Object.values(value.fields).every((field) => isMetaFieldSpec(field)))) &&
    (value.taskField === undefined || typeof value.taskField === "string") &&
    (value.taskVariants === undefined ||
      (isRecord(value.taskVariants) &&
        Object.values(value.taskVariants).every((variant) => isMetaTaskVariantSpec(variant))))
  );
}

function isParameters(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(isParameterSpec);
}

function isOperationSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.title === undefined || typeof value.title === "string") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.content === undefined || isContentInputs(value.content)) &&
    (value.parameters === undefined || isParameters(value.parameters))
  );
}

function contentTypes(content: { input: unknown[] } | undefined): unknown[] {
  return (content?.input ?? []).map((input) => (isRecord(input) ? input.type : undefined));
}

// 参数 operation 的 enum 按顺序列出全部功能，并且请求总是会选中一个功能；功能的参数和内容类型不能与模型自己的重复。
function hasSelectableOperations({ operations, parameters = {}, content }: GenerationModelDeclaration): boolean {
  if (!operations) return true;
  const names = Object.keys(operations);
  const selector = parameters.operation;
  const modelTypes = new Set(contentTypes(content));
  return (
    names.length > 0 &&
    selector?.type === "string" &&
    (selector.optional !== true || selector.default !== undefined) &&
    Array.isArray(selector.enum) &&
    selector.enum.length === names.length &&
    names.every((name, index) => selector.enum?.[index] === name) &&
    Object.values(operations).every(
      (operation) =>
        Object.keys(operation.parameters ?? {}).every((key) => !Object.hasOwn(parameters, key)) &&
        contentTypes(operation.content).every((type) => !modelTypes.has(type)),
    )
  );
}

function hasDeclarationFields(value: unknown): value is GenerationModelDeclaration {
  if (!isRecord(value)) return false;
  const adapter = value.adapter;
  const content = value.content;
  const parameters = value.parameters;
  const operations = value.operations;
  const meta = value.meta;
  const examples = value.examples;
  const systemOneExamples = value.systemOneExamples;
  const decisionsExamples = value.decisionsExamples;
  return (
    value.schema === MODEL_SCHEMA &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    (value.category === undefined || isGenerationModelCategory(value.category)) &&
    (value.pricing === undefined || isGenerationModelPricing(value.pricing)) &&
    (value.hidden === undefined || typeof value.hidden === "boolean") &&
    (value.allowUnknownParameters === undefined || typeof value.allowUnknownParameters === "boolean") &&
    isRecord(adapter) &&
    typeof adapter.type === "string" &&
    isContentInputs(content) &&
    (parameters === undefined || isParameters(parameters)) &&
    (operations === undefined || (isRecord(operations) && Object.values(operations).every(isOperationSpec))) &&
    (meta === undefined || isMetaSpec(meta)) &&
    (examples === undefined || Array.isArray(examples)) &&
    (systemOneExamples === undefined ||
      (Array.isArray(systemOneExamples) && systemOneExamples.every((example) => isDecisionExample(example, false)))) &&
    (decisionsExamples === undefined ||
      (Array.isArray(decisionsExamples) && decisionsExamples.every((example) => isDecisionExample(example, true))))
  );
}

export function isGenerationModelDeclaration(value: unknown): value is GenerationModelDeclaration {
  return hasDeclarationFields(value) && hasSelectableOperations(value);
}

export function parseGenerationModelDeclaration(rawText: string, filePath = "model.yaml"): GenerationModelDeclaration {
  const parsed = extname(filePath) === ".json" ? JSON.parse(rawText) : parseYaml(rawText);
  if (!isGenerationModelDeclaration(parsed)) throw new GenerationConfigError(`Invalid model declaration: ${filePath}`);
  return parsed;
}

export function stringifyGenerationModelDeclaration(
  declaration: GenerationModelDeclaration,
  options: { format?: "yaml" | "json" } = {},
): string {
  const value = cloneJson(declaration);
  if (options.format === "json") return `${JSON.stringify(value, null, 2)}\n`;
  return stringifyYaml(value, { lineWidth: 120 });
}

export async function readGenerationModelDeclaration(filePath: string): Promise<GenerationModelDeclaration> {
  return parseGenerationModelDeclaration(await readFile(filePath, "utf-8"), filePath);
}

export async function readGenerationModelDeclarationsFromFiles(
  filePaths: string[],
): Promise<GenerationModelDeclaration[]> {
  const declarations = await Promise.all(filePaths.map((filePath) => readGenerationModelDeclaration(filePath)));
  return mergeGenerationModelDeclarations(declarations);
}

export async function readGenerationModelDeclarationsFromDirectory(
  directory: string,
): Promise<GenerationModelDeclaration[]> {
  const entries = await readdir(directory);
  const files = entries
    .filter((entry) => DECLARATION_EXTENSIONS.has(extname(entry)))
    .sort()
    .map((entry) => join(directory, entry));
  return readGenerationModelDeclarationsFromFiles(files);
}

export function mergeGenerationModelDeclarations(
  declarations: GenerationModelDeclaration[],
): GenerationModelDeclaration[] {
  const byModel = new Map<string, GenerationModelDeclaration>();
  for (const declaration of declarations) byModel.set(declaration.model, declaration);
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

export async function writeGenerationModelDeclaration(
  declaration: GenerationModelDeclaration,
  filePath: string,
  options: { format?: "yaml" | "json" } = {},
): Promise<void> {
  await writeFile(filePath, stringifyGenerationModelDeclaration(declaration, options));
}

export async function writeGenerationModelDeclarations(
  declarations: GenerationModelDeclaration[],
  directory: string,
  options: { format?: "yaml" | "json" } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const ext = options.format === "json" ? "json" : "yaml";
  await Promise.all(
    declarations.map((declaration) =>
      writeGenerationModelDeclaration(
        declaration,
        join(directory, `${slugifyFileName(declaration.model)}.${ext}`),
        options,
      ),
    ),
  );
}
