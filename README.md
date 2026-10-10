# @neta-art/generation

A lightweight multimodal generation SDK with built-in model presets, model declaration files, and adapter-based provider calls.

## Install

```bash
npm install @neta-art/generation
```

## Quick start

```ts
import { createGenerationClient } from "@neta-art/generation";

const client = createGenerationClient({
  apiKey: process.env.NETA_ROUTER_API_KEY!,
});

const output = await client.generate({
  model: "gpt-image-2",
  content: [
    { type: "text", text: "a cinematic portrait of a robot florist, 35mm film" },
  ],
  parameters: {
    size: "1024x1024",
    quality: "high",
  },
});

console.log(output);
```

Use `generateResult` when you need observed request metadata:

```ts
const result = await client.generateResult({
  model: "gpt-image-2",
  content: [{ type: "text", text: "a small red toy robot on a white desk" }],
});

console.log(result.content);
console.log(result.requestId, result.cost);
```

`requestId` uses the response body's top-level `request_id`, then falls back to `x-request-id` and `x-oneapi-request-id` response headers. `cost` maps to the official request price in `usage.cost` when provided.

`baseUrl` defaults to `https://router.neta.art`. Pass a different endpoint when needed:

```ts
const client = createGenerationClient({
  apiKey: process.env.NETA_ROUTER_API_KEY!,
  baseUrl: "https://router.neta.art",
});
```

## Jev System One

`systemOne()` uses `@typesafe-ai/sdk@0.6.0` for requests, typed answers, cancellation, retries, and errors. Jev models are available through the existing local `listModels()`, `getModel()`, YAML export, and CLI discovery APIs.

```ts
import { choice, createGenerationClient, noul } from "@neta-art/generation";

const client = createGenerationClient({
  apiKey: process.env.NETA_ROUTER_API_KEY!,
});

const result = await client.systemOne({
  model: "jev-latest",
  state: { ticket: "I was charged twice.", optional: null },
  questions: {
    refund: noul("Does the customer need a refund?"),
    team: choice("Which team?", { billing: "Charges", technical: "Bugs" }),
  },
});

console.log(result.answers.refund.noul);
console.log(result.answers.team.choice); // inferred as "billing" | "technical"
console.log(result.usage.input_tokens);
```

The default System One URL is `${baseUrl}/typesafe/v1/systemone`, using the client's gateway token and fetch implementation. The gateway must enable the requested Jev model and native plugin route. To call OpenRouter directly, configure its System One base URL and use an OpenRouter key:

```ts
const direct = createGenerationClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  systemOne: {
    baseURL: "https://openrouter.ai/api",
    defaultModel: "jev-latest",
    timeout: 60_000,
    retry: { maxRetries: 0 },
  },
});
```

`systemOne` client options reuse the official `TypeSafeClientConfig`; per-call options reuse `RequestOptions`. `apiKey` and `fetch` come from the generation client. The official defaults apply for timeout and retries (10 seconds per attempt, 2 retries). Pass `signal`, `timeout`, `retry`, or `headers` as the second argument to `systemOne()` to override a call. Generation `debug` observes this transport with its existing redaction rules.

The return value is the official `APIPromise<SystemOneResult<Q>>`, preserving question-name and criteria-key inference, `.asResponse()`, and `.withResponse()`. Request and response extensions remain available in the raw response. Gateway cost metadata can be read from `X-OneAPI-Cost-Metadata`; `.withResponse().requestId` follows the official SDK's `x-typesafe-request-id` header rule. Helpers `noul`, `choice`, and `score`, official request/result types, and official SDK error classes are re-exported from this package.

`listModels()` is synchronous and local, works without credentials, and includes `jev-latest` and `jev-1.13` with category `decision` and `systemOneExamples`. It does not call the TypeSafe SDK's remote model listing, which cannot parse OpenRouter's model-list format. A local declaration describes SDK capabilities; it does not assert account access or server availability. Additional Jev aliases can be supplied through `models` using `adapter: { type: "typesafe.systemOne" }`. Use `systemOne()` for these models; `generate()`, `generateResult()`, and `validate()` accept the media generation request shape.

For a real-provider check, set `JEV_API_KEY` and `JEV_BASE_URL` (the System One API root, such as `https://openrouter.ai/api` or `https://dev.new-api.talesofai.com/typesafe`), then run `pnpm test:live:jev`. `JEV_MODEL` defaults to `jev-latest`.

## Speech to text

