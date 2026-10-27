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

Use `systemOneResult()` when you need billing metadata alongside the typed answers:

```ts
const { result, cost, requestId } = await client.systemOneResult({
  model: "jev-latest",
  state: { ticket: "I was charged twice." },
  questions: {
    refund: noul("Does the customer need a refund?"),
    team: choice("Which team?", { billing: "Charges", technical: "Bugs" }),
  },
});

console.log(result.answers.team.choice); // inferred as "billing" | "technical"
console.log(cost, requestId);
```

This method returns `Promise<SystemOneResultWithMetadata<Q>>`. `result` is the official `SystemOneResult<Q>`; `cost` reads `usage.cost` from the response extensions. `requestId` uses the response body's `request_id`, followed by the `x-request-id` and `x-oneapi-request-id` response headers. Both metadata fields are optional and are omitted when unavailable; a reported zero cost is preserved. Each call captures its own metadata, and retries use the final response. Clients created from model files or directories also expose this method.

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

`systemOne` client options reuse the official `TypeSafeClientConfig`; per-call options reuse `RequestOptions`. `apiKey` and `fetch` come from the generation client. The official defaults apply for timeout and retries (10 seconds per attempt, 2 retries). Pass `signal`, `timeout`, `retry`, or `headers` as the second argument to `systemOne()` or `systemOneResult()` to override a call. Generation `debug` observes this transport with its existing redaction rules.

`systemOne()` returns the official `APIPromise<SystemOneResult<Q>>`, preserving question-name and criteria-key inference, `.asResponse()`, and `.withResponse()`. Request and response extensions remain available in the raw response. Gateway cost metadata can be read from `X-OneAPI-Cost-Metadata`; `.withResponse().requestId` follows the official SDK's `x-typesafe-request-id` header rule. Helpers `noul`, `choice`, and `score`, official request/result types, and official SDK error classes are re-exported from this package.

`listModels()` is synchronous and local, works without credentials, and includes `jev-latest` and `jev-1.13.0` with category `decision` and `systemOneExamples`. It does not call the TypeSafe SDK's remote model listing, which cannot parse OpenRouter's model-list format. A local declaration describes SDK capabilities; it does not assert account access or server availability. Additional Jev aliases can be supplied through `models` using `adapter: { type: "typesafe.systemOne" }`. Use `systemOne()` or `systemOneResult()` for these models; `generate()`, `generateResult()`, and `validate()` accept the media generation request shape.

For a real-provider check, set `JEV_API_KEY` and `JEV_BASE_URL` (the System One API root, such as `https://openrouter.ai/api` or `https://dev.new-api.talesofai.com/typesafe`), then run `pnpm test:live:jev`. `JEV_MODEL` defaults to `jev-latest`.

## Luna Decisions

`decisions()` uses `@openrouter/sdk@1.4.25` (`alpha.decisions.create()`) for requests, response parsing, cancellation, retries, and errors. The model `openai/gpt-6-luna-decisions` is listed locally with category `decision` and `decisionsExamples`.

```ts
import { createGenerationClient } from "@neta-art/generation";

const client = createGenerationClient({
  apiKey: process.env.NETA_ROUTER_API_KEY!,
});

const result = await client.decisions({
  decisionsRequest: {
    model: "openai/gpt-6-luna-decisions",
    state: [
      "Does this receipt show a duplicate charge?",
      { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
    ],
    questions: {
      duplicate: { type: "noul", instructions: "Is the same charge listed twice?" },
      team: { type: "choice", instructions: "Which team?", criteria: { billing: "Charges", technical: "Bugs" } },
    },
  },
});

const duplicate = result.answers.duplicate;
if (duplicate?.type === "noul") console.log(duplicate.noul);
console.log(result.usage.inputTokens);
```

`state` is text, a JSON object, or an array of text and `image_url` parts. Images are PNG, JPEG, or WebP base64 data URLs, at most 128 per request; a request has at most 200 questions. Answers are the official `DecisionsResponse` union keyed by question name, so check `type` before reading `noul`, `choice`, or `score`.

`decisionsResult()` takes the same arguments and returns `Promise<DecisionsResultWithMetadata>`: `result` is the official `DecisionsResponse`, `cost` reads `usage.cost` from the response body, and `requestId` uses the body's `request_id`, followed by the `x-request-id` and `x-oneapi-request-id` response headers. Both metadata fields are omitted when unavailable.

The default Decisions URL is `${baseUrl}/openrouter/api/alpha/decisions`, using the client's gateway token and fetch implementation. Gateway errors use OpenRouter's error format, so they are thrown as the official error classes (`UnauthorizedResponseError`, `PaymentRequiredResponseError`, `BadGatewayResponseError`, and so on) with `error.metadata.request_id`. To call OpenRouter directly, set the Decisions API root and use an OpenRouter key:

