import type { MedalSettings } from "@/lib/types";
import type { ModelExportFormat } from "@/lib/export-model";

export type ExportProgressStage =
  | "queued"
  | "building"
  | "preparing"
  | "exporting"
  | "optimizing"
  | "done";

export interface ExportProgressUpdate {
  progress: number;
  stage: ExportProgressStage;
  status: string;
}

export interface ExportWorkerRequest {
  fileName: string;
  format: ModelExportFormat;
  id: string;
  settings: MedalSettings;
  svgText: string;
}

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
