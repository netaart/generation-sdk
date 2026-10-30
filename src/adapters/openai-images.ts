import { GenerationProviderError, GenerationValidationError } from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import type { GenerationAdapterInput, GenerationContentBlock } from "../types.js";
import { compactArray, compactObject, providerMeta } from "../utils.js";
import { mergeTextBlocks } from "../validation.js";

const REQUEST_TIMEOUT_MS = 300_000;

type OpenAiImagesResponse = {
  data?: Array<{
    url?: unknown;
    b64_json?: unknown;
    revised_prompt?: unknown;
  }>;
  created?: unknown;
  usage?: unknown;
  background?: unknown;
  output_format?: unknown;
  quality?: unknown;
  size?: unknown;
};

function collectOpenAiImagesNoOutputDetails(raw: OpenAiImagesResponse): Record<string, unknown> {
  const data = raw.data ?? [];
  return compactObject({
    created: raw.created,
    usage: raw.usage,
    background: raw.background,
    outputFormat: raw.output_format,
    quality: raw.quality,
    size: raw.size,
    dataCount: data.length,
    data: compactArray(
      data.map((item) =>
        compactObject({
          hasUrl: typeof item.url === "string" && item.url.length > 0,
          hasBase64Json: typeof item.b64_json === "string" && item.b64_json.length > 0,
          revisedPrompt: item.revised_prompt,
        }),
      ),
    ),
  });
}

function requiresPrompt(input: GenerationAdapterInput): boolean {
  const textSpec = input.declaration.content.input.find((spec) => spec.type === "text");
  return !!textSpec && (textSpec.required === true || (textSpec.min ?? 0) > 0);
}

function applyTransparentBackgroundOutputFormat(payload: Record<string, unknown>): void {
  if (payload.background !== "transparent") return;
  if (payload.output_format === "jpeg") {
    throw new GenerationValidationError("Transparent background requires output_format png or webp");
  }
  if (payload.output_format === undefined) payload.output_format = "png";
}

function mediaTypeForOutputFormat(format: unknown): string {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  return "image/png";
}

export async function openAiImagesAdapter(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const prompt = mergeTextBlocks(input.declaration, input.request.content);
  if (!prompt && requiresPrompt(input)) throw new GenerationValidationError("Prompt text is required");

  const images = await Promise.all(
    input.request.content
      .filter((block): block is Extract<GenerationContentBlock, { type: "image" }> => block.type === "image")
      .map((block) => input.context.resolveSource(block.source)),
  );

  const payload: Record<string, unknown> = {
    ...input.parameters,
    ...providerMeta(input.meta),
    model: input.declaration.model,
    prompt,
  };
  if (images.length > 0 && payload.image === undefined) payload.image = images;
  applyTransparentBackgroundOutputFormat(payload);
  const outputMediaType = mediaTypeForOutputFormat(payload.output_format);

  const response = await fetchWithTimeout(
    input.context.fetch,
    joinUrl(input.context.baseUrl, "/v1/images/generations"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.context.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    REQUEST_TIMEOUT_MS,
  );

  if (!response.ok) {
    const body = await response.text().catch(() => response.statusText);
    throw new GenerationProviderError("Image generation provider request failed", { status: response.status, body });
  }

  const raw = (await response.json()) as OpenAiImagesResponse;
  const output: GenerationContentBlock[] = [];
  for (const item of raw.data ?? []) {
    if (typeof item.url === "string" && item.url) {
      output.push({ type: "image", source: { type: "url", url: item.url } });
    }
    if (typeof item.b64_json === "string" && item.b64_json) {
      output.push({ type: "image", source: { type: "base64", mediaType: outputMediaType, data: item.b64_json } });
    }
    if (typeof item.revised_prompt === "string" && item.revised_prompt.trim()) {
      output.push({ type: "text", text: item.revised_prompt, meta: { role: "revised_prompt" } });
    }
  }
  if (output.length === 0) {
    throw new GenerationProviderError("Image generation returned no output", {
      details: collectOpenAiImagesNoOutputDetails(raw),
    });
  }
  return output;
}
