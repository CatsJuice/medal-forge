"use client";

import {
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  type InterleavedBufferAttribute,
  Mesh,
  type Material,
  type Object3D,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import { buildMedalGroup, disposeObject3D } from "@/lib/model-builder";
import type { MedalSettings } from "@/lib/types";

type GeometryAttribute = BufferAttribute | InterleavedBufferAttribute;

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
  const restoreForUsd = makeUsdCompatibleMeshes(group);

  try {
    const result = await exporter.parseAsync(group);

    return new Blob([result], {
      type: getModelExportOption("usdz").mimeType,
    });
  } finally {
    restoreForUsd();
  }
}

function makeUsdCompatibleMeshes(group: Object3D) {
  const restorers: Array<() => void> = [];

  group.traverse((object) => {
    if (!(object instanceof Mesh)) {
      return;
    }

    const material = object.material;

    if (!material) {
      return;
    }

    const materials = Array.isArray(material) ? material : [material];
    const needsBakedDoubleSidedGeometry = materials.some(
      (item) => item.side !== FrontSide,
    );

    if (needsBakedDoubleSidedGeometry) {
      const originalGeometry = object.geometry;
      const doubleSidedGeometry = createDoubleSidedGeometry(originalGeometry);

      object.geometry = doubleSidedGeometry;
      restorers.push(() => {
        object.geometry = originalGeometry;
        doubleSidedGeometry.dispose();
      });
    }

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

function createDoubleSidedGeometry(geometry: BufferGeometry) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const result = new BufferGeometry();
  const vertexCount = source.getAttribute("position").count;

  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name);
    const itemSize = attribute.itemSize;
    const array = new (attribute.array.constructor as {
      new (length: number): typeof attribute.array;
    })(vertexCount * itemSize * 2);

    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      copyAttributeItem(attribute, array, vertex, vertex, 1);
    }

    for (let triangle = 0; triangle < vertexCount; triangle += 3) {
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceVertex = triangle + (2 - corner);
        const targetVertex = vertexCount + triangle + corner;
        const multiplier = name === "normal" ? -1 : 1;

        copyAttributeItem(attribute, array, targetVertex, sourceVertex, multiplier);
      }
    }

    result.setAttribute(
      name,
      new BufferAttribute(array, itemSize, attribute.normalized),
    );
  }

  result.name = geometry.name;
  result.computeBoundingBox();
  result.computeBoundingSphere();
  source.dispose();

  return result;
}

function copyAttributeItem(
  attribute: GeometryAttribute,
  targetArray: BufferAttribute["array"],
  targetVertex: number,
  sourceVertex: number,
  multiplier: number,
) {
  const targetOffset = targetVertex * attribute.itemSize;

  for (let itemIndex = 0; itemIndex < attribute.itemSize; itemIndex += 1) {
    targetArray[targetOffset + itemIndex] =
      attribute.getComponent(sourceVertex, itemIndex) * multiplier;
  }
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