```ts
const direct = createGenerationClient({
  apiKey: process.env.OPENROUTER_API_KEY!,
  decisions: { serverURL: "https://openrouter.ai", timeoutMs: 60_000 },
});
```

`decisions` client options reuse the official `SDKOptions` except `apiKey`, `httpClient`, and `server`. `serverURL` is applied to every call, because the official Decisions operation ignores the client-level server URL. Per-call options reuse the official `RequestOptions` (`signal`, `timeoutMs`, `retries`, `headers`, `serverURL`). Retries are off by default: a failed gateway call may already be billed, so retrying would charge again. Pass `retryConfig` (client) or `retries` (per call) to opt in. Official request/response types and error classes are re-exported from this package. Use `decisions()` or `decisionsResult()` for this model; `generate()`, `generateResult()`, and `validate()` reject it.

For a real-provider check, set `LUNA_API_KEY` and `LUNA_SERVER_URL` (the Decisions API root, such as `https://openrouter.ai` or `https://new-api.talesofai.com/openrouter`), then run `pnpm test:live:luna`. `LUNA_MODEL` defaults to `openai/gpt-6-luna-decisions`.

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
- `jev-1.13.0` (System One)
- `gpt-image-2`
- `z-image-turbo`
- `qwen-image-edit`
- `qwen-tts`
- `qwen-audio-3.0-tts-plus`
- `qwen-audio-3.0-tts-flash`
- `scene3`
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
- `meshy`
- `song2`

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
| Clone a voice from one reference recording | Use an explicitly requested Qwen variant, or `qwen-tts`; pass one HTTP(S) reference URL and no `voice_prompt` |
| Use a default voice, including a delegated choice expressed only as any, random, suitable, or natural | `qwen-tts` with a short generic `voice_prompt`, such as a natural, neutral narrator |

- Qwen: `voice_prompt` design OR one-reference clone; `qwen-tts` is the unspecified-design default and accepts any text length; Plus / Flash require at least 15 Unicode code points.
- Conflict: reference + redesign requires user choice before generation.
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

TTS reference audio only supports HTTP(S) URLs. Qwen always uses the single text block as the speech input.

`scene3` takes exactly one non-empty text block, where inline `[bracketed]` cues such as `[sighs]` or `[laughs]` mark where a sound or a change of delivery lands. It also takes at most one HTTP(S) reference URL for a clone, and `meta.text` on that audio block can carry the transcript of the recording.

```ts
await client.generate({
  model: "scene3",
  content: [
    { type: "text", text: "[sighs] We missed the last train again. [laughs] Well, at least the night is warm." },
    {
      type: "audio",
      source: { type: "url", url: "https://example.com/reference.mp3" },
      meta: { text: "参考音频里实际说的话。" },
    },
  ],
});
```

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

`song2` generates a full song with vocals through `newapi.audioGenerations`. Send a style description and lyrics as
text blocks and mark them with `meta.role`: `prompt` for the style description and `lyrics` for the words to sing. Both
are trimmed and must not be blank, and lyrics are limited to 4000 characters. The exception is `lyric_schedule`: the
lyrics are then sent exactly as given, because its offsets count the code points of the text you send. The call polls
until the task reaches a terminal state and returns one audio block.

```ts
const result = await client.generateResult({
  model: "song2",
  content: [
    { type: "text", text: "bright J-pop, female vocal, piano", meta: { role: "prompt" } },
    { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } },
  ],
});

console.log(result.content, result.cost);
```

To make the song follow a melody, add a third text block with `meta.role` `abc` that holds an ABC notation score. It is
trimmed and must not be blank, and at most one is allowed. Write it in the notation `song2` returns: a score
in another ABC dialect is rejected when the task runs, and the failed task's error message says what is wrong. Six
optional parameters shape the song. Each is sent only when you set it, and none has a default, so a request without them
is the same as before.

| Parameter | Values | Effect |
| --- | --- | --- |
| `abc_mode` | `full`, `melody` | `full` follows a score with chords, `melody` follows only the melody. A score with chord marks is rejected in `melody` mode when the task runs; remove the chords or use `full`. Omitted, a given score is read for chord marks to pick `full` or `melody`, and without a score `full` is used |
| `seed` | integer, 0 to 9007199254740991 | Fixes the random seed. Omitted, every request uses a different one |
| `return_abc` | boolean | `true` returns the score the song used |
| `abc_continue` | boolean | Continue the given abc as a score opening, then sing it. Requires `abc` |
| `harmony` | object with `follow` | Section order to follow: an object with `follow`, a list of `%` section names. Only `follow` is supported |
| `lyric_schedule` | object | When lyric sections become visible: sections of `start_sec` and `lyric` `[c0, c1]` code point offsets, optional `lead_sec`, `behind` and `mode` `mask` |

