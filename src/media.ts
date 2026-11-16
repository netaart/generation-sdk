import { imageSize } from "image-size";
import { createFile, type Movie, MP4BoxBuffer } from "mp4box";
import { parseBuffer } from "music-metadata";
import { GenerationMediaReadError, GenerationValidationError } from "./errors.js";
import type {
  GenerationContentBlock,
  GenerationContentSpec,
  GenerationMediaFetch,
  GenerationMediaResponse,
  GenerationMediaSpec,
  GenerationModelDeclaration,
  GenerationRange,
} from "./types.js";

type MediaKind = "image" | "video" | "audio";
type MediaBlock = Extract<GenerationContentBlock, { type: MediaKind }>;

/** What the media reader measured from one file. */
export type GenerationMediaInfo = {
  format: string | undefined;
  bytes: number;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
};

type MediaSource = { size: number; read(start: number, end: number): Promise<Uint8Array> };
type CheckTarget = { block: MediaBlock; index: number; spec: GenerationMediaSpec; label: string };

const READ_TIMEOUT_MS = 30_000;
const READ_CONCURRENCY = 3;
const VIDEO_CHUNK_BYTES = 256 * 1024;

// image-size 对 HEIF 系列返回 ftyp 品牌，这里归到声明里使用的格式名
const IMAGE_FORMATS: Record<string, string> = {
  jpg: "jpeg",
  heic: "heic",
  heix: "heic",
  heim: "heic",
  heis: "heic",
  hevc: "heic",
  hevx: "heic",
  mif1: "heif",
  msf1: "heif",
  heif: "heif",
  avif: "avif",
  avis: "avif",
};

function isMediaBlock(block: GenerationContentBlock): block is MediaBlock {
  return block.type === "image" || block.type === "video" || block.type === "audio";
}

function blockLabel(block: MediaBlock, index: number): string {
  const role = block.meta?.role;
  return `${typeof role === "string" && role ? role : block.type} (content[${index}])`;
}

function urlHost(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url;
}

function formatNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

function formatBytes(bytes: number): string {
  return `${formatNumber(bytes / 1024 / 1024)} MB`;
}

function memorySource(bytes: Uint8Array): MediaSource {
  return { size: bytes.length, read: async (start, end) => bytes.subarray(start, end) };
}

async function discardBody(response: GenerationMediaResponse): Promise<void> {
  await response.body?.[Symbol.asyncIterator]().return?.();
}

function tooLarge(label: string, bytes: number | undefined, maxBytes: number): GenerationValidationError {
  const size = bytes === undefined ? `is larger than ${formatBytes(maxBytes)}` : `is ${formatBytes(bytes)}`;
  return new GenerationValidationError(
    `${label}: the file ${size}, above the ${formatBytes(maxBytes)} limit; compress it or use a smaller file`,
  );
}

async function request(
  fetchMedia: GenerationMediaFetch,
  url: string,
  label: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<GenerationMediaResponse> {
  let response: GenerationMediaResponse;
  try {
    response = await fetchMedia(url, { headers, signal });
  } catch (error) {
    if (error instanceof GenerationValidationError) throw new GenerationValidationError(`${label}: ${error.message}`);
    if (signal.aborted) throw new GenerationMediaReadError(`Timed out reading ${label} from ${urlHost(url)}`, error);
    throw new GenerationMediaReadError(`Could not read ${label} from ${urlHost(url)}: ${String(error)}`, error);
  }
  const { status } = response;
  if (status < 300) return response;
  await discardBody(response);
  if (status >= 500 || status === 408 || status === 429) {
    throw new GenerationMediaReadError(`Could not read ${label} from ${urlHost(url)}: HTTP ${status}`);
  }
  throw new GenerationValidationError(`${label}: the URL returned HTTP ${status}; use a URL that serves the file`);
}

async function readBody(
  response: GenerationMediaResponse,
  url: string,
  label: string,
  maxBytes: number | undefined,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (maxBytes !== undefined && declared > maxBytes) {
    await discardBody(response);
    throw tooLarge(label, declared, maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body ?? []) {
      total += chunk.length;
      if (maxBytes !== undefined && total > maxBytes) throw tooLarge(label, undefined, maxBytes);
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof GenerationValidationError) throw error;
    if (signal.aborted) throw new GenerationMediaReadError(`Timed out reading ${label} from ${urlHost(url)}`, error);
    throw new GenerationMediaReadError(`Could not read ${label} from ${urlHost(url)}: ${String(error)}`, error);
  }
  return Buffer.concat(chunks);
}

// 视频只按需分段读取：mp4box 读完 moov 就能拿到规格，跳过中间的 mdat。服务器不支持 Range 时按顺序读取。
async function openVideoSource(
  fetchMedia: GenerationMediaFetch,
  url: string,
  label: string,
  maxBytes: number | undefined,
  signal: AbortSignal,
): Promise<MediaSource> {
  const response = await request(fetchMedia, url, label, { Range: `bytes=0-${VIDEO_CHUNK_BYTES - 1}` }, signal);
  if (response.status !== 206) return memorySource(await readBody(response, url, label, maxBytes, signal));

  const total = Number(response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1] ?? Number.NaN);
  if (!Number.isFinite(total)) {
    await discardBody(response);
    throw new GenerationMediaReadError(`Could not read ${label} from ${urlHost(url)}: the reply has no file size`);
  }
  if (maxBytes !== undefined && total > maxBytes) {
    await discardBody(response);
    throw tooLarge(label, total, maxBytes);
  }
  const first = await readBody(response, url, label, undefined, signal);
  return {
    size: total,
    read: async (start, end) => {
      if (start === 0 && end <= first.length) return first.subarray(0, end);
      const part = await request(fetchMedia, url, label, { Range: `bytes=${start}-${end - 1}` }, signal);
      if (part.status !== 206) {
        await discardBody(part);
        throw new GenerationMediaReadError(
          `Could not read ${label} from ${urlHost(url)}: the host stopped serving ranges`,
        );
      }
      return readBody(part, url, label, undefined, signal);
    },
  };
}

