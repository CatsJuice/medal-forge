"use client";

import { FrontSide, type Material, type Object3D } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import { buildMedalGroup, disposeObject3D } from "@/lib/model-builder";
import type { MedalSettings } from "@/lib/types";

export type ModelExportFormat = "glb" | "usdz";

export interface ModelExportOption {
  format: ModelExportFormat;
  label: string;
  extension: string;
  mimeType: string;
}

export const MODEL_EXPORT_OPTIONS: ModelExportOption[] = [
  {
    format: "glb",
    label: "GLB",
    extension: "glb",
    mimeType: "model/gltf-binary",
  },
  {
    format: "usdz",
    label: "USDZ",
    extension: "usdz",
    mimeType: "model/vnd.usdz+zip",
  },
];

export function getModelExportOption(format: ModelExportFormat): ModelExportOption {
  const option = MODEL_EXPORT_OPTIONS.find((candidate) => candidate.format === format);

  if (!option) {
    throw new Error(`Unsupported model export format: ${format}`);
  }

  return option;
}

export async function exportMedalGlb(
  svgText: string,
  settings: MedalSettings,
): Promise<Blob> {
  return exportMedalModel(svgText, settings, "glb");
}

export async function exportMedalUsdz(
  svgText: string,
  settings: MedalSettings,
): Promise<Blob> {
  return exportMedalModel(svgText, settings, "usdz");
}

export async function exportMedalModel(
  svgText: string,
  settings: MedalSettings,
  format: ModelExportFormat,
): Promise<Blob> {
  const group = buildMedalGroup(svgText, settings);

  try {
    if (format === "usdz") {
      return await exportGroupUsdz(group);
    }

    return await exportGroupGlb(group);
  } finally {
    disposeObject3D(group);
  }
}

async function exportGroupGlb(group: Object3D): Promise<Blob> {
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(group, { binary: true });

  if (result instanceof ArrayBuffer) {
    return new Blob([result], {
      type: getModelExportOption("glb").mimeType,
    });
  }

  return new Blob([JSON.stringify(result, null, 2)], {
    type: "model/gltf+json",
  });
}

async function exportGroupUsdz(group: Object3D): Promise<Blob> {
  const exporter = new USDZExporter();
  const restoreMaterials = makeUsdCompatibleMaterials(group);

  try {
    const result = await exporter.parseAsync(group);

    return new Blob([result], {
      type: getModelExportOption("usdz").mimeType,
    });
  } finally {
    restoreMaterials();
  }
}

function makeUsdCompatibleMaterials(group: Object3D) {
  const restorers: Array<() => void> = [];

  group.traverse((object) => {
    const material = (object as { material?: Material | Material[] }).material;

    if (!material) {
      return;
    }

    const materials = Array.isArray(material) ? material : [material];
    for (const item of materials) {
      const originalSide = item.side;

      if (originalSide === FrontSide) {
        continue;
      }

      item.side = FrontSide;
      item.needsUpdate = true;
      restorers.push(() => {
        item.side = originalSide;
        item.needsUpdate = true;
      });
    }
  });

  return () => {
    for (const restore of restorers) {
      restore();
    }
  };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
