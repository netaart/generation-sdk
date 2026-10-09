import { GenerationUnsupportedAdapterError } from "../errors.js";
import type { GenerationAdapter } from "../types.js";
import { arkVideoGenerationsAdapter } from "./ark-video-generations.js";
import { audioSpeechAdapter } from "./audio-speech.js";
import { audioTranscriptionAdapter } from "./audio-transcription.js";
import { geminiGenerateContentAdapter } from "./gemini-generate-content.js";
import { klingVideoGenerationsAdapter } from "./kling-video-generations.js";
import { minimaxH3VideoGenerationsAdapter } from "./minimax-h3-video-generations.js";
import { openAiImageEditsAdapter } from "./openai-image-edits.js";
import { openAiImagesAdapter } from "./openai-images.js";
import { sunoTasksAdapter } from "./suno-tasks.js";
import { videoUpscaleNativeAdapter } from "./video-upscale-native.js";

export const builtinGenerationAdapters: Record<string, GenerationAdapter> = {
  "ark.videoGenerations": arkVideoGenerationsAdapter,
  "newapi.audioTranscription": audioTranscriptionAdapter,
  "openai.audioSpeech": audioSpeechAdapter,
  "gemini.generateContent": geminiGenerateContentAdapter,
  "kling.videoGenerations": klingVideoGenerationsAdapter,
  "minimax.h3VideoGenerations": minimaxH3VideoGenerationsAdapter,
  "openai.imageEdits": openAiImageEditsAdapter,
  "openai.images": openAiImagesAdapter,
  "suno.tasks": sunoTasksAdapter,
  "video.upscaleNative": videoUpscaleNativeAdapter,
};

export function tryGetGenerationAdapter(
  type: string,
  adapters: Record<string, GenerationAdapter> = {},
): GenerationAdapter | undefined {
  return adapters[type] ?? builtinGenerationAdapters[type];
}

export function getGenerationAdapter(
  type: string,
  adapters: Record<string, GenerationAdapter> = {},
): GenerationAdapter {
  const adapter = tryGetGenerationAdapter(type, adapters);
  if (!adapter) throw new GenerationUnsupportedAdapterError(type);
  return adapter;
}

export * from "./ark-video-generations.js";
export * from "./audio-speech.js";
export * from "./audio-transcription.js";
export * from "./gemini-generate-content.js";
export * from "./kling-video-generations.js";
export * from "./minimax-h3-video-generations.js";
export * from "./openai-image-edits.js";
export * from "./openai-images.js";
export * from "./suno-tasks.js";
export * from "./video-upscale-native.js";
