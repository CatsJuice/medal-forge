export type MaterialId =
  | "brushedGold"
  | "agedSilver"
  | "blackenedSteel"
  | "copper"
  | "whiteCeramic"
  | "mattePolymer";

export type ShapeWindingMode = "svg" | "solidCw" | "solidCcw";

export interface CanvasSettings {
  backgroundColor: string;
  showGrid: boolean;
  showShadows: boolean;
}

export interface DomeSettings {
  enabled: boolean;
  depth: number;
  radius: number;
  segments: number;
}

export interface ModelQualitySettings {
  bevelSegments: number;
  curvePrecision: number;
  curveSegments: number;
}

export interface ShapeSvgAdjustments {
  circleRadius?: number;
  rectWidth?: number;
  rectHeight?: number;
  rectCornerRadius?: number;
}

export interface ShapeSettings {
  name?: string;
  thickness: number;
  bevel: number;
  material: MaterialId;
  color: string;
  curveSegments: number;
  bevelSegments: number;
  depthSteps: number;
  zOffset: number;
  visible: boolean;
  deleted: boolean;
  windingMode: ShapeWindingMode;
  svgAdjustments: ShapeSvgAdjustments;
}

export type ShapeSettingsPatch = Partial<ShapeSettings>;

export interface MedalSettings {
  modelSize: number;
  canvas: CanvasSettings;
  dome: DomeSettings;
  quality: ModelQualitySettings;
  shapeSettings: Record<string, ShapeSettingsPatch>;
}

export type WorkDocumentKind = "com.medal-forge.work";
export type WorkAssetKind = "source-svg";
export type WorkAssetEncoding = "utf-8";

export interface WorkSvgAsset {
  id: string;
  kind: WorkAssetKind;
  mediaType: "image/svg+xml";
  encoding: WorkAssetEncoding;
  fileName: string;
  text: string;
  byteLength: number;
  importedAt: string;
}

export interface WorkSnapshot {
  id: string;
  kind: "model-front-png";
  mediaType: "image/png";
  width: number;
  height: number;
  dataUrl: string;
  sourceSignature: string;
  createdAt: string;
}

export interface WorkDocumentV1 {
  kind: WorkDocumentKind;
  schemaVersion: 1;
  compatibility: {
    minReaderSchemaVersion: 1;
  };
  app: {
    name: "Medal Forge";
    version: string;
  };
  document: {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  source: {
    primaryAssetId: string;
    assets: WorkSvgAsset[];
  };
  scene: {
    unit: "scene-unit";
    settings: MedalSettings;
  };
  preview: {
    snapshot: WorkSnapshot | null;
  };
  editorState: {
    selectedPathIndexes: number[];
  };
}

export type WorkDocument = WorkDocumentV1;

export interface SavedWorkSummary {
  id: string;
  title: string;
  sourceFileName: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: WorkDocument["schemaVersion"];
  snapshotDataUrl: string | null;
}

export interface MaterialPreset {
  id: MaterialId;
  name: string;
  color: string;
  metalness: number;
  roughness: number;
  previewSrc: string;
}

export interface SvgPathSummary {
  pathIndex: number;
  name: string;
  tagName: string;
  attributes: Record<string, string>;
  fill: string;
  stroke: string;
  d: string;
}
