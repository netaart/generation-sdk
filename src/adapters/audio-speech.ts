import { GenerationProviderError, GenerationValidationError } from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import type {
  GenerationAdapter,
  GenerationAdapterInput,
  GenerationContentBlock,
  ResolvedGenerationRequest,
} from "../types.js";

const REQUEST_TIMEOUT_MS = 210_000;
const QWEN_MODELS = new Set(["qwen-tts", "qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"]);
const QWEN_AUDIO_3_MODELS = new Set(["qwen-audio-3.0-tts-plus", "qwen-audio-3.0-tts-flash"]);
const HIGGS_MODEL = "higgs-tts";
const BREEZE_MODEL = "breeze-tts-2";
const INDEX_TTS_MODEL = "index-tts-2.5";

type TextBlock = Extract<GenerationContentBlock, { type: "text" }>;
type AudioBlock = Extract<GenerationContentBlock, { type: "audio" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function textBlocks(input: ResolvedGenerationRequest): TextBlock[] {
  return input.request.content.filter((block): block is TextBlock => block.type === "text");
}

function audioBlocks(input: ResolvedGenerationRequest): AudioBlock[] {
  return input.request.content.filter((block): block is AudioBlock => block.type === "audio");
}

function validateMetaKeys(
  label: string,
  meta: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
): void {
  for (const key of Object.keys(meta ?? {})) {
    if (!allowed.has(key)) throw new GenerationValidationError(`Unknown ${label} field: ${key}`);
  }
}

function validateHttpUrl(value: unknown, label: string): void {
  if (typeof value !== "string") throw new GenerationValidationError(`${label} must be a valid HTTP(S) URL`);
  const trimmed = value.trim();
  if (!trimmed) throw new GenerationValidationError(`${label} must be a non-empty HTTP(S) URL`);
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw new GenerationValidationError(`${label} must be a valid HTTP(S) URL`);
  }
}

function validateCommonContent(input: ResolvedGenerationRequest): { text: TextBlock; audio: AudioBlock[] } {
  const texts = textBlocks(input);
  if (texts.length !== 1 || typeof texts[0]?.text !== "string" || !texts[0].text.trim()) {
    throw new GenerationValidationError(
      `${input.declaration.model} requires exactly one non-empty text content block as input`,
    );
  }

  const audio = audioBlocks(input);
  for (const [index, block] of audio.entries()) {
    if (block.source.type !== "url") {
      throw new GenerationValidationError(`${input.declaration.model} reference audio must use a URL source`);
    }
    validateHttpUrl(block.source.url, `audio content block ${index} URL`);
  }
  return { text: texts[0], audio };
}

function validateQwen(input: ResolvedGenerationRequest, text: TextBlock, audio: AudioBlock[]): void {
  if (audio.length > 1) {
    throw new GenerationValidationError(`${input.declaration.model} supports at most one reference audio`);
  }
  // Keep accepting the retired preview_text key for compatibility, but never use or forward it.
  const requestMetaKeys = new Set(["voice_prompt", "preview_text"]);
  validateMetaKeys("request.metadata", input.request.metadata, requestMetaKeys);
  validateMetaKeys("request.meta", input.request.meta, requestMetaKeys);
  validateMetaKeys("text content meta", text.meta, new Set());
  for (const block of audio) validateMetaKeys("audio content meta", block.meta, new Set());

  const voicePrompt = input.meta.voice_prompt;
  const hasVoicePrompt = typeof voicePrompt === "string" && voicePrompt.trim().length > 0;
  if (voicePrompt !== undefined && !hasVoicePrompt) {
    throw new GenerationValidationError(`${input.declaration.model} meta.voice_prompt must be a non-empty string`);
  }
  if (audio.length === 0 && !hasVoicePrompt) {
    throw new GenerationValidationError(`${input.declaration.model} requires one reference audio or meta.voice_prompt`);
  }
  if (audio.length > 0 && hasVoicePrompt) {
    throw new GenerationValidationError(
      `${input.declaration.model} reference audio and meta.voice_prompt are mutually exclusive`,
    );
  }

  if (QWEN_AUDIO_3_MODELS.has(input.declaration.model) && Array.from(text.text.trim()).length < 15) {
    throw new GenerationValidationError(`${input.declaration.model} requires input of at least 15 Unicode code points`);
  }
}