Doubao ASR 2.0 (`volc.seedasr.auc`) accepts exactly one audio URL and returns a text block. The gateway must support JSON requests to `/v1/audio/transcriptions` and have an enabled Volcengine speech channel.

```ts
const result = await client.generateResult({
  model: "volc.seedasr.auc",
  content: [
    { type: "audio", source: { type: "url", url: "https://example.com/recording.wav" } },
  ],
  parameters: { audio_format: "wav", language: "zh-CN" },
});

console.log(result.content, result.requestId, result.cost);
```

The adapter requests `verbose_json` and returns `{ type: "text", text, meta: { duration, segments } }`. Duration and segment `start`/`end` are in seconds; each segment also contains `text`. Empty transcripts are valid. `requestId` and `cost` follow the normal `generateResult` behavior and are included when the gateway supplies them.

`audio_format` accepts `wav`, `mp3`, `ogg` or `raw`. It is inferred from the URL path extension when omitted; signed or extensionless URLs can specify it explicitly. `language` uses Volcengine codes such as `zh-CN` and `en-US`; omission retains the upstream defaults. The URL must remain accessible to Volcengine throughout processing. File uploads, base64, multiple audio blocks and realtime streaming are not supported by this model. Optional text content blocks are accepted and ignored, so callers can include a CLI prompt alongside the audio URL. Prompt text is never sent to the transcription service.

`max_wait` controls the SDK request timeout in seconds (default 330). It does not extend gateway limits: New API normally allows 300 seconds for transcription, while neta-router's generic upstream timeout defaults to 240 seconds. Configure the gateway for the expected recording workload. A client timeout does not cancel a submitted upstream job; the SDK does not automatically retry transcription requests.

Run `pnpm example:speech-to-text` with `NETA_ROUTER_API_KEY` and `TRANSCRIPTION_AUDIO_URL` in `.env`. Optional variables are `NETA_ROUTER_BASE_URL`, `TRANSCRIPTION_AUDIO_FORMAT` and `TRANSCRIPTION_LANGUAGE`. For a real provider check, export those variables and run `pnpm test:live:audio-transcription`; `TRANSCRIPTION_EXPECTED_TEXT` optionally checks a known passage.

## Agent and tool discovery

Agents and external tools should inspect a model declaration before constructing a request. Declarations expose the accepted content blocks, source types, parameters, meta fields, descriptions, and validated request examples.

```ts
import { createGenerationClient } from "@neta-art/generation";

const discoveryClient = createGenerationClient();
const declaration = discoveryClient.getModel("qwen-tts");
if (!declaration) throw new Error("Model is unavailable");

console.log(discoveryClient.stringifyModelConfig(declaration.model, { format: "json" }));

const request = declaration.examples?.find((example) => example.title === "Voice design")?.request;
if (!request) throw new Error("Voice-design example is unavailable");

// Discovery and validation do not require an API key or access the network.
discoveryClient.validate(request);

const client = createGenerationClient({ apiKey: process.env.NETA_ROUTER_API_KEY! });
const result = await client.generateResult(request);
console.log(result.content, result.requestId);
```

Use `listModels()` to discover all models and `getModel()` for one machine-readable declaration. Treat examples as request templates, then call `validate()` after applying user input because adapter validation enforces cross-field rules that a structural declaration cannot fully express. Use `generateResult()` when the Agent needs request IDs or cost metadata.

The same declarations can be exported as YAML through the existing CLI:

```bash
neta-generation models list
neta-generation models export qwen-tts --out ./qwen-tts.yaml
neta-generation models export-all --out ./models
```

## Local testing with `.env`

`.env` is ignored by Git. Copy `.env.example` to `.env` and fill in your router key:

```bash
cp .env.example .env
```

```dotenv
NETA_ROUTER_API_KEY=your_api_key_here
```

Node.js does not load `.env` automatically for library code. The example scripts use Node's native `--env-file` flag through npm scripts:

```bash
pnpm example:basic-image
pnpm example:image-editing
pnpm example:text-to-speech
pnpm example:text-to-video
```

Live provider tests are separate from `pnpm test` because they use the real SDK client and submit real provider requests. Set
`NETA_ROUTER_API_KEY` or `NETA_API_KEY`, then run:

```bash
pnpm test:live:suno
pnpm test:live:audio-speech
```

Seedance live smoke tests exercise text-to-video, first/last frame video, and multi-reference-image plus reference-video
requests through the built SDK:

```bash
pnpm test:live:seedance
```

