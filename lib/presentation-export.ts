import { GifWriter } from "omggif";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildMedalGroup, disposeObject3D } from "@/lib/model-builder";
import {
  HOME_PREVIEW_ROTATION_X,
  HOME_PREVIEW_ROTATION_Y,
} from "@/lib/preview-pose";
import type { ExportProgressUpdate } from "@/lib/export-worker-types";
import type { MedalSettings } from "@/lib/types";

export type PresentationMode = "flip" | "spin";
export type PresentationExportFormat = "gif" | "mov";
export type PresentationFrameRate = 15 | 24 | 30 | 50 | 60;
export type PresentationExportQuality = "draft" | "high" | "standard";

export interface PresentationSpinSpeeds {
  x: number;
  y: number;
  z: number;
}

export interface PresentationBaseExportConfig {
  durationSeconds: number;
  frameRate: PresentationFrameRate;
  mode: PresentationMode;
  quality: PresentationExportQuality;
}

export interface PresentationSpinExportConfig
  extends PresentationBaseExportConfig {
  mode: "spin";
  rotationSpeeds: PresentationSpinSpeeds;
}

export interface PresentationFlipExportConfig
  extends PresentationBaseExportConfig {
  flipSpeedDegPerSecond: number;
  flipTurns: number;
  mode: "flip";
}

export type PresentationExportConfig =
  | PresentationFlipExportConfig
  | PresentationSpinExportConfig;

export interface PresentationExportOption {
  extension: string;
  format: PresentationExportFormat;
  label: string;
  mimeType: string;
}

export interface PresentationQualityOption {
  formatScale: number;
  label: string;
  quality: PresentationExportQuality;
  size: number;
}

export interface PresentationFrameRateOption {
  fps: PresentationFrameRate;
  label: string;
}

export interface PresentationExportOptions {
  onProgress?: (progress: ExportProgressUpdate) => void;
}

interface RenderContext {
  camera: THREE.PerspectiveCamera;
  group: THREE.Group;
  height: number;
  readCanvas: OffscreenCanvas;
  readContext: OffscreenCanvasRenderingContext2D;
  renderer: THREE.WebGLRenderer;
  renderCanvas: OffscreenCanvas;
  scene: THREE.Scene;
  wrapper: THREE.Group;
  width: number;
}

type PresentationFfmpeg = InstanceType<
  (typeof import("@ffmpeg/ffmpeg"))["FFmpeg"]
>;

const GIF_TRANSPARENT_INDEX = 0;
const GIF_PALETTE_SIZE = 256;
const GIF_OPAQUE_PALETTE_SIZE = GIF_PALETTE_SIZE - 1;
const GIF_TRANSPARENT_ALPHA_THRESHOLD = 96;
const GIF_COLOR_BIN_COUNT = 32 * 32 * 32;
const DEFAULT_EXPORT_DURATION_SECONDS = 5;
const MIN_EXPORT_DURATION_SECONDS = 1;
const MAX_EXPORT_DURATION_SECONDS = 12;
const MIN_FLIP_SPEED_DEG_PER_SECOND = 30;
const FFMPEG_CORE_BASE_URL =
  "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

let presentationFfmpegPromise: Promise<PresentationFfmpeg> | null = null;

interface GifPaletteColor {
  blue: number;
  count: number;
  green: number;
  red: number;
}

interface GifPaletteBucket {
  blueMax: number;
  blueMin: number;
  colors: GifPaletteColor[];
  count: number;
  greenMax: number;
  greenMin: number;
  redMax: number;
  redMin: number;
  score: number;
}

export const DEFAULT_PRESENTATION_SPIN_SPEEDS: PresentationSpinSpeeds = {
  x: 0,
  y: 72,
  z: 0,
};

export const DEFAULT_PRESENTATION_FLIP_TURNS = 1;
export const DEFAULT_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND = 360;
export const DEFAULT_PRESENTATION_DURATION_SECONDS =
  DEFAULT_EXPORT_DURATION_SECONDS;
export const DEFAULT_PRESENTATION_FRAME_RATE: PresentationFrameRate = 24;
export const DEFAULT_PRESENTATION_QUALITY: PresentationExportQuality =
  "standard";

export const PRESENTATION_EXPORT_OPTIONS: PresentationExportOption[] = [
  {
    extension: "mov",
    format: "mov",
    label: "MOV",
    mimeType: "video/quicktime",
  },
  {
    extension: "gif",
    format: "gif",
    label: "GIF",
    mimeType: "image/gif",
  },
];

