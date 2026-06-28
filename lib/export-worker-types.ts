import type { MedalSettings } from "@/lib/types";
import type { ModelExportFormat } from "@/lib/export-model";
import type {
  PresentationExportConfig,
  PresentationExportFormat,
} from "@/lib/presentation-export";

export type ExportProgressStage =
  | "queued"
  | "building"
  | "rendering"
  | "preparing"
  | "exporting"
  | "optimizing"
  | "encoding"
  | "done";

export interface ExportProgressUpdate {
  progress: number;
  stage: ExportProgressStage;
  status: string;
}

export interface ModelExportWorkerRequest {
  fileName: string;
  format: ModelExportFormat;
  id: string;
  kind: "model";
  settings: MedalSettings;
  svgText: string;
}

export interface PresentationExportWorkerRequest {
  config: PresentationExportConfig;
  fileName: string;
  format: PresentationExportFormat;
  id: string;
  kind: "presentation";
  settings: MedalSettings;
  svgText: string;
}

export type ExportWorkerRequest =
  | ModelExportWorkerRequest
  | PresentationExportWorkerRequest;

export interface ExportWorkerProgressMessage {
  id: string;
  progress: ExportProgressUpdate;
  type: "progress";
}

export interface ExportWorkerCompleteMessage {
  buffer: ArrayBuffer;
  id: string;
  mimeType: string;
  sizeBytes: number;
  type: "complete";
}

export interface ExportWorkerErrorMessage {
  error: string;
  id: string;
  type: "error";
}

export type ExportWorkerMessage =
  | ExportWorkerCompleteMessage
  | ExportWorkerErrorMessage
  | ExportWorkerProgressMessage;