A blank `prompt`, `lyrics`, or `abc`, lyrics over 4000 characters, a second `abc` block, and out-of-range parameter
values are rejected with `GenerationValidationError` before anything is submitted, so no cost is incurred.

With `return_abc: true` the result carries a second block after the audio: a `text` block with `meta.role` `abc` and the
`task_id`. Its text is the score exactly as received, so you can edit it and send it back as the `abc` block of the next
request. If the score has chord marks, as the score of a `full` song does, send it back with `abc_mode` omitted (it is
read as `full`) or set to `full`; `melody` rejects it.

```ts
const first = await client.generateResult({
  model: "song2",
  content: [
    { type: "text", text: "bright J-pop, female vocal, piano", meta: { role: "prompt" } },
    { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } },
  ],
  parameters: { return_abc: true, seed: 7 },
});

const score = first.content.find((block) => block.type === "text" && block.meta?.role === "abc");
if (score?.type !== "text") throw new Error("No score returned");

const again = await client.generateResult({
  model: "song2",
  content: [
    { type: "text", text: "bright J-pop, female vocal, piano", meta: { role: "prompt" } },
    { type: "text", text: "[verse]\nla la la", meta: { role: "lyrics" } },
    { type: "text", text: score.text.replace(/^Q:.*$/m, "Q:1/4=120"), meta: { role: "abc" } },
  ],
});
```

## 3D generation

```ts
const preview = await client.generate({
  model: "meshy",
  content: [{ type: "text", text: "a wooden treasure chest with iron bands" }],
  parameters: { operation: "text-to-3d", target_formats: ["glb", "usdz"] },
});
const [model] = preview;
if (!model) throw new Error("Meshy returned no files");

const refined = await client.generate({
  model: "meshy",
  content: [model, { type: "text", text: "weathered oak planks and dark iron" }],
  parameters: { operation: "text-to-3d-refine", enable_pbr: true },
});
```

Meshy is one model, `meshy`, with category `3d`. The required `parameters.operation` selects the function:

| `operation` | Function |
| --- | --- |
| `text-to-3d` | Generate an untextured model from a text prompt |
| `text-to-3d-refine` | Texture a `text-to-3d` model |
| `image-to-3d` | Generate a textured model from one image |
| `multi-image-to-3d` | Generate a textured model from 1 to 4 views of an object |
| `retexture` | Apply a new texture to a model |
| `remesh` | Rebuild the mesh of a model and convert it to other formats |
| `rigging` | Add a skeleton to a humanoid model |
| `text-to-motion` | Generate a motion clip from a text description |
| `animation` | Apply preset actions or a motion clip to a rigged character |

`operations` in the model declaration lists the content inputs and parameters of each function. A request may use only
those of the selected operation, plus `poll_interval` and `max_wait`, which control how the SDK waits for the task.
Meshy request fields such as `ai_model`, `target_formats`, and `enable_pbr` go in `parameters`; the SDK does not send
`operation`, `poll_interval`, or `max_wait` to Meshy.

The result has one content block per file: `3d` blocks first, starting with the main GLB, then `image` blocks for
thumbnails and texture maps, then a `video` block when Meshy returns a preview video. Every block carries
`meta.task_id`, `meta.task_type`, and `meta.field`, the Meshy response field the file came from, such as
`model_urls.glb` or `texture_urls[0].normal`. `3d` blocks also carry `meta.format`. An OBJ block carries `meta.mtl_url`,
a motion clip carries `meta.duration_ms`, and `meta.task_expires_at` is set when Meshy reports when the task expires.

To continue from an earlier result, pass its output block as input. A `3d` block with `meta.task_id` references that
task:

- `text-to-3d-refine` sends it as `preview_task_id`. The block must come from `text-to-3d`.
- `retexture`, `remesh`, and `rigging` send it as `input_task_id`, and Meshy reads the main model of that task. They
  send the file URL as `model_url` instead when the block holds another file of the task, such as
  `model_urls.pre_remeshed_glb` or a rigged character, when Meshy does not accept the source task type in
  `meta.task_type` for that operation, or when the task has expired.
- `animation` sends the `rigging` block as `rig_task_id`, and a `text-to-motion` block marked with
  `meta.role: "motion"` as `motion_task_id`.

A `3d` block without `meta.task_id` sends its URL as `model_url`. Meshy deletes a task 3 days after it finishes, at
`meta.task_expires_at`, and rejects later references to it. Refine and animation can only reference a task, so the SDK
rejects an expired source task before any request. The other operations send the file URL, which keeps working when it
points to a stored copy, such as the files neta-router archives.