export const PRESENTATION_QUALITY_OPTIONS: PresentationQualityOption[] = [
  {
    formatScale: 1,
    label: "Draft",
    quality: "draft",
    size: 512,
  },
  {
    formatScale: 1,
    label: "Standard",
    quality: "standard",
    size: 768,
  },
  {
    formatScale: 1,
    label: "High",
    quality: "high",
    size: 1080,
  },
];

export const PRESENTATION_FRAME_RATE_OPTIONS: PresentationFrameRateOption[] = [
  {
    fps: 15,
    label: "15 fps",
  },
  {
    fps: 24,
    label: "24 fps",
  },
  {
    fps: 30,
    label: "30 fps",
  },
  {
    fps: 50,
    label: "50 fps",
  },
  {
    fps: 60,
    label: "60 fps",
  },
];

export function getPresentationExportOption(
  format: PresentationExportFormat,
): PresentationExportOption {
  const option = PRESENTATION_EXPORT_OPTIONS.find(
    (candidate) => candidate.format === format,
  );

  if (!option) {
    throw new Error(`Unsupported presentation export format: ${format}`);
  }

  return option;
}

export function getPresentationQualityOption(
  quality: PresentationExportQuality,
): PresentationQualityOption {
  return (
    PRESENTATION_QUALITY_OPTIONS.find(
      (candidate) => candidate.quality === quality,
    ) ?? PRESENTATION_QUALITY_OPTIONS[1]
  );
}

export function getPresentationFrameRateOptions(
  format: PresentationExportFormat,
) {
  return PRESENTATION_FRAME_RATE_OPTIONS.filter(
    (option) => format === "mov" || option.fps <= 50,
  );
}

export function getCompatiblePresentationFrameRate(
  format: PresentationExportFormat,
  frameRate: PresentationFrameRate,
) {
  const options = getPresentationFrameRateOptions(format);

  if (options.some((option) => option.fps === frameRate)) {
    return frameRate;
  }

  return options[options.length - 1].fps;
}

export function getPresentationRotation(
  config: PresentationExportConfig,
  elapsedSeconds: number,
) {
  if (config.mode === "spin") {
    return {
      x:
        HOME_PREVIEW_ROTATION_X +
        THREE.MathUtils.degToRad(config.rotationSpeeds.x * elapsedSeconds),
      y:
        HOME_PREVIEW_ROTATION_Y +
        THREE.MathUtils.degToRad(config.rotationSpeeds.y * elapsedSeconds),
      z: THREE.MathUtils.degToRad(config.rotationSpeeds.z * elapsedSeconds),
    };
  }

  const flipTurns = Math.max(1, Math.round(config.flipTurns));
  const speed = Math.max(
    MIN_FLIP_SPEED_DEG_PER_SECOND,
    Math.abs(config.flipSpeedDegPerSecond),
  );
  const periodSeconds = Math.max(0.1, (flipTurns * 360) / speed);
  const cycleProgress = (elapsedSeconds % periodSeconds) / periodSeconds;
  const easedProgress = easeOutCubic(cycleProgress);

  return {
    x: HOME_PREVIEW_ROTATION_X,
    y: HOME_PREVIEW_ROTATION_Y + Math.PI * 2 * flipTurns * easedProgress,
    z: 0,
  };
}

export async function exportPresentationAnimation(
  svgText: string,
  settings: MedalSettings,
  format: PresentationExportFormat,
  config: PresentationExportConfig,
  options: PresentationExportOptions = {},
): Promise<Blob> {
  const normalizedConfig = normalizePresentationConfig(config);
  const quality = getPresentationQualityOption(normalizedConfig.quality);
  const width = Math.round(quality.size * quality.formatScale);
  const height = width;
  const fps = getCompatiblePresentationFrameRate(
    format,
    normalizedConfig.frameRate,
  );
  const frameCount = Math.max(
    1,
    Math.round(normalizedConfig.durationSeconds * fps),
  );
  const context = createRenderContext(svgText, settings, width, height);

  try {
    reportExportProgress(options, 0.04, "building", "Building presentation");

    if (context.group.userData.isEmptyPlaceholder) {
      throw new Error("No exportable SVG shapes found");
    }

    if (format === "mov") {
      return await exportMov(context, normalizedConfig, frameCount, fps, options);
    }

    return exportGif(context, normalizedConfig, frameCount, fps, options);
  } finally {
    disposeRenderContext(context);
  }
}

