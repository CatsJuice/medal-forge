import type {
  MedalSettings,
  ModelQualitySettings,
  WorkDocument,
  WorkSnapshot,
  WorkSvgAsset,
} from "@/lib/types";
import { DEFAULT_SETTINGS } from "@/lib/defaults";

export const WORK_DOCUMENT_SCHEMA_VERSION = 1;
export const WORK_DOCUMENT_KIND = "com.medal-forge.work";
export const WORK_APP_VERSION = "0.1.0";

interface CreateWorkDocumentInput {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  fileName: string;
  svgText: string;
  settings: MedalSettings;
  selectedPathIndexes: number[];
  snapshot?: WorkSnapshot | null;
}

export interface WorkPayloadSignatureInput {
  title: string;
  fileName: string;
  svgText: string;
  settings: MedalSettings;
  selectedPathIndexes: number[];
}

export interface WorkSnapshotSignatureInput {
  svgText: string;
  settings: MedalSettings;
}

function getByteLength(value: string) {
  return new TextEncoder().encode(value).length;
}

export function createWorkId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `work_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

export function getPrimarySvgAsset(document: WorkDocument): WorkSvgAsset {
  const asset =
    document.source.assets.find(
      (item) => item.id === document.source.primaryAssetId,
    ) ?? document.source.assets[0];

  if (!asset) {
    throw new Error("Work document has no SVG source asset");
  }

  return asset;
}

export function createWorkDocument({
  id,
  title,
  createdAt,
  updatedAt,
  fileName,
  svgText,
  settings,
  selectedPathIndexes,
  snapshot = null,
}: CreateWorkDocumentInput): WorkDocument {
  const assetId = "asset_source_svg";
  const normalizedSettings = normalizeMedalSettings(settings);

  return {
    kind: WORK_DOCUMENT_KIND,
    schemaVersion: WORK_DOCUMENT_SCHEMA_VERSION,
    compatibility: {
      minReaderSchemaVersion: 1,
    },
    app: {
      name: "Medal Forge",
      version: WORK_APP_VERSION,
    },
    document: {
      id,
      title,
      createdAt,
      updatedAt,
    },
    source: {
      primaryAssetId: assetId,
      assets: [
        {
          id: assetId,
          kind: "source-svg",
          mediaType: "image/svg+xml",
          encoding: "utf-8",
          fileName,
          text: svgText,
          byteLength: getByteLength(svgText),
          importedAt: createdAt,
        },
      ],
    },
    scene: {
      unit: "scene-unit",
      settings: normalizedSettings,
    },
    preview: {
      snapshot,
    },
    editorState: {
      selectedPathIndexes,
    },
  };
}

export function createWorkPayloadSignature({
  title,
  fileName,
  svgText,
  settings,
  selectedPathIndexes,
}: WorkPayloadSignatureInput) {
  return JSON.stringify({
    document: {
      title,
    },
    source: {
      fileName,
      svgText,
    },
    scene: {
      settings,
    },
    editorState: {
      selectedPathIndexes,
    },
  });
}

export function createWorkSnapshotSourceSignature({
  svgText,
  settings,
}: WorkSnapshotSignatureInput) {
  return JSON.stringify({
    source: {
      svgText,
    },
    scene: {
      settings,
    },
  });
}

export function isWorkDocument(value: unknown): value is WorkDocument {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<WorkDocument>;
  const assets = candidate.source?.assets;
  const primaryAsset = assets?.find(
    (asset) => asset.id === candidate.source?.primaryAssetId,
  );
  const settings = candidate.scene?.settings;

  return (
    candidate.kind === WORK_DOCUMENT_KIND &&
    candidate.schemaVersion === WORK_DOCUMENT_SCHEMA_VERSION &&
    typeof candidate.compatibility?.minReaderSchemaVersion === "number" &&
    candidate.app?.name === "Medal Forge" &&
    typeof candidate.app?.version === "string" &&
    typeof candidate.document?.id === "string" &&
    typeof candidate.document.title === "string" &&
    typeof candidate.document.createdAt === "string" &&
    typeof candidate.document.updatedAt === "string" &&
    typeof candidate.source?.primaryAssetId === "string" &&
    Array.isArray(assets) &&
    assets.length > 0 &&
    Boolean(primaryAsset) &&
    assets.every(isWorkSvgAsset) &&
    candidate.scene?.unit === "scene-unit" &&
    isMedalSettings(settings) &&
    (candidate.preview === undefined ||
      (typeof candidate.preview === "object" &&
        candidate.preview !== null &&
        (candidate.preview.snapshot === null ||
          isWorkSnapshot(candidate.preview.snapshot)))) &&
    Array.isArray(candidate.editorState?.selectedPathIndexes) &&
    candidate.editorState.selectedPathIndexes.every(
      (pathIndex) => typeof pathIndex === "number",
    )
  );
}

export function normalizeWorkDocument(document: WorkDocument): WorkDocument {
  return {
    ...document,
    scene: {
      ...document.scene,
      settings: normalizeMedalSettings(document.scene.settings),
    },
    preview: document.preview ?? {
      snapshot: null,
    },
  };
}

export function normalizeMedalSettings(settings: MedalSettings): MedalSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    canvas: {
      ...DEFAULT_SETTINGS.canvas,
      ...settings.canvas,
    },
    dome: {
      ...DEFAULT_SETTINGS.dome,
      ...settings.dome,
    },
    quality: normalizeModelQualitySettings(settings),
    shapeSettings: settings.shapeSettings ?? {},
  };
}

function normalizeModelQualitySettings(
  settings: MedalSettings,
): ModelQualitySettings {
  const legacyExport = (
    settings as MedalSettings & {
      export?: {
        usdzBevelSegments?: number;
        usdzCurvePrecision?: number;
        usdzCurveSegments?: number;
      };
    }
  ).export;

  return {
    ...DEFAULT_SETTINGS.quality,
    bevelSegments:
      legacyExport?.usdzBevelSegments ??
      settings.quality?.bevelSegments ??
      DEFAULT_SETTINGS.quality.bevelSegments,
    curvePrecision:
      legacyExport?.usdzCurvePrecision ??
      settings.quality?.curvePrecision ??
      DEFAULT_SETTINGS.quality.curvePrecision,
    curveSegments:
      legacyExport?.usdzCurveSegments ??
      settings.quality?.curveSegments ??
      DEFAULT_SETTINGS.quality.curveSegments,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isWorkSvgAsset(value: unknown): value is WorkSvgAsset {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.kind === "source-svg" &&
    value.mediaType === "image/svg+xml" &&
    value.encoding === "utf-8" &&
    typeof value.fileName === "string" &&
    typeof value.text === "string" &&
    typeof value.byteLength === "number" &&
    typeof value.importedAt === "string"
  );
}

function isWorkSnapshot(value: unknown): value is WorkSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    value.kind === "model-front-png" &&
    value.mediaType === "image/png" &&
    typeof value.width === "number" &&
    typeof value.height === "number" &&
    typeof value.dataUrl === "string" &&
    typeof value.sourceSignature === "string" &&
    typeof value.createdAt === "string"
  );
}

function isMedalSettings(value: unknown): value is MedalSettings {
  if (!isRecord(value)) {
    return false;
  }

  const canvas = value.canvas;
  const dome = value.dome;
  const quality = value.quality;
  const legacyExport = value.export;

  return (
    typeof value.modelSize === "number" &&
    isRecord(canvas) &&
    typeof canvas.backgroundColor === "string" &&
    typeof canvas.showGrid === "boolean" &&
    typeof canvas.showShadows === "boolean" &&
    (dome === undefined ||
      (isRecord(dome) &&
        typeof dome.enabled === "boolean" &&
        typeof dome.depth === "number" &&
        typeof dome.radius === "number" &&
        typeof dome.segments === "number")) &&
    (quality === undefined ||
      (isRecord(quality) &&
        typeof quality.bevelSegments === "number" &&
        typeof quality.curvePrecision === "number" &&
        typeof quality.curveSegments === "number")) &&
    (legacyExport === undefined ||
      (isRecord(legacyExport) &&
        typeof legacyExport.usdzBevelSegments === "number" &&
        typeof legacyExport.usdzCurvePrecision === "number" &&
        typeof legacyExport.usdzCurveSegments === "number")) &&
    isRecord(value.shapeSettings)
  );
}