async function openSource(
  fetchMedia: GenerationMediaFetch,
  block: MediaBlock,
  label: string,
  maxBytes: number | undefined,
  signal: AbortSignal,
): Promise<MediaSource> {
  if (block.source.type === "base64") {
    const bytes = Buffer.from(block.source.data, "base64");
    if (maxBytes !== undefined && bytes.length > maxBytes) throw tooLarge(label, bytes.length, maxBytes);
    return memorySource(bytes);
  }
  const { url } = block.source;
  if (block.type === "video") return openVideoSource(fetchMedia, url, label, maxBytes, signal);
  const response = await request(fetchMedia, url, label, {}, signal);
  return memorySource(await readBody(response, url, label, maxBytes, signal));
}

function readImage(bytes: Uint8Array): GenerationMediaInfo {
  try {
    const { type, width, height } = imageSize(bytes);
    return { format: type ? (IMAGE_FORMATS[type] ?? type) : undefined, bytes: bytes.length, width, height };
  } catch {
    return { format: undefined, bytes: bytes.length };
  }
}

// 按 mp4box 要求的位置继续读取，直到它解析出 moov；文件不是 MP4/MOV 时返回 undefined。
// fragmented MP4 的 moov 里没有样本，要读完所有 moof 才知道帧数和时长。
async function readMovie(source: MediaSource): Promise<Movie | undefined> {
  const file = createFile();
  let movie: Movie | undefined;
  let failed = false;
  file.onReady = (info) => {
    movie = info;
  };
  file.onError = () => {
    failed = true;
  };
  let offset = 0;
  while (!failed && offset < source.size && !(movie && !movie.isFragmented)) {
    const chunk = new Uint8Array(await source.read(offset, Math.min(offset + VIDEO_CHUNK_BYTES, source.size)));
    const last = offset + chunk.length >= source.size;
    let next: number;
    try {
      next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(chunk.buffer, offset), last);
    } catch {
      return undefined;
    }
    offset = next > offset ? next : offset + chunk.length;
  }
  return movie?.isFragmented ? file.getInfo() : movie;
}

async function readVideo(source: MediaSource): Promise<GenerationMediaInfo> {
  const movie = await readMovie(source);
  const track = movie?.videoTracks[0];
  if (!movie || !track) return { format: undefined, bytes: source.size };
  const seconds = track.samples_duration / track.timescale;
  return {
    format: movie.brands[0]?.trim() === "qt" ? "mov" : "mp4",
    bytes: source.size,
    width: track.video?.width ?? track.track_width,
    height: track.video?.height ?? track.track_height,
    ...(track.nb_samples > 0 && seconds > 0 ? { fps: track.nb_samples / seconds, duration: seconds } : {}),
  };
}

async function readAudio(bytes: Uint8Array): Promise<GenerationMediaInfo> {
  try {
    const { format } = await parseBuffer(bytes, undefined, { duration: true });
    const container = format.container?.split("/")[0]?.toLowerCase();
    const name =
      container === "wave"
        ? "wav"
        : container === "mpeg"
          ? format.codec?.endsWith("Layer 3")
            ? "mp3"
            : "mp2"
          : container;
    return { format: name, bytes: bytes.length, ...(format.duration ? { duration: format.duration } : {}) };
  } catch {
    return { format: undefined, bytes: bytes.length };
  }
}

/** Reads the format, size, dimensions, frame rate, and duration of one image, video, or audio block. */
export async function readGenerationMediaInfo(
  fetchMedia: GenerationMediaFetch,
  block: MediaBlock,
  options: { label: string; maxBytes?: number; signal: AbortSignal },
): Promise<GenerationMediaInfo> {
  const source = await openSource(fetchMedia, block, options.label, options.maxBytes, options.signal);
  if (block.type === "video") return readVideo(source);
  const bytes = await source.read(0, source.size);
  return block.type === "image" ? readImage(bytes) : readAudio(bytes);
}

