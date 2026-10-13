import { afterEach, describe, expect, it, vi } from "vitest";
import { createGenerationClient, type GenerationContentBlock } from "../../src/index.js";

type FetchCall = { url: string; init: RequestInit };

const SUBMIT_URL = "https://router.neta.art/v1/audio/generations";
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 21 * 60 * 1000;

const styleBlock: GenerationContentBlock = {
  type: "text",
  text: "bright J-pop, female vocal, piano",
  meta: { role: "prompt" },
};
const lyricsBlock: GenerationContentBlock = { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// The first response answers the submit; the rest answer successive status polls.
function taskFetch(calls: FetchCall[], submit: Response, ...polls: Response[]): typeof fetch {
  const queue = [...polls];
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (init?.method === "POST") return submit;
    return queue.length > 1 ? (queue.shift() as Response) : (queue[0] as Response).clone();
  }) as typeof fetch;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("yue2 song generation", () => {
  it("submits style and lyrics, polls to completion, and returns the song with its cost", async () => {
    vi.useFakeTimers();
    const calls: FetchCall[] = [];
    const client = createGenerationClient({
      apiKey: "key",
      fetch: taskFetch(
        calls,
        json({ id: "task-1", status: "queued", usage: { cost: 0.3 } }),
        json({ id: "task-1", status: "in_progress" }),
        json({ id: "task-1", status: "completed", audio_url: "https://example.com/song.mp3", usage: { cost: 0.3 } }),
      ),
    });

    const promise = client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    await expect(promise).resolves.toEqual({
      content: [
        {
          type: "audio",
          source: { type: "url", url: "https://example.com/song.mp3" },
          meta: { task_id: "task-1", status: "succeeded" },
        },
      ],
      cost: 0.3,
    });
    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["POST", SUBMIT_URL],
      ["GET", `${SUBMIT_URL}/task-1`],
      ["GET", `${SUBMIT_URL}/task-1`],
    ]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "yue2",
      prompt: "bright J-pop, female vocal, piano",
      lyrics: "[verse]\nla la la",
    });
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer key");
  });
});