The script reads `NETA_ROUTER_API_KEY` or `NETA_API_KEY`, falling back to `/tmp/neta-router-key`, and writes reusable
JSON results under `/tmp/neta-generation-live/seedance`. Use `-- --download` to also save generated media files.
It also writes `visual-review.html`, which places the inputs and outputs side by side so the result can be checked for
actual first/last-frame or reference-media effect. Rebuild that report from an existing run with `-- --report-only`.

You can also call providers through the CLI:

```bash
node --env-file=.env ./dist/cli/index.js generate gemini-3.1-flash-image-preview \
  --prompt "a simple abstract geometric app icon" \
  --param aspect_ratio=1:1 \
  --param image_size=512 \
  --debug
```

Use `--image-url` for reference images, `--out` to write base64 outputs to files, and `json:` for non-string parameter values, for example `--param duration=json:5`.

## Debug provider requests

Pass `debug: true` to print the final provider request and response metadata to stderr. Sensitive fields such as `Authorization` and base64 image data are redacted by default.

```ts
const client = createGenerationClient({
  apiKey: process.env.NETA_ROUTER_API_KEY!,
  debug: true,
});
```

For a custom logger or unredacted secret headers. Base64 media payloads are always redacted from debug events. Media URLs remain complete, including query strings and fragments, so treat debug output as sensitive diagnostic data:

```ts
const client = createGenerationClient({
  apiKey: process.env.NETA_ROUTER_API_KEY!,
  debug: {
    enabled: true,
    includeSensitive: true,
    logger: (event) => console.error(JSON.stringify(event, null, 2)),
  },
});
```

## Built-in models

- `jev-latest` (System One)
- `jev-1.13` (System One)
- `gpt-image-2`
- `z-image-turbo`
- `qwen-image-edit`
- `qwen-tts`
- `qwen-audio-3.0-tts-plus`
- `qwen-audio-3.0-tts-flash`
- `higgs-tts`
- `gemini-3.1-flash-image-preview`
- `kling-text-to-video`
- `kling-image-to-video`
- `kling-omni-video`
- `kling-multi-image-to-video`
- `minimax-h3`
- `minimax-h3-unrestricted`
- `seedance-2-0`
- `seedance-2-0-fast`
- `seedance-2-5`
- `suno_music_chirp_fenix`
- `noobxl-t2i-onediff`
- `noobxl-i2i-ipa-onediff`
- `birefnet-general`
- `suno_style_tags`
- `suno_upload_audio`
- `suno_cover_chirp_v5`
- `suno_infill_chirp_v5`
- `suno_sound_chirp_v5`
- `suno_image_to_song_chirp_v5`
- `suno_video_to_song_chirp_v5`
- `suno_vox_chirp_v5`

Built-in model declarations share the same client-level `apiKey` and `baseUrl`.

## Image editing with a reference image

```ts
const output = await client.generate({
  model: "gemini-3.1-flash-image-preview",
  content: [
    { type: "text", text: "turn this portrait into a watercolor illustration" },
    { type: "image", source: { type: "url", url: "https://example.com/portrait.jpg" } },
  ],
  parameters: {
    aspect_ratio: "3:4",
    image_size: "2K",
  },
});
```

## Image models

These image models use the same client API as the other built-in models:

- `z-image-turbo`
- `qwen-image-edit`
- `noobxl-t2i-onediff`
- `noobxl-i2i-ipa-onediff`
- `birefnet-general`

```ts
await client.generate({
  model: "z-image-turbo",
  content: [{ type: "text", text: "a clean product-style image of a small red toy robot" }],
  parameters: {
    size: "1024*1024",
  },
});

await client.generate({
  model: "qwen-image-edit",
  content: [
    { type: "text", text: "change the background to a clean white studio backdrop" },
    { type: "image", source: { type: "url", url: "https://example.com/input.png" } },
  ],
  parameters: {
    size: "1024x1024",
  },
});

await client.generate({
  model: "noobxl-t2i-onediff",
  content: [{ type: "text", text: "anime key visual, luminous city at night" }],
  parameters: {
    size: "1024x1024",
    negative_prompt: "low quality, blurry",
  },
});

await client.generate({
  model: "birefnet-general",
  content: [
    { type: "image", source: { type: "url", url: "https://example.com/portrait.png" } },
  ],
});
```

## Text to speech

Each TTS request accepts exactly one non-empty text block and returns one URL audio block. Choose the model from the requested voice mode and priority before constructing the request:

| Requirement | Model choice |
| --- | --- |
| Create a voice from a text-only description, without reference audio | Use an explicitly requested Qwen variant; otherwise use `qwen-tts` as the deterministic default |
| Maximize fidelity to one reference voice | `higgs-tts` |
| Blend 2-16 weighted reference voices | `higgs-tts` |
| Use a default voice, including a delegated choice expressed only as any, random, suitable, or natural | `higgs-tts` |

- Qwen: `voice_prompt` design OR one-reference clone; `qwen-tts` is the unspecified-design default and accepts any text length; Plus / Flash require at least 15 Unicode code points.
- Higgs: delegated default voice, high-fidelity one-reference clone, or weighted 2-16-reference blend.
- Conflict: reference + redesign requires user choice before generation.
- Blend: all references, full text, one request.
- Dependency: clone prior generated audio.
- Ranking: no declared Qwen quality, latency, or cost order.

```ts
await client.generate({
  model: "qwen-tts",
  content: [{ type: "text", text: "欢迎使用语音合成功能。" }],
  meta: {
    voice_prompt: "一位沉稳自然的中文播音员，吐字清晰，语速适中",
  },
});

await client.generate({
  model: "qwen-audio-3.0-tts-flash",
  content: [
    { type: "text", text: "这是一段长度足够并且表达清晰自然的语音合成文本。" },
    { type: "audio", source: { type: "url", url: "https://example.com/reference.mp3" } },
  ],
});
```

```ts
await client.generate({
  model: "higgs-tts",
  content: [
    { type: "text", text: "使用多参考融合音色朗读这段文本。" },
    {
      type: "audio",
      source: { type: "url", url: "https://example.com/reference-a.mp3" },
      meta: { weight: 0.5 },
    },
    {
      type: "audio",
      source: { type: "url", url: "https://example.com/reference-b.mp3" },
      meta: { weight: 0.5 },
    },
  ],
});
```

TTS reference audio only supports HTTP(S) URLs. Qwen always uses the single text block as the speech input.

## Video generation

```ts
const output = await client.generate({
  model: "seedance-2-0-fast",
  content: [
    { type: "text", text: "a cat playing piano in a cozy jazz club, cinematic lighting" },
  ],
  parameters: {
    duration: 5,
    resolution: "720p",
    ratio: "16:9",
  },
});
```

Seedance frame and reference media video modes use `meta.role` with public URL media sources:

```ts
await client.generate({
  model: "seedance-2-0",
  content: [
    { type: "text", text: "create a smooth dramatic transition" },
    { type: "image", source: { type: "url", url: "https://example.com/start.jpg" }, meta: { role: "first_frame" } },
    { type: "image", source: { type: "url", url: "https://example.com/end.jpg" }, meta: { role: "last_frame" } },
  ],
});
```

```ts
await client.generate({
  model: "seedance-2-0-fast",
  content: [
    { type: "text", text: "keep the subject from the image and the motion style from the video" },
    { type: "image", source: { type: "url", url: "https://example.com/subject.jpg" }, meta: { role: "reference_image" } },
    { type: "video", source: { type: "url", url: "https://example.com/motion.mp4" }, meta: { role: "reference_video" } },
  ],
});
```

Seedance reference audio uses a public URL and `meta.role: "reference_audio"`. Audio cannot be the only media input; include at least one image or video in the same request:

```ts
await client.generate({
  model: "seedance-2-0",
  content: [
    { type: "text", text: "keep the subject from the image and the rhythm from the audio" },
    { type: "image", source: { type: "url", url: "https://example.com/subject.jpg" }, meta: { role: "reference_image" } },
    { type: "audio", source: { type: "url", url: "https://example.com/reference.mp3" }, meta: { role: "reference_audio" } },
  ],
});
```

Kling exposes stable capability model ids while the adapter sends the latest upstream `model_name` for each capability:

```ts
await client.generate({
  model: "kling-image-to-video",
  content: [
    { type: "text", text: "gently turn toward the camera with soft natural motion" },
    { type: "image", source: { type: "url", url: "https://example.com/input.png" } },
  ],
  parameters: {
    duration: 5,
    aspect_ratio: "16:9",
  },
});
```

## Music generation

```ts
const output = await client.generate({
  model: "suno_music_chirp_fenix",
  content: [
    { type: "text", text: "uplifting cinematic pop with warm piano and clear chorus" },
  ],
  meta: {
    title: "Warm Horizon",
    tags: "cinematic pop, warm piano",
    make_instrumental: false,
  },
});

console.log(output);
```