```ts
const [character] = await client.generate({
  model: "meshy",
  content: [{ type: "3d", source: { type: "url", url: "https://example.com/character.glb" } }],
  parameters: { operation: "rigging" },
});
const [motion] = await client.generate({
  model: "meshy",
  content: [{ type: "text", text: "a person jumps forward and lands softly" }],
  parameters: { operation: "text-to-motion", duration: 3 },
});
if (!character || !motion) throw new Error("Meshy returned no files");
await client.generate({
  model: "meshy",
  content: [character, { ...motion, meta: { ...motion.meta, role: "motion" } }],
  parameters: { operation: "animation" },
});
```

`image-to-3d` and `multi-image-to-3d` take texture guide images as `image` blocks with `meta.role: "texture"`. Image
and 3D inputs use URL sources. When there is no input picture yet, generate one with an image model such as
`gemini-3.1-flash-image-preview` or `gpt-image-2`; neta-router archives the generated image and returns its URL, so the
output block can be passed on as is:

```ts
const images = await client.generate({
  model: "gemini-3.1-flash-image-preview",
  content: [{ type: "text", text: "a cartoon knight standing in an A pose, full body, plain white background" }],
});
const concept = images.find((block) => block.type === "image");
if (!concept) throw new Error("No image");
const knight = await client.generate({
  model: "meshy",
  content: [concept],
  parameters: { operation: "image-to-3d", pose_mode: "a-pose", target_formats: ["glb"] },
});
```

Meshy recommends waiting at least 60 minutes for a task, so `max_wait` defaults to 3600 seconds. A status check that
fails with a network error, a timeout, 408, 429, or 5xx, or that breaks off while its body is read, is retried at the
next poll, up to 10 times in a row. Each request waits up to 240 seconds, below the 300-second response header limit of
Node's built-in fetch. After the task succeeds, neta-router archives the result files before it answers; when that takes
longer, the next poll waits for the archive that is already running. Errors raised after the task is submitted carry
its ID in `details.task_id`, with the original error as `cause`. `generateResult()` reports the `usage.cost` of the last
gateway response that has one. While the task runs, the gateway reports the estimate it holds; once the task succeeds,
it reports the cost settled from the credits Meshy consumed, except for a status check that arrives between recording
the success and settling the cost.

For a real gateway check, export `NETA_ROUTER_API_KEY` for a key that can use Meshy and
`gemini-3.1-flash-lite-image`, optionally `NETA_ROUTER_BASE_URL`, and run `pnpm test:live:meshy`. The check generates
one input image with `gemini-3.1-flash-lite-image`, then spends Meshy credits on a short chain of image-to-3D, rigging,
text-to-motion, animation, text-to-3D, refine, and remesh tasks.

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

Parameter specs have `type` `string`, `number`, `integer`, `boolean`, or `array`. Numbers and integers accept `min`,
`max`, and `multipleOf`. An array declares `items`, either a string with an optional `enum` or an integer with optional
`min` and `max`, plus optional `min` and `max` item counts and `unique`.

A model with several functions declares them in `operations`, and its string parameter `operation` selects one per
request, so `operation` is required unless it declares a `default`. The `enum` of `operation` lists the operation names
in the order of `operations`. Each operation may declare a `title`, a `description`, `content.input`, and `parameters`,
which add to the model's own and do not repeat its content types or parameter names:

```yaml
schema: neta.generation.model.v1
model: meshy
category: 3d
adapter:
  type: meshy.tasks
content:
  input: []
parameters:
  operation:
    type: string
    enum: [text-to-3d, remesh]
  max_wait:
    type: integer
    optional: true
    default: 3600
operations:
  text-to-3d:
    content:
      input:
        - type: text
          required: true
  remesh:
    content:
      input:
        - type: 3d
          required: true
    parameters:
      topology:
        type: string
        optional: true
        enum: [quad, triangle]
```

`validate()` checks the request against the model's content inputs and parameters plus those of the selected operation,
and returns that combined declaration as `declaration`. `resolveGenerationOperation(declaration, parameters)` returns
the combined declaration for the operation in `parameters`, and checks only `parameters.operation`.

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

The content block `type` selects the media kind (`image`, `video`, `audio`, or `3d`). The source `type` selects how that media is supplied (`url` or `base64`). When a model declares `roles`, `meta.role` selects the media's provider-specific purpose. When it also sets `roleRequired`, that role must be present.

## Adapter types

Built-in adapters:

- `openai.images`
- `openai.imageEdits`
- `openai.audioSpeech`
- `gemini.generateContent`
- `ark.videoGenerations`
- `kling.videoGenerations`
- `suno.tasks`
- `meshy.tasks`
- `newapi.audioGenerations`

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
