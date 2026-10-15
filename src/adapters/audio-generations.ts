import { GenerationProviderError, GenerationTimeoutError, GenerationValidationError } from "../errors.js";
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
// Must outlast the server's 20-minute song2 task timeout, or the SDK gives up before the task is settled and refunded.
const MAX_WAIT_SEC = 21 * 60;
// The server rejects a longer prompt, lyrics or score with a 400. It counts runes after trimming prompt and lyrics but
// counts the score as received; the SDK sends the trimmed text, so its limits are never looser than the server's.
const MAX_TEXT_CHARS = 2000;
const MAX_ABC_CHARS = 64_000;

type TextBlock = Extract<GenerationContentBlock, { type: "text" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// The request body is the one place that decides which keys exist: optional keys are added only when they have a value.
function songBody(input: ResolvedGenerationRequest): Record<string, unknown> {
  const model = input.declaration.model;
  const texts = input.request.content.filter((block): block is TextBlock => block.type === "text");
  const pick = (role: "prompt" | "lyrics" | "abc", maxChars: number, required: boolean): string | undefined => {
    const [block, extra] = texts.filter((candidate) => candidate.meta?.role === role);
    if (extra || (!block && required)) {
      const rule = required ? "requires exactly" : "accepts at most";
      throw new GenerationValidationError(`${model} ${rule} one ${role} text block`);
    }
    if (!block) return undefined;
    const text = block.text.trim();
    if (!text) throw new GenerationValidationError(`${role} must not be empty for ${model}`);
    if ([...text].length > maxChars) {
      throw new GenerationValidationError(`${role} must be at most ${maxChars} characters for ${model}`);
    }
    return text;
  };
  const prompt = pick("prompt", MAX_TEXT_CHARS, true);
  const lyrics = pick("lyrics", MAX_TEXT_CHARS, true);
  const abc = pick("abc", MAX_ABC_CHARS, false);
  const { abc_mode, seed, cfg_scale, return_abc } = input.parameters;
  if (abc_mode === "off" && (abc !== undefined || return_abc === true)) {
    throw new GenerationValidationError(`${model} cannot use abc_mode off with an abc text block or return_abc true`);
  }
  return compactObject({ model, prompt, lyrics, abc, abc_mode, seed, cfg_scale, return_abc });
}

async function requestJson(input: GenerationAdapterInput, path: string, init: RequestInit): Promise<unknown> {
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
  try {
    return body ? JSON.parse(body) : {};
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

  for await (const _ of taskPollTicks(MAX_WAIT_SEC * 1000, POLL_INTERVAL_SEC * 1000)) {
    const raw = await requestJson(input, `/v1/audio/generations/${encodeURIComponent(taskId)}`, { method: "GET" });
    const task = isRecord(raw) ? raw : {};
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
        });
      }
      default:
        // queued, in_progress, and any status the server adds later: keep polling until the deadline.
        break;
    }
  }
  throw new GenerationTimeoutError("Timed out waiting for song generation", { taskId });
}

export const audioGenerationsAdapter: GenerationAdapter = Object.assign(generateSong, {
  validate(input: ResolvedGenerationRequest): void {
    songBody(input);
  },
});
