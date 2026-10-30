import type { GenerationContentBlock } from "./types.js";

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function slugifyFileName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "model"
  );
}

export function getBlockMeta(block: GenerationContentBlock): Record<string, unknown> | undefined {
  return "meta" in block ? block.meta : undefined;
}

export function compactArray<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

/** Provider request fields carried in meta, without the SDK's own block markers. */
export function providerMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...meta };
  delete rest.cohub;
  delete rest.role;
  return rest;
}
