import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationValidationError } from "../../src/errors.js";
import { createGenerationClient, type GenerationContentBlock } from "../../src/index.js";

type FetchCall = { url: string; init: RequestInit };

const SUBMIT_URL = "https://router.neta.art/v1/audio/generations";
const AUDIO_URL = "https://example.com/song.mp3";
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 21 * 60 * 1000;

const styleBlock: GenerationContentBlock = {
  type: "text",
  text: "bright J-pop, female vocal, piano",
  meta: { role: "prompt" },
};
const lyricsBlock: GenerationContentBlock = { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } };

function textBlock(role: "prompt" | "lyrics", text: string): GenerationContentBlock {
  return { type: "text", text, meta: { role } };
}

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

function clientWith(calls: FetchCall[], submit: Response, ...polls: Response[]) {
  return createGenerationClient({ apiKey: "key", fetch: taskFetch(calls, submit, ...polls) });
}

// Settles on the first poll, so no timers are needed.
function settlingClient(calls: FetchCall[]) {
  return clientWith(
    calls,
    json({ id: "task-1", status: "queued" }),
    json({ id: "task-1", status: "completed", audio_url: AUDIO_URL }),
  );
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

  it("keeps the submit cost when the status responses carry no usage", async () => {
    const calls: FetchCall[] = [];
    const client = clientWith(
      calls,
      json({ id: "task-1", status: "queued", usage: { cost: 0.3 } }),
      json({ id: "task-1", status: "completed", audio_url: AUDIO_URL }),
    );

    const result = await client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] });

    expect(result.cost).toBe(0.3);
  });

  it("keeps polling through queued and unrecognised statuses", async () => {
    vi.useFakeTimers();
    const calls: FetchCall[] = [];
    const client = clientWith(
      calls,
      json({ id: "task-1", status: "queued" }),
      json({ id: "task-1", status: "queued" }),
      json({ id: "task-1", status: "something_new" }),
      json({ id: "task-1", status: "completed", audio_url: AUDIO_URL }),
    );

    const promise = client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

    await expect(promise).resolves.toMatchObject({ content: [{ type: "audio", source: { url: AUDIO_URL } }] });
    expect(calls).toHaveLength(4);
  });

  describe("input checks before any request", () => {
    it.each(["lyrics", "prompt"] as const)("rejects %s longer than 2000 characters", async (role) => {
      const calls: FetchCall[] = [];
      const client = settlingClient(calls);
      const long = "a".repeat(2001);
      const content =
        role === "lyrics" ? [styleBlock, textBlock("lyrics", long)] : [textBlock("prompt", long), lyricsBlock];

      await expect(client.generateResult({ model: "yue2", content })).rejects.toBeInstanceOf(GenerationValidationError);
      expect(calls).toHaveLength(0);
    });

    it("accepts lyrics of exactly 2000 characters", async () => {
      const calls: FetchCall[] = [];
      const client = settlingClient(calls);

      await client.generateResult({ model: "yue2", content: [styleBlock, textBlock("lyrics", "a".repeat(2000))] });

      expect(JSON.parse(String(calls[0]?.init.body)).lyrics).toHaveLength(2000);
    });

    it("trims before counting", async () => {
      const calls: FetchCall[] = [];
      const client = settlingClient(calls);
      const padded = `  \n${"a".repeat(2000)}\n  `;

      await client.generateResult({ model: "yue2", content: [styleBlock, textBlock("lyrics", padded)] });

      expect(JSON.parse(String(calls[0]?.init.body)).lyrics).toBe("a".repeat(2000));
    });

    it("counts code points, not UTF-16 units", async () => {
      const accepted: FetchCall[] = [];
      await settlingClient(accepted).generateResult({
        model: "yue2",
        content: [styleBlock, textBlock("lyrics", "😀".repeat(2000))],
      });
      expect(accepted).toHaveLength(2);

      const rejected: FetchCall[] = [];
      await expect(
        settlingClient(rejected).generateResult({
          model: "yue2",
          content: [styleBlock, textBlock("lyrics", "😀".repeat(2001))],
        }),
      ).rejects.toBeInstanceOf(GenerationValidationError);
      expect(rejected).toHaveLength(0);
    });

    it.each([
      ["empty prompt", [textBlock("prompt", "   "), lyricsBlock]],
      ["empty lyrics", [styleBlock, textBlock("lyrics", "")]],
      ["two prompts and no lyrics", [styleBlock, textBlock("prompt", "second style")]],
      ["two lyrics and no prompt", [lyricsBlock, textBlock("lyrics", "more words")]],
    ])("rejects %s", async (_name, content) => {
      const calls: FetchCall[] = [];
      const client = settlingClient(calls);

      await expect(client.generateResult({ model: "yue2", content })).rejects.toBeInstanceOf(GenerationValidationError);
      expect(calls).toHaveLength(0);
    });
  });

  describe("failures", () => {
    it.each([
      "generation_failed",
      "generation_timeout",
    ])("throws the provider error %s and stops polling", async (code) => {
      vi.useFakeTimers();
      const calls: FetchCall[] = [];
      const client = clientWith(
        calls,
        json({ id: "task-1", status: "queued" }),
        json({ id: "task-1", status: "in_progress" }),
        json({ id: "task-1", status: "failed", error: { code, message: "worker gave up" } }),
      );

      const promise = client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] });
      const rejection = expect(promise).rejects.toMatchObject({
        name: "GenerationProviderError",
        message: expect.stringContaining("worker gave up"),
        details: { taskId: "task-1", code, message: "worker gave up" },
      });
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await rejection;

      const settled = calls.length;
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
      expect(calls).toHaveLength(settled);
    });

    it("throws a timeout error with the task id when the task never settles", async () => {
      vi.useFakeTimers();
      const calls: FetchCall[] = [];
      const client = clientWith(
        calls,
        json({ id: "task-1", status: "queued" }),
        json({ id: "task-1", status: "in_progress" }),
      );

      const promise = client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] });
      const rejection = expect(promise).rejects.toMatchObject({
        name: "GenerationTimeoutError",
        details: { taskId: "task-1" },
      });
      await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + POLL_INTERVAL_MS);
      await rejection;
    });

    it("throws a provider error with status and body when the submit is rejected", async () => {
      const calls: FetchCall[] = [];
      const body = JSON.stringify({ error: { message: "insufficient quota" } });
      const client = clientWith(calls, new Response(body, { status: 403 }));

      await expect(client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] })).rejects.toMatchObject({
        name: "GenerationProviderError",
        status: 403,
        body,
      });
      expect(calls).toHaveLength(1);
    });

    it("throws a provider error with status and body when a status poll fails", async () => {
      const calls: FetchCall[] = [];
      const client = clientWith(
        calls,
        json({ id: "task-1", status: "queued" }),
        new Response("bad gateway", { status: 502 }),
      );

      await expect(client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] })).rejects.toMatchObject({
        name: "GenerationProviderError",
        status: 502,
        body: "bad gateway",
      });
    });

    it("throws a provider error when a response is not JSON", async () => {
      const calls: FetchCall[] = [];
      const client = clientWith(calls, new Response("<html>oops</html>", { status: 200 }));

      await expect(client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] })).rejects.toMatchObject({
        name: "GenerationProviderError",
        status: 200,
        body: "<html>oops</html>",
      });
    });

    it("throws a provider error when the submit response has no task id", async () => {
      const calls: FetchCall[] = [];
      const client = clientWith(calls, json({ status: "queued" }));

      await expect(client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] })).rejects.toMatchObject({
        name: "GenerationProviderError",
      });
      expect(calls).toHaveLength(1);
    });

    it("throws a provider error when a completed task has no audio url", async () => {
      const calls: FetchCall[] = [];
      const client = clientWith(
        calls,
        json({ id: "task-1", status: "queued" }),
        json({ id: "task-1", status: "completed" }),
      );

      await expect(client.generateResult({ model: "yue2", content: [styleBlock, lyricsBlock] })).rejects.toMatchObject({
        name: "GenerationProviderError",
        details: { taskId: "task-1" },
      });
    });
  });
});