Suno uses one shared adapter with a small public model set: `suno_music_chirp_fenix`, `suno_style_tags`,
`suno_upload_audio`, `suno_cover_chirp_v5`, `suno_infill_chirp_v5`, `suno_sound_chirp_v5`,
`suno_image_to_song_chirp_v5`, `suno_video_to_song_chirp_v5`, and `suno_vox_chirp_v5`. Provider-specific fields such as
`title`, `tags`, `make_instrumental`, and `metadata_params` belong in `meta`.

`suno_music` is removed in this release. Migrate to a concrete model name and stop sending `parameters.operation` or `meta.task`.

## Load model declarations from files

```ts
import { createGenerationClientFromDirectory } from "@neta-art/generation";

const client = await createGenerationClientFromDirectory("./models", {
  apiKey: process.env.NETA_ROUTER_API_KEY!,
});
```

Supported declaration formats:

- `.yaml`
- `.yml`
- `.json`

Custom declarations are merged with built-in models by default. If the same `model` exists, the custom declaration wins.

## Export model declarations

```ts
import { exportBuiltinModelConfig } from "@neta-art/generation";

await exportBuiltinModelConfig("gpt-image-2", "./gpt-image-2.yaml");
```

CLI:

```bash
neta-generation models list
neta-generation models export gpt-image-2 --out ./gpt-image-2.yaml
neta-generation models export-all --out ./models
```

## Model declaration schema

```yaml
schema: neta.generation.model.v1
model: gpt-image-2
title: GPT Image 2
category: image
pricing:
  unit: image
  min: 0.04
  max: 0.73
adapter:
  type: openai.images
content:
  input:
    - type: text
      required: true
      min: 1
      max: 16
      merge: newline
    - type: image
      required: false
      max: 16
      sources:
        - url
        - base64
parameters:
  size:
    type: string
    optional: true
    default: 1024x1024
```

A declaration may carry a display-only `pricing` block in USD. `unit` names what one charge covers
(`image`, `second`, `request`, or `1m_tokens`); `amount` is the exact unit price, or a `min`/`max`
pair when the price depends on request parameters (resolution, duration, quality). The SDK does not
price or bill anything: pricing is declaration metadata for catalog surfaces, and actual charges
always come from the provider.

Set `hidden: true` on a declaration to hide the model from default discovery surfaces while keeping exact-ID lookup
and generation available. This is a discovery hint, not an authorization or runtime availability control.
`listModels()` returns the complete model catalog, including hidden models, so each user-facing discovery surface can
apply its own visibility policy without losing declaration data.

Adapter credentials are intentionally not stored in model declarations. Use client-level or request-level `apiKey` and `baseUrl` instead.

## Content sources

```ts
type GenerationSource =
  | { type: "url"; url: string }
  | { type: "base64"; mediaType: string; data: string };
```

The content block `type` selects the media kind (`image`, `video`, or `audio`). The source `type` selects how that media is supplied (`url` or `base64`). When a model declares `roles`, `meta.role` selects the media's provider-specific purpose. When it also sets `roleRequired`, that role must be present.

## Adapter types

Built-in adapters:

- `openai.images`
- `openai.imageEdits`
- `openai.audioSpeech`
- `gemini.generateContent`
- `ark.videoGenerations`
- `kling.videoGenerations`
- `suno.tasks`

You can register custom adapters:

```ts
const client = createGenerationClient({
  apiKey,
  adapters: {
    "custom.adapter": async (input) => {
      return [];
    },
  },
});
```

## Validation without provider calls

```ts
const resolved = client.validate({
  model: "gpt-image-2",
  content: [{ type: "text", text: "hello" }],
});

console.log(resolved.parameters);
```

## Error handling

```ts
import {
  GenerationProviderError,
  GenerationTransportError,
  GenerationValidationError,
} from "@neta-art/generation";

try {
  await client.generate(request);
} catch (error) {
  if (error instanceof GenerationValidationError) {
    console.error("Invalid request", error.message);
  } else if (error instanceof GenerationTransportError) {
    console.error("Provider transport failed", error.message);
    console.error(error.details?.causeCode, error.details?.causeSyscall);
  } else if (error instanceof GenerationProviderError) {
    console.error("Provider failed", error.message);
    console.error(error.status, error.details?.requestId, error.details?.code);
  }
}
```
