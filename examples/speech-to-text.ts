import { createGenerationClient } from "../src/index.js";

const apiKey = process.env.NETA_ROUTER_API_KEY;
const audioUrl = process.env.TRANSCRIPTION_AUDIO_URL;
if (!apiKey) throw new Error("NETA_ROUTER_API_KEY is required");
if (!audioUrl) throw new Error("TRANSCRIPTION_AUDIO_URL is required");

const client = createGenerationClient({
  apiKey,
  ...(process.env.NETA_ROUTER_BASE_URL ? { baseUrl: process.env.NETA_ROUTER_BASE_URL } : {}),
});
const result = await client.generateResult({
  model: "volc.seedasr.auc",
  content: [{ type: "audio", source: { type: "url", url: audioUrl } }],
  parameters: {
    ...(process.env.TRANSCRIPTION_AUDIO_FORMAT ? { audio_format: process.env.TRANSCRIPTION_AUDIO_FORMAT } : {}),
    ...(process.env.TRANSCRIPTION_LANGUAGE ? { language: process.env.TRANSCRIPTION_LANGUAGE } : {}),
  },
});
console.log(JSON.stringify(result, null, 2));