function describeRange(range: GenerationRange, unit: string): string {
  if (range.min !== undefined && range.max !== undefined) {
    return `${formatNumber(range.min)}–${formatNumber(range.max)}${unit}`;
  }
  return range.min !== undefined
    ? `at least ${formatNumber(range.min)}${unit}`
    : `at most ${formatNumber(range.max ?? 0)}${unit}`;
}

function outside(range: GenerationRange | undefined, value: number): boolean {
  return !!range && ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max));
}

function fpsAdvice(range: GenerationRange): string {
  const common = [24, 30].filter((fps) => !outside(range, fps));
  return common.length > 0
    ? `re-encode it at a constant ${common.join(" or ")} fps`
    : "re-encode it at a constant frame rate within the limit";
}

type RangeCheck = {
  field: keyof GenerationMediaSpec;
  name: string;
  unit: string;
  value: number | undefined;
  advice: string;
};

function rangeChecks(spec: GenerationMediaSpec, info: GenerationMediaInfo): RangeCheck[] {
  const { width, height } = info;
  const hasSize = width !== undefined && height !== undefined && height > 0;
  return [
    { field: "width", name: "width", unit: " px", value: width, advice: "resize it" },
    { field: "height", name: "height", unit: " px", value: height, advice: "resize it" },
    {
      field: "aspectRatio",
      name: "aspect ratio (width/height)",
      unit: "",
      value: hasSize ? width / height : undefined,
      advice: "crop or pad it",
    },
    {
      field: "pixels",
      name: "pixel count (width × height)",
      unit: "",
      value: hasSize ? width * height : undefined,
      advice: "scale it",
    },
    { field: "fps", name: "frame rate", unit: " fps", value: info.fps, advice: spec.fps ? fpsAdvice(spec.fps) : "" },
    { field: "duration", name: "duration", unit: " s", value: info.duration, advice: "trim it or use a longer file" },
  ];
}

function checkMediaInfo(target: CheckTarget, info: GenerationMediaInfo): void {
  const { spec, label } = target;
  if (spec.formats && !(info.format && spec.formats.includes(info.format))) {
    const found = info.format ? `format ${info.format} is not accepted` : "the file format is not recognized";
    throw new GenerationValidationError(`${label}: ${found}; convert it to ${spec.formats.join(", ")}`);
  }
  if (spec.maxBytes !== undefined && info.bytes > spec.maxBytes) throw tooLarge(label, info.bytes, spec.maxBytes);
  for (const check of rangeChecks(spec, info)) {
    const range = spec[check.field] as GenerationRange | undefined;
    if (!range) continue;
    if (check.value === undefined) {
      throw new GenerationValidationError(`${label}: could not read the ${check.name} from the file`);
    }
    if (outside(range, check.value)) {
      throw new GenerationValidationError(
        `${label}: ${check.name} ${formatNumber(check.value)}${check.unit} is outside ${describeRange(range, check.unit)}; ${check.advice}`,
      );
    }
  }
}

function checkTotals(specs: GenerationContentSpec[], targets: CheckTarget[], infos: GenerationMediaInfo[]): void {
  for (const spec of specs) {
    const range = spec.media?.totalDuration;
    if (!range) continue;
    const total = targets.reduce(
      (sum, target, index) => (target.block.type === spec.type ? sum + (infos[index]?.duration ?? 0) : sum),
      0,
    );
    if (outside(range, total)) {
      throw new GenerationValidationError(
        `${spec.type} inputs: total duration ${formatNumber(total)} s is outside ${describeRange(range, " s")}; use fewer or shorter files`,
      );
    }
  }
}

/**
 * Reads every image, video, and audio block whose content spec declares `media`, and throws
 * GenerationValidationError when a file is outside the declared limits.
 */
export async function validateGenerationMedia(
  declaration: GenerationModelDeclaration,
  content: GenerationContentBlock[],
  fetchMedia: GenerationMediaFetch,
): Promise<void> {
  const specs = declaration.content.input.filter((spec) => spec.media);
  const targets: CheckTarget[] = content.flatMap((block, index) => {
    if (!isMediaBlock(block)) return [];
    const media = specs.find((spec) => spec.type === block.type)?.media;
    return media ? [{ block, index, spec: media, label: blockLabel(block, index) }] : [];
  });
  if (targets.length === 0) return;

  // 任何一个素材不合规就中止其余读取
  const stop = new AbortController();
  const infos: GenerationMediaInfo[] = new Array(targets.length);
  const queue = targets.entries();
  const worker = async () => {
    for (const [position, target] of queue) {
      const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
      const info = await readGenerationMediaInfo(fetchMedia, target.block, {
        label: target.label,
        ...(target.spec.maxBytes !== undefined ? { maxBytes: target.spec.maxBytes } : {}),
        signal,
      });
      checkMediaInfo(target, info);
      infos[position] = info;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, targets.length) }, worker));
  } finally {
    stop.abort();
  }
  checkTotals(specs, targets, infos);
}
