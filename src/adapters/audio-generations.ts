import { GenerationProviderError, GenerationTimeoutError } from "../errors.js";
import { fetchWithTimeout, joinUrl } from "../http.js";
import { taskPollTicks } from "../task-poll.js";
import type { GenerationAdapter, GenerationAdapterInput, GenerationContentBlock } from "../types.js";

const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_SEC = 5;
// Must outlast the server's 20-minute yue2 task timeout, or the SDK gives up before the task is settled and refunded.
const MAX_WAIT_SEC = 21 * 60;

type TextBlock = Extract<GenerationContentBlock, { type: "text" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function songText(input: GenerationAdapterInput): { prompt: string; lyrics: string } {
  const texts = input.request.content.filter((block): block is TextBlock => block.type === "text");
  const prompt = texts.find((block) => block.meta?.role === "prompt");
  const lyrics = texts.find((block) => block.meta?.role === "lyrics");
  return { prompt: prompt?.text ?? "", lyrics: lyrics?.text ?? "" };
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
  const parsed: unknown = body ? JSON.parse(body) : {};
  return parsed;
}

export const audioGenerationsAdapter: GenerationAdapter = async (input) => {
  const { prompt, lyrics } = songText(input);
  const task = await requestJson(input, "/v1/audio/generations", {
    method: "POST",
    body: JSON.stringify({ model: input.declaration.model, prompt, lyrics }),
  });
  const taskId = isRecord(task) ? asString(task.id) : undefined;
  if (!taskId) throw new GenerationProviderError("Song generation did not return a task id", { details: { task } });

  for await (const _ of taskPollTicks(MAX_WAIT_SEC * 1000, POLL_INTERVAL_SEC * 1000)) {
    const raw = await requestJson(input, `/v1/audio/generations/${encodeURIComponent(taskId)}`, { method: "GET" });
    if (isRecord(raw) && raw.status === "completed") {
      return [
        {
          type: "audio",
          source: { type: "url", url: String(raw.audio_url) },
          meta: { task_id: taskId, status: "succeeded" },
        },
      ];
    }
  }
  throw new GenerationTimeoutError("Timed out waiting for song generation", { taskId });
};
