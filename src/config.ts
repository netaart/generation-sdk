import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { GenerationConfigError } from "./errors.js";
import {
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

function isDimensionsSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.separator !== undefined && value.separator !== "x" && value.separator !== "*") return false;
  if (value.min !== undefined && !isPositiveInteger(value.min)) return false;
  if (value.max !== undefined && !isPositiveInteger(value.max)) return false;
  if (value.multipleOf !== undefined && !isPositiveInteger(value.multipleOf)) return false;
  return value.min === undefined || value.max === undefined || value.min <= value.max;
}

function isParameterSpec(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!["string", "number", "integer", "boolean"].includes(String(value.type))) return false;
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

function isSystemOneExample(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.request)) return false;
  return (
    (value.title === undefined || typeof value.title === "string") &&
    (value.request.model === undefined || typeof value.request.model === "string") &&
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

export function isGenerationModelDeclaration(value: unknown): value is GenerationModelDeclaration {
  if (!isRecord(value)) return false;
  const adapter = value.adapter;
  const content = value.content;
  const parameters = value.parameters;
  const meta = value.meta;
  const examples = value.examples;
  const systemOneExamples = value.systemOneExamples;
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
    isRecord(content) &&
    Array.isArray(content.input) &&
    (parameters === undefined || (isRecord(parameters) && Object.values(parameters).every(isParameterSpec))) &&
    (meta === undefined || isMetaSpec(meta)) &&
    (examples === undefined || Array.isArray(examples)) &&
    (systemOneExamples === undefined ||
      (Array.isArray(systemOneExamples) && systemOneExamples.every(isSystemOneExample)))
  );
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