function normalizePresentationConfig(
  config: PresentationExportConfig,
): PresentationExportConfig {
  const durationSeconds = clampNumber(
    config.durationSeconds,
    MIN_EXPORT_DURATION_SECONDS,
    MAX_EXPORT_DURATION_SECONDS,
  );
  const frameRate = normalizePresentationFrameRate(config.frameRate);
  const quality = getPresentationQualityOption(config.quality).quality;

  if (config.mode === "flip") {
    return {
      durationSeconds,
      flipSpeedDegPerSecond: clampNumber(
        Math.abs(config.flipSpeedDegPerSecond),
        MIN_FLIP_SPEED_DEG_PER_SECOND,
        1440,
      ),
      flipTurns: clampNumber(Math.round(config.flipTurns), 1, 12),
      frameRate,
      mode: "flip",
      quality,
    };
  }

  return {
    durationSeconds,
    frameRate,
    mode: "spin",
    quality,
    rotationSpeeds: {
      x: clampNumber(config.rotationSpeeds.x, -720, 720),
      y: clampNumber(config.rotationSpeeds.y, -720, 720),
      z: clampNumber(config.rotationSpeeds.z, -720, 720),
    },
  };
}

function createRenderContext(
  svgText: string,
  settings: MedalSettings,
  width: number,
  height: number,
): RenderContext {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("Presentation export requires OffscreenCanvas support");
  }

  const renderCanvas = new OffscreenCanvas(width, height);
  const readCanvas = new OffscreenCanvas(width, height);
  const readContext = readCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!readContext) {
    throw new Error("Unable to create presentation frame buffer");
  }

  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    canvas: renderCanvas,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setSize(width, height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;

  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
  camera.position.set(0, -7, 5.2);
  camera.lookAt(0, 0, 0);

  const scene = new THREE.Scene();
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const roomEnvironment = new RoomEnvironment();
  const environment = pmremGenerator.fromScene(roomEnvironment).texture;
  const wrapper = new THREE.Group();
  const group = buildMedalGroup(svgText, settings);

  wrapper.add(group);
  scene.environment = environment;
  scene.add(wrapper);
  scene.add(new THREE.AmbientLight(0xffffff, 0.62));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(4.5, -5.5, 8);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.65);
  fillLight.position.set(-5, 3, 4);
  scene.add(fillLight);

  scene.userData.presentationDisposables = {
    environment,
    pmremGenerator,
    roomEnvironment,
  };

  return {
    camera,
    group,
    height,
    readCanvas,
    readContext,
    renderer,
    renderCanvas,
    scene,
    width,
    wrapper,
  };
}

function disposeRenderContext(context: RenderContext) {
  const disposables = context.scene.userData.presentationDisposables as
    | {
        environment: THREE.Texture;
        pmremGenerator: THREE.PMREMGenerator;
        roomEnvironment: RoomEnvironment;
      }
    | undefined;

  disposeObject3D(context.group);
  context.scene.environment = null;
  context.scene.clear();
  disposables?.environment.dispose();
  disposables?.roomEnvironment.dispose();
  disposables?.pmremGenerator.dispose();
  context.renderer.dispose();
}

async function loadPresentationFfmpeg(options: PresentationExportOptions) {
  if (!presentationFfmpegPromise) {
    presentationFfmpegPromise = (async () => {
      reportExportProgress(
        options,
        0.04,
        "building",
        "Loading ProRes MOV encoder",
      );
      const { FFmpeg } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ffmpeg = new FFmpeg();
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(
          `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.js`,
          "text/javascript",
        ),
        toBlobURL(
          `${FFMPEG_CORE_BASE_URL}/ffmpeg-core.wasm`,
          "application/wasm",
        ),
      ]);
      await ffmpeg.load({
        coreURL,
        wasmURL,
      });

      return ffmpeg;
    })().catch((error) => {
      presentationFfmpegPromise = null;
      throw error;
    });
  }

  return presentationFfmpegPromise;
}

