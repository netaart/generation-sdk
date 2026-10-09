import { describe, expect, it } from "vitest";
import {
  buildAudioTranscriptionPayload,
  parseAudioTranscriptionResponse,
} from "../../src/adapters/audio-transcription.js";
import {
  createGenerationClient,
  type GenerateRequest,
  type GenerationContentBlock,
  GenerationValidationError,
} from "../../src/index.js";

const client = createGenerationClient();
const audio = (url: string): GenerationContentBlock => ({ type: "audio", source: { type: "url", url } });
const request = (parameters?: Record<string, unknown>): GenerateRequest => ({
  model: "volc.seedasr.auc",
  content: [audio("https://example.com/recording.WAV?signature=abc")],
  ...(parameters ? { parameters } : {}),
});

describe("audio transcription", () => {
  it("builds a JSON request from a validated declaration without an API key", () => {
    const resolved = client.validate(request({ language: "en-US" }));
    expect(resolved.parameters.max_wait).toBe(330);
    expect(buildAudioTranscriptionPayload(resolved)).toEqual({
      model: "volc.seedasr.auc",
      audio_url: "https://example.com/recording.WAV?signature=abc",
      audio_format: "wav",
      language: "en-US",
      response_format: "verbose_json",
    });
  });

  it("accepts extensionless signed URLs with an explicit format", () => {
    const input = { ...request({ audio_format: "mp3" }), content: [audio("https://example.com/download?id=1")] };
    expect(buildAudioTranscriptionPayload(client.validate(input)).audio_format).toBe("mp3");
  });

  it.each([
    "file:///audio.wav",
    "data:audio/wav;base64,YQ==",
    "https://user:password@example.com/a.wav",
    "invalid",
    "https://example.com/download",
  ])("rejects URL %s", (url) => {
    expect(() => client.validate({ ...request(), content: [audio(url)] })).toThrow(GenerationValidationError);
  });

  it.each([
    { audio_format: "flac" },
    { language: " " },
    { max_wait: 0 },
    { max_wait: 1.5 },
    { prompt: "transcribe" },
    { stream: false },
    { temperature: 0 },
    { response_format: "text" },
  ])("rejects unsupported parameters %j", (parameters) => {
    expect(() => client.validate(request(parameters))).toThrow(GenerationValidationError);
  });

  it("rejects unsupported input blocks and metadata", () => {
    const invalid: GenerateRequest[] = [
      { ...request(), content: [] },
      { ...request(), content: [audio("https://example.com/a.wav"), audio("https://example.com/b.wav")] },
      { ...request(), content: [{ type: "text", text: "hello" }] },
      { ...request(), content: [{ type: "audio", source: { type: "base64", mediaType: "audio/wav", data: "YQ==" } }] },
      { ...request(), meta: { prompt: "ignored" } },
      { ...request(), content: [{ ...audio("https://example.com/a.wav"), meta: { role: "reference_audio" } }] },
    ];
    for (const input of invalid) expect(() => client.validate(input)).toThrow(GenerationValidationError);
  });

  it("preserves successful text, empty transcripts and second-based timestamps", () => {
    expect(
      parseAudioTranscriptionResponse({
        text: "hello",
        duration: 11,
        segments: [{ id: 0, start: 0.28, end: 10.36, text: "hello", tokens: [] }],
      }),
    ).toEqual({
      type: "text",
      text: "hello",
      meta: { duration: 11, segments: [{ start: 0.28, end: 10.36, text: "hello" }] },
    });
    expect(parseAudioTranscriptionResponse({ text: "", duration: 1 })).toEqual({
      type: "text",
      text: "",
      meta: { duration: 1, segments: [] },
    });
  });

  it.each([
    {},
    { text: "hello" },
    { text: "hello", duration: 0 },
    { text: "hello", duration: Number.NaN },
    { text: "hello", duration: 1, segments: {} },
    { text: "hello", duration: 1, segments: [{ text: "hello", start: -1, end: 1 }] },
    { text: "hello", duration: 1, segments: [{ text: "hello", start: 1, end: 0 }] },
  ])("rejects malformed response %j", (response) => {
    expect(() => parseAudioTranscriptionResponse(response)).toThrow();
  });
});
