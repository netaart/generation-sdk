import { GenerationProviderError, GenerationValidationError } from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import { extractGenerationResultHeaderFields } from "../response-fields.js";
import type {
  GenerationAdapter,
  GenerationAdapterInput,
  GenerationContentBlock,
  ResolvedGenerationRequest,
} from "../types.js";

const FORMATS = new Set(["wav", "mp3", "ogg", "raw"]);

type TranscriptSegment = { start: number; end: number; text: string; speaker?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function buildAudioTranscriptionPayload(input: ResolvedGenerationRequest): Record<string, unknown> {
  const media = input.request.content.filter((block) => block.type !== "text");
  const [audio] = media;
  if (media.length !== 1 || audio?.type !== "audio" || audio.source.type !== "url") {
    throw new GenerationValidationError("Audio transcription requires exactly one audio URL");
  }
  let url: URL;
  try {
    url = new URL(audio.source.url.trim());
  } catch {
    throw new GenerationValidationError("Audio transcription requires a valid HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new GenerationValidationError("Audio transcription requires an HTTP(S) URL without credentials");
  }
  for (const meta of [input.request.meta, input.request.metadata, audio.meta]) {
    if (Object.keys(meta ?? {}).length > 0) {
      throw new GenerationValidationError("Audio transcription does not accept metadata; use parameters");
    }
  }
  const extension = url.pathname.split("/").at(-1)?.split(".").slice(1).at(-1)?.toLowerCase();
  const format = input.parameters.audio_format ?? extension;
  if (typeof format !== "string" || !FORMATS.has(format)) {
    throw new GenerationValidationError(
      "Specify audio_format as wav, mp3, ogg or raw when the URL has no supported extension",
    );
  }
  const language = input.parameters.language;
  if (language !== undefined && (typeof language !== "string" || language.trim().length === 0)) {
    throw new GenerationValidationError("language must be a non-empty Volcengine language code, for example zh-CN");
  }
  return {
    model: input.declaration.model,
    audio_url: url.href,
    audio_format: format,
    ...(language !== undefined ? { language } : {}),
    response_format: "verbose_json",
    ...speakerPayload(input.parameters, language),
  };
}

function speakerPayload(parameters: Record<string, unknown>, language: unknown): Record<string, unknown> {
  const { enable_speaker_info, ssd_version, ssd_mode } = parameters;
  if (enable_speaker_info !== true) {
    if (ssd_version !== undefined || ssd_mode !== undefined) {
      throw new GenerationValidationError("ssd_version and ssd_mode require enable_speaker_info=true");
    }
    return {};
  }
  if (language !== undefined && language !== "zh-CN") {
    throw new GenerationValidationError("Speaker separation requires language to be unset or zh-CN");
  }
  if (ssd_mode !== undefined && ssd_version !== undefined && ssd_version !== "200") {
    throw new GenerationValidationError('ssd_mode requires ssd_version "200"');
  }
  return {
    enable_speaker_info: true,
    ssd_version: ssd_version ?? "200",
    ...(ssd_mode !== undefined ? { ssd_mode } : {}),
  };
}

export function parseAudioTranscriptionResponse(raw: unknown): GenerationContentBlock {
  if (
    !isRecord(raw) ||
    typeof raw.text !== "string" ||
    typeof raw.duration !== "number" ||
    !Number.isFinite(raw.duration) ||
    raw.duration <= 0
  ) {
    throw new GenerationProviderError("Audio transcription response requires text and a positive duration");
  }
  const segments: TranscriptSegment[] = [];
  if (raw.segments !== undefined) {
    if (!Array.isArray(raw.segments)) throw new GenerationProviderError("Invalid transcription segments");
    for (const segment of raw.segments) {
      if (
        !isRecord(segment) ||
        typeof segment.text !== "string" ||
        typeof segment.start !== "number" ||
        !Number.isFinite(segment.start) ||
        segment.start < 0 ||
        typeof segment.end !== "number" ||
        !Number.isFinite(segment.end) ||
        segment.end < segment.start ||
        (segment.speaker !== undefined && (typeof segment.speaker !== "string" || segment.speaker.length === 0))
      ) {
        throw new GenerationProviderError("Invalid transcription segment text, timestamps or speaker");
      }
      segments.push({
        start: segment.start,
        end: segment.end,
        text: segment.text,
        ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
      });
    }
  }
  return { type: "text", text: raw.text, meta: { duration: raw.duration, segments } };
}

async function generateAudioTranscription(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const payload = buildAudioTranscriptionPayload(input);
  const response = await fetchWithTimeout(
    input.context.fetch,
    joinUrl(input.context.baseUrl, "/v1/audio/transcriptions"),
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.context.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    Number(input.parameters.max_wait) * 1000,
  );
  const body = await response.text();
  const headers = extractGenerationResultHeaderFields(response.headers);
  const details = { requestId: headers?.requestId ?? headers?.oneApiRequestId };
  if (!response.ok) {
    throw new GenerationProviderError(`Audio transcription failed (HTTP ${response.status}): ${body}`, {
      status: response.status,
      body,
      details,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new GenerationProviderError("Audio transcription returned invalid JSON", {
      status: response.status,
      body,
      details,
    });
  }
  return [parseAudioTranscriptionResponse(raw)];
}

export const audioTranscriptionAdapter: GenerationAdapter = Object.assign(generateAudioTranscription, {
  validate(input: ResolvedGenerationRequest): void {
    buildAudioTranscriptionPayload(input);
  },
});