async function encodePngFrame(canvas: OffscreenCanvas) {
  if (!canvas.convertToBlob) {
    throw new Error("MOV export requires OffscreenCanvas PNG encoding support");
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

async function cleanupFfmpegFiles(
  ffmpeg: PresentationFfmpeg,
  filePaths: string[],
  workDir: string,
) {
  await Promise.all(
    filePaths.map((filePath) =>
      ffmpeg.deleteFile(filePath).catch(() => undefined),
    ),
  );
  await ffmpeg.deleteDir(workDir).catch(() => undefined);
}

async function exportMov(
  context: RenderContext,
  config: PresentationExportConfig,
  frameCount: number,
  fps: number,
  options: PresentationExportOptions,
) {
  const ffmpeg = await loadPresentationFfmpeg(options);
  const workDir = `/presentation-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const outputPath = `${workDir}/presentation.mov`;
  const framePaths: string[] = [];
  const progressHandler = ({ progress }: { progress: number }) => {
    if (Number.isFinite(progress) && progress >= 0) {
      reportExportProgress(
        options,
        0.62 + clampNumber(progress, 0, 1) * 0.32,
        "encoding",
        "Encoding ProRes MOV",
      );
    }
  };

  try {
    await ffmpeg.createDir(workDir);

    for (let index = 0; index < frameCount; index += 1) {
      renderPresentationFrame(context, config, index / fps);
      const framePath = `${workDir}/frame-${index
        .toString()
        .padStart(5, "0")}.png`;
      const frameBytes = await encodePngFrame(context.readCanvas);
      await ffmpeg.writeFile(framePath, frameBytes);
      framePaths.push(framePath);
      reportFrameProgress(
        options,
        index,
        frameCount,
        0.08,
        0.58,
        "rendering",
        "Rendering MOV frames",
      );
    }

    reportExportProgress(options, 0.62, "encoding", "Encoding ProRes MOV");
    ffmpeg.on("progress", progressHandler);
    const exitCode = await ffmpeg.exec([
      "-framerate",
      String(fps),
      "-start_number",
      "0",
      "-i",
      `${workDir}/frame-%05d.png`,
      "-frames:v",
      String(frameCount),
      "-an",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      "yuva444p10le",
      "-alpha_bits",
      "16",
      "-movflags",
      "faststart",
      outputPath,
    ]);
    ffmpeg.off("progress", progressHandler);

    if (exitCode !== 0) {
      throw new Error("ProRes MOV encoding failed");
    }

    const movie = await ffmpeg.readFile(outputPath);

    if (!(movie instanceof Uint8Array)) {
      throw new Error("ProRes MOV encoder returned invalid data");
    }

    reportExportProgress(options, 0.98, "done", "Preparing download");

    return new Blob([toBlobPart(movie)], {
      type: getPresentationExportOption("mov").mimeType,
    });
  } finally {
    ffmpeg.off("progress", progressHandler);
    await cleanupFfmpegFiles(ffmpeg, [...framePaths, outputPath], workDir);
  }
}

async function exportGif(
  context: RenderContext,
  config: PresentationExportConfig,
  frameCount: number,
  fps: number,
  options: PresentationExportOptions,
) {
  const gifBytes: number[] = [];
  const writer = new GifWriter(gifBytes, context.width, context.height, {
    loop: 0,
  });

  for (let index = 0; index < frameCount; index += 1) {
    renderPresentationFrame(context, config, index / fps);
    const imageData = context.readContext.getImageData(
      0,
      0,
      context.width,
      context.height,
    );
    const { indexes, palette } = quantizeGifFrame(imageData);
    writer.addFrame(
      0,
      0,
      context.width,
      context.height,
      indexes as unknown as number[],
      {
        delay: getGifFrameDelayHundredths(index, fps),
        disposal: 2,
        palette,
        transparent: GIF_TRANSPARENT_INDEX,
      },
    );
    reportFrameProgress(
      options,
      index,
      frameCount,
      0.08,
      0.86,
      "rendering",
      "Rendering GIF frames",
    );
  }

  reportExportProgress(options, 0.94, "encoding", "Writing GIF");
  const byteLength = writer.end();
  const bytes = Uint8Array.from(gifBytes.slice(0, byteLength));
  reportExportProgress(options, 0.98, "done", "Preparing download");

  return new Blob([bytes], {
    type: getPresentationExportOption("gif").mimeType,
  });
}

function renderPresentationFrame(
  context: RenderContext,
  config: PresentationExportConfig,
  elapsedSeconds: number,
) {
  const rotation = getPresentationRotation(config, elapsedSeconds);
  context.wrapper.rotation.set(rotation.x, rotation.y, rotation.z);
  context.renderer.clear();
  context.renderer.render(context.scene, context.camera);

  const bitmap = context.renderCanvas.transferToImageBitmap();
  context.readContext.clearRect(0, 0, context.width, context.height);
  context.readContext.drawImage(bitmap, 0, 0);
  bitmap.close();
}

function quantizeGifFrame(imageData: ImageData) {
  const histogram = buildGifColorHistogram(imageData);
  const palette = createAdaptiveGifPalette(histogram);
  const indexes = new Uint8Array(imageData.width * imageData.height);
  const binToPaletteIndex = new Uint16Array(GIF_COLOR_BIN_COUNT);
  const data = imageData.data;

  binToPaletteIndex.fill(0xffff);

  for (let offset = 0, index = 0; offset < data.length; offset += 4, index += 1) {
    const alpha = data[offset + 3];

    if (alpha < GIF_TRANSPARENT_ALPHA_THRESHOLD) {
      indexes[index] = GIF_TRANSPARENT_INDEX;
      continue;
    }

    const bin = getGifColorBin(data[offset], data[offset + 1], data[offset + 2]);
    let paletteIndex = binToPaletteIndex[bin];

    if (paletteIndex === 0xffff) {
      paletteIndex = findNearestGifPaletteIndex(
        getGifBinRed(bin),
        getGifBinGreen(bin),
        getGifBinBlue(bin),
        palette,
      );
      binToPaletteIndex[bin] = paletteIndex;
    }

    indexes[index] = paletteIndex;
  }

  return {
    indexes,
    palette,
  };
}

function buildGifColorHistogram(imageData: ImageData) {
  const counts = new Uint32Array(GIF_COLOR_BIN_COUNT);
  const redSums = new Uint32Array(GIF_COLOR_BIN_COUNT);
  const greenSums = new Uint32Array(GIF_COLOR_BIN_COUNT);
  const blueSums = new Uint32Array(GIF_COLOR_BIN_COUNT);
  const occupiedBins: number[] = [];
  const data = imageData.data;

  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = data[offset + 3];

    if (alpha < GIF_TRANSPARENT_ALPHA_THRESHOLD) {
      continue;
    }

    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const bin = getGifColorBin(red, green, blue);

    if (counts[bin] === 0) {
      occupiedBins.push(bin);
    }

    counts[bin] += 1;
    redSums[bin] += red;
    greenSums[bin] += green;
    blueSums[bin] += blue;
  }

  return occupiedBins.map((bin) => {
    const count = counts[bin];

    return {
      blue: Math.round(blueSums[bin] / count),
      count,
      green: Math.round(greenSums[bin] / count),
      red: Math.round(redSums[bin] / count),
    };
  });
}

function createAdaptiveGifPalette(colors: GifPaletteColor[]) {
  const palette = new Array<number>(GIF_PALETTE_SIZE).fill(0);

  if (colors.length === 0) {
    palette[1] = 0xffffff;
    return palette;
  }

  const buckets = splitGifPaletteBuckets(colors);

  for (let index = 0; index < buckets.length; index += 1) {
    palette[index + 1] = getGifBucketAverageColor(buckets[index]);
  }

  for (let index = buckets.length + 1; index < palette.length; index += 1) {
    palette[index] = palette[Math.max(1, buckets.length)];
  }

  return palette;
}

function splitGifPaletteBuckets(colors: GifPaletteColor[]) {
  const buckets = [createGifPaletteBucket(colors)];

  while (buckets.length < GIF_OPAQUE_PALETTE_SIZE) {
    let bucketIndex = -1;
    let bucketScore = -1;

    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];

      if (bucket.colors.length > 1 && bucket.score > bucketScore) {
        bucketIndex = index;
        bucketScore = bucket.score;
      }
    }

    if (bucketIndex === -1) {
      break;
    }

    const splitBuckets = splitGifPaletteBucket(buckets[bucketIndex]);

    if (!splitBuckets) {
      break;
    }

    buckets.splice(bucketIndex, 1, splitBuckets[0], splitBuckets[1]);
  }

  return buckets;
}

function createGifPaletteBucket(colors: GifPaletteColor[]): GifPaletteBucket {
  let redMin = 255;
  let redMax = 0;
  let greenMin = 255;
  let greenMax = 0;
  let blueMin = 255;
  let blueMax = 0;
  let count = 0;

  for (const color of colors) {
    redMin = Math.min(redMin, color.red);
    redMax = Math.max(redMax, color.red);
    greenMin = Math.min(greenMin, color.green);
    greenMax = Math.max(greenMax, color.green);
    blueMin = Math.min(blueMin, color.blue);
    blueMax = Math.max(blueMax, color.blue);
    count += color.count;
  }

  const redRange = redMax - redMin;
  const greenRange = greenMax - greenMin;
  const blueRange = blueMax - blueMin;

  return {
    blueMax,
    blueMin,
    colors,
    count,
    greenMax,
    greenMin,
    redMax,
    redMin,
    score: Math.max(redRange, greenRange, blueRange) * Math.max(1, count),
  };
}

function splitGifPaletteBucket(bucket: GifPaletteBucket) {
  const redRange = bucket.redMax - bucket.redMin;
  const greenRange = bucket.greenMax - bucket.greenMin;
  const blueRange = bucket.blueMax - bucket.blueMin;
  const channel =
    redRange >= greenRange && redRange >= blueRange
      ? "red"
      : greenRange >= blueRange
        ? "green"
        : "blue";
  const colors = bucket.colors
    .slice()
    .sort((left, right) => left[channel] - right[channel]);
  const midpoint = bucket.count / 2;
  let runningCount = 0;
  let splitIndex = 1;

  for (let index = 0; index < colors.length - 1; index += 1) {
    runningCount += colors[index].count;

    if (runningCount >= midpoint) {
      splitIndex = index + 1;
      break;
    }
  }

  if (splitIndex <= 0 || splitIndex >= colors.length) {
    splitIndex = Math.floor(colors.length / 2);
  }

  if (splitIndex <= 0 || splitIndex >= colors.length) {
    return null;
  }

  return [
    createGifPaletteBucket(colors.slice(0, splitIndex)),
    createGifPaletteBucket(colors.slice(splitIndex)),
  ] as const;
}

function getGifBucketAverageColor(bucket: GifPaletteBucket) {
  let red = 0;
  let green = 0;
  let blue = 0;

  for (const color of bucket.colors) {
    red += color.red * color.count;
    green += color.green * color.count;
    blue += color.blue * color.count;
  }

  return packRgb(
    Math.round(red / bucket.count),
    Math.round(green / bucket.count),
    Math.round(blue / bucket.count),
  );
}

function findNearestGifPaletteIndex(
  red: number,
  green: number,
  blue: number,
  palette: number[],
) {
  let bestIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let index = 1; index < palette.length; index += 1) {
    const color = palette[index];
    const paletteRed = (color >> 16) & 0xff;
    const paletteGreen = (color >> 8) & 0xff;
    const paletteBlue = color & 0xff;
    const redDelta = red - paletteRed;
    const greenDelta = green - paletteGreen;
    const blueDelta = blue - paletteBlue;
    const distance =
      redDelta * redDelta * 3 +
      greenDelta * greenDelta * 4 +
      blueDelta * blueDelta * 2;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function getGifColorBin(red: number, green: number, blue: number) {
  return ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
}

function getGifBinRed(bin: number) {
  return (((bin >> 10) & 31) << 3) + 4;
}

function getGifBinGreen(bin: number) {
  return (((bin >> 5) & 31) << 3) + 4;
}

function getGifBinBlue(bin: number) {
  return ((bin & 31) << 3) + 4;
}

function packRgb(red: number, green: number, blue: number) {
  return (red << 16) | (green << 8) | blue;
}

function reportFrameProgress(
  options: PresentationExportOptions,
  index: number,
  frameCount: number,
  start: number,
  end: number,
  stage: ExportProgressUpdate["stage"],
  status: string,
) {
  const progress = start + ((index + 1) / frameCount) * (end - start);
  reportExportProgress(
    options,
    progress,
    stage,
    `${status} ${index + 1}/${frameCount}`,
  );
}

function reportExportProgress(
  options: PresentationExportOptions,
  progress: number,
  stage: ExportProgressUpdate["stage"],
  status: string,
) {
  options.onProgress?.({
    progress,
    stage,
    status,
  });
}

function getGifFrameDelayHundredths(frameIndex: number, fps: number) {
  const frameStart = Math.round((frameIndex * 100) / fps);
  const frameEnd = Math.round(((frameIndex + 1) * 100) / fps);

  return Math.max(1, frameEnd - frameStart);
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - value, 3);
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function normalizePresentationFrameRate(value: number): PresentationFrameRate {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_PRESENTATION_FRAME_RATE;
  }

  return PRESENTATION_FRAME_RATE_OPTIONS.reduce((closest, option) =>
    Math.abs(option.fps - numericValue) < Math.abs(closest.fps - numericValue)
      ? option
      : closest,
  ).fps;
}

function toBlobPart(chunk: Uint8Array): BlobPart {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
    return chunk.buffer as ArrayBuffer;
  }

  return chunk.buffer.slice(
    chunk.byteOffset,
    chunk.byteOffset + chunk.byteLength,
  ) as ArrayBuffer;
}
