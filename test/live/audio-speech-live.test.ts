import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createGenerationClient, type GenerateRequest } from "../../src/index.js";

const KEY_FILE = "/tmp/neta-router-key";
const REFERENCE_A = "https://oss.talesofai.cn/audio/d0bff78c-6577-4020-a5bf-a5ddd6970a50_0.mp3";
const REFERENCE_B = "https://oss.talesofai.cn/audio/f35a8675-0385-4921-8528-186a70358db6_0.mp3";

async function readApiKey(): Promise<string> {
  const envKey = (process.env.NETA_ROUTER_API_KEY ?? process.env.NETA_API_KEY)?.trim();
  if (envKey) return envKey;
  return (await readFile(KEY_FILE, "utf8")).trim();
}

function hasRunEnvironment(): boolean {
  const envKey = process.env.NETA_ROUTER_API_KEY ?? process.env.NETA_API_KEY;
  return Boolean(envKey?.trim() || existsSync(KEY_FILE));
}

function text(value: string) {
  return { type: "text" as const, text: value };
}

function audio(url: string, weight?: number) {
  return {
    type: "audio" as const,
    source: { type: "url" as const, url },
    ...(weight === undefined ? {} : { meta: { weight } }),
  };
}

async function assertAudioUrl(url: string): Promise<void> {
  let response = await fetch(url, { method: "HEAD" });
  if (response.status === 405) response = await fetch(url, { headers: { Range: "bytes=0-0" } });
  expect(response.ok).toBe(true);
  expect(response.headers.get("content-type") ?? "").toMatch(/^audio\//i);
  await response.body?.cancel();
}

const liveDescribe = hasRunEnvironment() ? describe : describe.skip;

liveDescribe("audio speech live router smoke", () => {
  it("generates valid audio for every model and primary voice mode in strict sequence", async () => {
    const apiKey = await readApiKey();
    const client = createGenerationClient({ apiKey });
    const runId = `${Date.now()}`;
    const cases: Array<{ name: string; request: GenerateRequest }> = [
      {
        name: "qwen voice design",
        request: {
          model: "qwen-audio-3.0-tts-plus",
          content: [text(`这是基础模型设计音色端到端测试，运行编号${runId}。`)],
          meta: { voice_prompt: "一位沉稳干练的男性播音员声音，吐字清晰有力" },
        },
      },
      {
        name: "qwen voice clone",
        request: {
          model: "qwen-audio-3.0-tts-plus",
          content: [text(`这是基础模型克隆音色端到端测试，运行编号${runId}。`), audio(REFERENCE_A)],
        },
      },
      {
        name: "qwen audio 3 plus",
        request: {
          model: "qwen-audio-3.0-tts-plus",
          content: [text(`这是增强版本语音合成端到端测试文本，运行编号${runId}。`), audio(REFERENCE_A)],
        },
      },
      {
        name: "qwen audio 3 flash",
        request: {
          model: "qwen-audio-3.0-tts-flash",
          content: [text(`这是快速版本语音合成端到端测试文本，运行编号${runId}。`), audio(REFERENCE_A)],
        },
      },
      {
        name: "higgs default voice",
        request: {
          model: "higgs-tts",
          content: [text(`这是默认音色端到端测试，运行编号${runId}。`)],
        },
      },
      {
        name: "higgs single reference",
        request: {
          model: "higgs-tts",
          content: [text(`这是单参考音色端到端测试，运行编号${runId}。`), audio(REFERENCE_A)],
        },
      },
      {
        name: "higgs multiple references",
        request: {
          model: "higgs-tts",
          content: [
            text(`这是多参考融合音色端到端测试，运行编号${runId}。`),
            audio(REFERENCE_A, 0.5),
            audio(REFERENCE_B, 0.5),
          ],
        },
      },
    ];

    for (const testCase of cases) {
      const result = await client.generateResult(testCase.request);
      expect(result.content, testCase.name).toHaveLength(1);
      expect(result.requestId, testCase.name).toEqual(expect.any(String));
      expect(result.content[0], testCase.name).toMatchObject({
        type: "audio",
        source: { type: "url", url: expect.stringMatching(/^https?:\/\//) },
        meta: {
          content_type: expect.stringMatching(/^audio\//),
          request_id: expect.any(String),
        },
      });
      const block = result.content[0];
      if (block?.type !== "audio" || block.source.type !== "url") throw new Error(`${testCase.name} returned no URL`);
      await assertAudioUrl(block.source.url);
    }
  }, 1_500_000);
});
