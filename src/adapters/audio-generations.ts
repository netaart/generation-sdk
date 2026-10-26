import { FAILURE_CATEGORY_HEADER, GenerationProviderError, GenerationValidationError } from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import { taskPollTicks } from "../task-poll.js";
import type {
  GenerationAdapter,
  GenerationAdapterInput,
  GenerationContentBlock,
  ResolvedGenerationRequest,
} from "../types.js";
import { compactObject } from "../utils.js";

const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_SEC = 5;
// The server ends a song task; the SDK waits for that terminal state, and each request keeps its own 60 s timeout.
// The server rejects lyrics over 4000 code points with a 400. It counts code points after trimming, and the SDK
// validates the trimmed text. Without a schedule it sends the trimmed text too; with one it sends the raw text so the
// schedule offsets keep their code points. The style description and score have no limit.
const MAX_LYRICS_CODE_POINTS = 4000;

type TextBlock = Extract<GenerationContentBlock, { type: "text" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const SECTION_NAME = /^[A-Za-z][A-Za-z0-9_ -]*$/;
const LYRIC_SCHEDULE_KEYS = new Set(["sections", "lead_sec", "behind", "mode"]);

function readAbcContinue(value: unknown, model: string): true | undefined {
  if (value === undefined || value === false) return undefined;
  if (typeof value !== "boolean") {
    throw new GenerationValidationError(`abc_continue must be a boolean for ${model}`);
  }
  return true;
}

function readHarmonyFollow(value: unknown, model: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new GenerationValidationError(`harmony must be an object for ${model}`);
  for (const key of Object.keys(value)) {
    if (key !== "follow") throw new GenerationValidationError(`harmony.${key} is not supported for ${model}`);
  }
  const follow = value.follow;
  if (follow === undefined || follow === null) return undefined;
  if (!Array.isArray(follow)) throw new GenerationValidationError(`harmony.follow must be an array for ${model}`);
  if (follow.length === 0) return undefined;
  return follow.map((name, index) => {
    if (typeof name !== "string") {
      throw new GenerationValidationError(`harmony.follow[${index}] must be a string for ${model}`);
    }
    if (!SECTION_NAME.test(name) || name.endsWith(" ")) {
      throw new GenerationValidationError(
        `harmony.follow[${index}] must start with a letter and use only letters, digits, spaces, _ or - for ${model}`,
      );
    }
    return name.toLowerCase();
  });
}

function readLyricSchedule(
  value: unknown,
  originalLyricsCodePoints: number,
  model: string,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new GenerationValidationError(`lyric_schedule must be an object for ${model}`);
  for (const key of Object.keys(value)) {
    if (!LYRIC_SCHEDULE_KEYS.has(key)) {
      throw new GenerationValidationError(`lyric_schedule.${key} is not supported for ${model}`);
    }
  }
  const mode = value.mode === null ? undefined : value.mode;
  if (mode !== undefined && mode !== "mask") {
    throw new GenerationValidationError(`lyric_schedule.mode must be mask for ${model}`);
  }
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    throw new GenerationValidationError(`lyric_schedule.sections must be a non-empty array for ${model}`);
  }

  let previousStartSec = 0;
  const sections = value.sections.map((section, index) => {
    const label = `lyric_schedule.sections[${index}]`;
    if (!isRecord(section)) throw new GenerationValidationError(`${label} must be an object for ${model}`);
    for (const key of Object.keys(section)) {
      if (key !== "start_sec" && key !== "lyric") {
        throw new GenerationValidationError(`${label}.${key} is not supported for ${model}`);
      }
    }
    const startSec = section.start_sec;
    if (typeof startSec !== "number" || !Number.isFinite(startSec) || startSec < 0) {
      throw new GenerationValidationError(`${label}.start_sec must be a finite non-negative number for ${model}`);
    }
    if (startSec < previousStartSec) {
      throw new GenerationValidationError(`${label}.start_sec must not decrease for ${model}`);
    }
    previousStartSec = startSec;

    const lyric = section.lyric;
    if (!Array.isArray(lyric) || lyric.length !== 2) {
      throw new GenerationValidationError(`${label}.lyric must be a [c0, c1] pair for ${model}`);
    }
    const [c0, c1] = lyric;
    if (typeof c0 !== "number" || typeof c1 !== "number" || !Number.isInteger(c0) || !Number.isInteger(c1)) {
      throw new GenerationValidationError(`${label}.lyric must contain two integers for ${model}`);
    }
    if (c0 < 0 || c0 >= c1 || c1 > originalLyricsCodePoints) {
      throw new GenerationValidationError(
        `${label}.lyric must satisfy 0 <= c0 < c1 <= ${originalLyricsCodePoints} for ${model}`,
      );
    }
    return { start_sec: startSec, lyric: [c0, c1] };
  });

  const leadSec = value.lead_sec === null ? undefined : value.lead_sec;
  if (leadSec !== undefined && (typeof leadSec !== "number" || !Number.isFinite(leadSec) || leadSec < 0)) {
    throw new GenerationValidationError(`lyric_schedule.lead_sec must be a finite non-negative number for ${model}`);
  }
  const behind = value.behind === null ? undefined : value.behind;
  if (behind !== undefined && (typeof behind !== "number" || !Number.isInteger(behind) || behind < 0)) {
    throw new GenerationValidationError(`lyric_schedule.behind must be a non-negative integer for ${model}`);
  }
  return compactObject({ sections, lead_sec: leadSec, behind, mode });
}