function hasOwnWeight(block: AudioBlock): boolean {
  return Object.hasOwn(block.meta ?? {}, "weight");
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validateHiggs(input: ResolvedGenerationRequest, text: TextBlock, audio: AudioBlock[]): void {
  if (audio.length > 16)
    throw new GenerationValidationError(`${input.declaration.model} supports at most 16 references`);
  validateMetaKeys("request.metadata", input.request.metadata, new Set());
  validateMetaKeys("request.meta", input.request.meta, new Set());
  validateMetaKeys("text content meta", text.meta, new Set());

  for (const [index, block] of audio.entries()) {
    validateMetaKeys(`audio content block ${index} meta`, block.meta, new Set(["weight"]));
    const weight = block.meta?.weight;
    if (audio.length === 1 && (!hasOwnWeight(block) || weight === undefined)) continue;
    if (!isPositiveFiniteNumber(weight)) {
      throw new GenerationValidationError(`audio content block ${index} meta.weight must be a finite positive number`);
    }
  }
}

function nonEmptyMetaString(input: ResolvedGenerationRequest, key: string): string | undefined {
  const value = input.meta[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new GenerationValidationError(`${input.declaration.model} meta.${key} must be a non-empty string`);
  }
  return value;
}

function validateBreeze(input: ResolvedGenerationRequest, text: TextBlock, audio: AudioBlock[]): void {
  if (audio.length > 1) {
    throw new GenerationValidationError(`${input.declaration.model} supports at most one reference audio`);
  }
  const requestMetaKeys = new Set(["instruction", "ref_text"]);
  validateMetaKeys("request.metadata", input.request.metadata, requestMetaKeys);
  validateMetaKeys("request.meta", input.request.meta, requestMetaKeys);
  validateMetaKeys("text content meta", text.meta, new Set());
  for (const block of audio) validateMetaKeys("audio content meta", block.meta, new Set());

  nonEmptyMetaString(input, "instruction");
  const refText = nonEmptyMetaString(input, "ref_text");
  if (refText !== undefined && audio.length === 0) {
    throw new GenerationValidationError(`${input.declaration.model} meta.ref_text requires one reference audio`);
  }

  if (Array.from(text.text.trim()).length > 1000) {
    throw new GenerationValidationError(`${input.declaration.model} accepts input of at most 1000 Unicode code points`);
  }
}

function validateIndexTts(input: ResolvedGenerationRequest, text: TextBlock, audio: AudioBlock[]): void {
  if (audio.length === 0) {
    throw new GenerationValidationError(`${input.declaration.model} requires one reference audio`);
  }
  if (audio.length > 1) {
    throw new GenerationValidationError(`${input.declaration.model} supports at most one reference audio`);
  }
  const requestMetaKeys = new Set(["emotion_audio", "emotion_text", "duration_factor", "language"]);
  validateMetaKeys("request.metadata", input.request.metadata, requestMetaKeys);
  validateMetaKeys("request.meta", input.request.meta, requestMetaKeys);
  validateMetaKeys("text content meta", text.meta, new Set());
  for (const block of audio) validateMetaKeys("audio content meta", block.meta, new Set());

  const emotionAudio = input.meta.emotion_audio;
  if (emotionAudio !== undefined) {
    validateHttpUrl(emotionAudio, `${input.declaration.model} meta.emotion_audio`);
  }
  const emotionText = nonEmptyMetaString(input, "emotion_text");
  if (emotionAudio !== undefined && emotionText !== undefined) {
    throw new GenerationValidationError(
      `${input.declaration.model} meta.emotion_audio and meta.emotion_text are mutually exclusive`,
    );
  }
}

function validateAudioSpeechRequest(input: ResolvedGenerationRequest): void {
  const { text, audio } = validateCommonContent(input);
  if (QWEN_MODELS.has(input.declaration.model)) {
    validateQwen(input, text, audio);
    return;
  }
  if (input.declaration.model === HIGGS_MODEL) {
    validateHiggs(input, text, audio);
    return;
  }
  if (input.declaration.model === BREEZE_MODEL) {
    validateBreeze(input, text, audio);
    return;
  }
  if (input.declaration.model === INDEX_TTS_MODEL) {
    validateIndexTts(input, text, audio);
    return;
  }
  throw new GenerationValidationError(`Unsupported audio speech model: ${input.declaration.model}`);
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  return headers.get("x-request-id")?.trim() || headers.get("x-oneapi-request-id")?.trim() || undefined;
}

function buildPayload(input: ResolvedGenerationRequest): Record<string, unknown> {
  const text = textBlocks(input)[0];
  if (!text) throw new GenerationValidationError("Audio speech input was not validated");
  const audio = audioBlocks(input);
  const payload: Record<string, unknown> = {
    model: input.declaration.model,
    input: text.text,
  };

  if (QWEN_MODELS.has(input.declaration.model)) {
    if (audio[0]?.source.type === "url") payload.ref_audio = audio[0].source.url.trim();
    else payload.metadata = { voice_prompt: input.meta.voice_prompt };
    return payload;
  }

  if (input.declaration.model === BREEZE_MODEL) {
    if (audio[0]?.source.type === "url") payload.ref_audio = audio[0].source.url.trim();
    const metadata: Record<string, unknown> = {};
    if (input.meta.instruction !== undefined) metadata.instruction = input.meta.instruction;
    if (input.meta.ref_text !== undefined) metadata.ref_text = input.meta.ref_text;
    if (Object.keys(metadata).length > 0) payload.metadata = metadata;
    return payload;
  }

  if (input.declaration.model === INDEX_TTS_MODEL) {
    if (audio[0]?.source.type === "url") payload.ref_audio = audio[0].source.url.trim();
    const metadata: Record<string, unknown> = { language: input.meta.language };
    const emotionAudio = input.meta.emotion_audio;
    if (typeof emotionAudio === "string") metadata.emotion_audio = emotionAudio.trim();
    if (input.meta.emotion_text !== undefined) metadata.emotion_text = input.meta.emotion_text;
    if (input.meta.duration_factor !== undefined) metadata.duration_factor = input.meta.duration_factor;
    payload.metadata = metadata;
    return payload;
  }

  const firstAudio = audio[0];
  if (audio.length === 1 && firstAudio && (!hasOwnWeight(firstAudio) || firstAudio.meta?.weight === undefined)) {
    if (firstAudio.source.type === "url") payload.ref_audio = firstAudio.source.url.trim();
    return payload;
  }
  if (audio.length > 0) {
    payload.metadata = {
      references: audio.map((block) => ({
        url: block.source.type === "url" ? block.source.url.trim() : "",
        weight: block.meta?.weight,
      })),
    };
  }
  return payload;
}

function parseJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function providerError(response: Response, rawBody: string): GenerationProviderError {
  const requestId = requestIdFromHeaders(response.headers);
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  const parsed =
    contentType.includes("application/json") || contentType.includes("+json") ? parseJson(rawBody) : undefined;
  const parsedRecord = isRecord(parsed) ? parsed : undefined;
  const errorRecord = isRecord(parsedRecord?.error) ? parsedRecord.error : undefined;
  const message =
    nonEmptyString(errorRecord?.message) ??
    (rawBody.trim() ? rawBody : undefined) ??
    (response.statusText.trim() ? response.statusText : undefined) ??
    "Audio speech provider request failed";
  const code = nonEmptyString(errorRecord?.code);

  return new GenerationProviderError(message, {
    status: response.status,
    body: rawBody,
    details: {
      requestId,
      code,
      ...(parsedRecord ? { error: parsedRecord } : {}),
    },
  });
}

function unsupportedSuccessResponse(response: Response, rawBody: string): GenerationProviderError {
  const statusText = response.statusText.trim();
  const message =
    response.status === 204 && statusText
      ? statusText
      : "Audio speech provider returned an unsupported success response";
  return new GenerationProviderError(message, {
    status: response.status,
    body: rawBody,
    details: { requestId: requestIdFromHeaders(response.headers) },
  });
}

function parseSuccessResponse(response: Response, rawBody: string): GenerationContentBlock {
  const parsed = parseJson(rawBody);
  if (!isRecord(parsed)) throw unsupportedSuccessResponse(response, rawBody);

  const urlValue = nonEmptyString(parsed.url);
  const contentType = nonEmptyString(parsed.content_type);
  if (
    !urlValue ||
    parsed.media_type !== "audio" ||
    !contentType ||
    !/^audio\/[^\s/;]+(?:\s*;.*)?$/i.test(contentType)
  ) {
    throw unsupportedSuccessResponse(response, rawBody);
  }
  try {
    const url = new URL(urlValue.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    throw unsupportedSuccessResponse(response, rawBody);
  }

  const size = parsed.size;
  if (
    size !== undefined &&
    (typeof size !== "number" || !Number.isFinite(size) || !Number.isInteger(size) || size < 0)
  ) {
    throw unsupportedSuccessResponse(response, rawBody);
  }

  const requestId = requestIdFromHeaders(response.headers);
  return {
    type: "audio",
    source: { type: "url", url: urlValue.trim() },
    meta: {
      content_type: contentType,
      ...(size !== undefined ? { size } : {}),
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
}

async function generateAudioSpeech(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const response = await fetchWithTimeout(
    input.context.fetch,
    joinUrl(input.context.baseUrl, "/v1/audio/speech"),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.context.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPayload(input)),
    },
    REQUEST_TIMEOUT_MS,
  );
  const rawBody = await response.text().catch(() => "");
  if (!response.ok) throw providerError(response, rawBody);
  return [parseSuccessResponse(response, rawBody)];
}

export const audioSpeechAdapter: GenerationAdapter = Object.assign(generateAudioSpeech, {
  validate: validateAudioSpeechRequest,
});
