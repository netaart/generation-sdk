import { expect, it } from "vitest";
import { createGenerationClient } from "../../src/index.js";

it("transcribes a real recording through the configured gateway", async () => {
  const apiKey = process.env.NETA_ROUTER_API_KEY;
  const url = process.env.TRANSCRIPTION_AUDIO_URL;
  if (!apiKey || !url) throw new Error("NETA_ROUTER_API_KEY and TRANSCRIPTION_AUDIO_URL are required");
  const client = createGenerationClient({
    apiKey,
    ...(process.env.NETA_ROUTER_BASE_URL ? { baseUrl: process.env.NETA_ROUTER_BASE_URL } : {}),
  });
  const result = await client.generateResult({
    model: "volc.seedasr.auc",
    content: [{ type: "audio", source: { type: "url", url } }],
    parameters: {
      ...(process.env.TRANSCRIPTION_AUDIO_FORMAT ? { audio_format: process.env.TRANSCRIPTION_AUDIO_FORMAT } : {}),
      ...(process.env.TRANSCRIPTION_LANGUAGE ? { language: process.env.TRANSCRIPTION_LANGUAGE } : {}),
    },
  });
  expect(result.content).toHaveLength(1);
  const transcript = result.content[0];
  expect(transcript?.type).toBe("text");
  if (transcript?.type !== "text") throw new Error("Expected a transcript");
  expect(transcript.text.trim().length).toBeGreaterThan(0);
  expect(transcript.meta?.duration).toBeGreaterThan(0);
  expect(Array.isArray(transcript.meta?.segments)).toBe(true);
  expect(result.requestId).toBeTruthy();
  if (process.env.TRANSCRIPTION_EXPECTED_TEXT) {
    expect(transcript.text.toLowerCase()).toContain(process.env.TRANSCRIPTION_EXPECTED_TEXT.toLowerCase());
  }
}, 360_000);