// The request body is the one place that decides which keys exist: optional keys are added only when they have a value.
function songBody(input: ResolvedGenerationRequest): Record<string, unknown> {
  const model = input.declaration.model;
  const texts = input.request.content.filter((block): block is TextBlock => block.type === "text");
  const pick = (role: "prompt" | "lyrics" | "abc", required: boolean, maxChars?: number): string | undefined => {
    const [block, extra] = texts.filter((candidate) => candidate.meta?.role === role);
    if (extra || (!block && required)) {
      const rule = required ? "requires exactly" : "accepts at most";
      throw new GenerationValidationError(`${model} ${rule} one ${role} text block`);
    }
    if (!block) return undefined;
    const text = block.text.trim();
    if (!text) throw new GenerationValidationError(`${role} must not be empty for ${model}`);
    if (maxChars !== undefined && [...text].length > maxChars) {
      throw new GenerationValidationError(`${role} must be at most ${maxChars} characters for ${model}`);
    }
    return text;
  };
  const prompt = pick("prompt", true);
  const lyrics = pick("lyrics", true, MAX_LYRICS_CODE_POINTS);
  // The server trims the lyrics and shifts the spans; send the caller's text so the spans keep their code points.
  const rawLyrics = texts.find((candidate) => candidate.meta?.role === "lyrics")?.text ?? "";
  const abc = pick("abc", false);
  const { abc_mode, seed, cfg_scale, return_abc } = input.parameters;
  const abcContinue = readAbcContinue(input.parameters.abc_continue, model);
  const harmonyFollow = readHarmonyFollow(input.parameters.harmony, model);
  const lyricSchedule = readLyricSchedule(input.parameters.lyric_schedule, [...rawLyrics].length, model);
  if (abcContinue) {
    if (abc === undefined) {
      throw new GenerationValidationError(`abc_continue requires an abc text block for ${model}`);
    }
    if (abc_mode === "off") {
      throw new GenerationValidationError(`abc_continue cannot be used with abc_mode off for ${model}`);
    }
  }
  if (harmonyFollow) {
    if (abc !== undefined && !abcContinue) {
      throw new GenerationValidationError(
        `harmony requires abc_continue true when an abc text block is given for ${model}`,
      );
    }
    if (abc_mode === "melody") {
      throw new GenerationValidationError(
        `harmony cannot be used with abc_mode melody because a melody score has no chords ` +
          `to know when the last section is finished; use abc_mode full for ${model}`,
      );
    }
    if (abc_mode === "off") {
      throw new GenerationValidationError(`harmony cannot be used with abc_mode off for ${model}`);
    }
  }
  if (abc_mode === "off" && (abc !== undefined || return_abc === true)) {
    throw new GenerationValidationError(`${model} cannot use abc_mode off with an abc text block or return_abc true`);
  }
  return compactObject({
    model,
    prompt,
    lyrics: lyricSchedule ? rawLyrics : lyrics,
    abc,
    abc_mode,
    seed,
    cfg_scale,
    return_abc,
    abc_continue: abcContinue,
    harmony: harmonyFollow ? { follow: harmonyFollow } : undefined,
    lyric_schedule: lyricSchedule,
  });
}

async function requestJson(input: GenerationAdapterInput, path: string, init: RequestInit): Promise<unknown> {
  return (await requestJsonResponse(input, path, init)).body;
}

// 任务查询还要读取失败类别响应头：任务被审核拦截时，查询本身是 200。
async function requestJsonResponse(
  input: GenerationAdapterInput,
  path: string,
  init: RequestInit,
): Promise<{ body: unknown; category: string | undefined }> {
  const response = await fetchWithTimeout(
    input.context.fetch,
    joinUrl(input.context.baseUrl, path),
    {
      ...init,
      headers: {
        Authorization: `Bearer ${input.context.apiKey}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
    REQUEST_TIMEOUT_MS,
  );
  const body = await response.text();
  if (!response.ok) {
    throw new GenerationProviderError("Song generation request failed", { status: response.status, body });
  }
  const category = response.headers.get(FAILURE_CATEGORY_HEADER) ?? undefined;
  try {
    return { body: body ? JSON.parse(body) : {}, category };
  } catch {
    throw new GenerationProviderError("Song generation returned invalid JSON", { status: response.status, body });
  }
}

async function generateSong(input: GenerationAdapterInput): Promise<GenerationContentBlock[]> {
  const submitted = await requestJson(input, "/v1/audio/generations", {
    method: "POST",
    body: JSON.stringify(songBody(input)),
  });
  const taskId = isRecord(submitted) ? asString(submitted.id) : undefined;
  if (!taskId) {
    throw new GenerationProviderError("Song generation did not return a task id", { details: { task: submitted } });
  }

  for await (const _ of taskPollTicks(undefined, POLL_INTERVAL_SEC * 1000)) {
    const response = await requestJsonResponse(input, `/v1/audio/generations/${encodeURIComponent(taskId)}`, {
      method: "GET",
    });
    const task = isRecord(response.body) ? response.body : {};
    switch (task.status) {
      case "completed": {
        const audioUrl = asString(task.audio_url);
        if (!audioUrl) {
          throw new GenerationProviderError("Song generation completed without an audio url", {
            details: { taskId, task },
          });
        }
        const blocks: GenerationContentBlock[] = [
          { type: "audio", source: { type: "url", url: audioUrl }, meta: { task_id: taskId, status: "succeeded" } },
        ];
        // Verbatim: the caller edits the score and sends it back as the abc input.
        if (typeof task.abc === "string" && task.abc.trim()) {
          blocks.push({ type: "text", text: task.abc, meta: { role: "abc", task_id: taskId } });
        }
        return blocks;
      }
      case "failed": {
        const error = isRecord(task.error) ? task.error : undefined;
        const code = asString(error?.code);
        const message = asString(error?.message);
        throw new GenerationProviderError(`Song generation failed${message ? `: ${message}` : ""}`, {
          details: compactObject({ taskId, code, message }),
          category: response.category,
        });
      }
      default:
        // queued, in_progress, and any status the server adds later: keep polling until the server ends the task.
        break;
    }
  }
  throw new GenerationProviderError("Song generation polling ended without a terminal state", { details: { taskId } });
}

export const audioGenerationsAdapter: GenerationAdapter = Object.assign(generateSong, {
  validate(input: ResolvedGenerationRequest): void {
    songBody(input);
  },
});
