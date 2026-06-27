"use client";

import {
  BufferAttribute,
  BufferGeometry,
  FrontSide,
  Group,
  type InterleavedBufferAttribute,
  Mesh,
  type Material,
  type Object3D,
  Vector3,
} from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";
import {
  strFromU8,
  strToU8,
  unzipSync,
  zipSync,
} from "three/examples/jsm/libs/fflate.module.js";
import { buildMedalGroup, disposeObject3D } from "@/lib/model-builder";
import type { MedalSettings } from "@/lib/types";

type GeometryAttribute = BufferAttribute | InterleavedBufferAttribute;
type UsdSurfaceKind = "front" | "back" | "side";
type UsdZipEntry = Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }];

const USD_GEOMETRY_FLOAT_PRECISION = 4;
const USDA_FLOAT_PATTERN =
  /(^|[^\w.])([-+]?(?:\d+\.\d*|\.\d+)(?:e[-+]?\d+)?|[-+]?\d+e[-+]?\d+)/gi;
const USDA_COMMA_WHITESPACE_PATTERN = /,\s+/g;

interface UsdSurfaceBucket {
  geometry: BufferGeometry;
  material: Material;
  name: string;
}

interface UsdSurfaceBuildBucket {
  attributes: Map<string, number[]>;
  material: Material;
  name: string;
}

interface UsdLayer {
  meshes: Mesh[];
  currentBottom: number;
  layerKey: string;
  order: number;
}

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
    const optimizedResult = optimizeUsdGeometryPrecision(result);

    return new Blob([optimizedResult], {
      type: getModelExportOption("usdz").mimeType,
    });
  } finally {
    restoreForUsd();
  }
}

function optimizeUsdGeometryPrecision(result: ArrayBuffer | Uint8Array) {
  const files = unzipSync(
    result instanceof Uint8Array ? result : new Uint8Array(result),
  );
  let hasOptimizedGeometry = false;

  for (const [filename, data] of Object.entries(files)) {
    if (!filename.startsWith("geometries/") || !filename.endsWith(".usda")) {
      continue;
    }

    const text = strFromU8(data);
    const optimizedText = optimizeUsdaGeometryText(text);

    if (optimizedText === text) {
      continue;
    }

    files[filename] = strToU8(optimizedText);
    hasOptimizedGeometry = true;
  }

  if (!hasOptimizedGeometry) {
    return result instanceof Uint8Array ? getArrayBuffer(result) : result;
  }

  return getArrayBuffer(zipUsdFiles(files));
}

function optimizeUsdaGeometryText(text: string) {
  return quantizeUsdaFloatText(text).replace(USDA_COMMA_WHITESPACE_PATTERN, ",");
}

function quantizeUsdaFloatText(text: string) {
  return text.replace(
    USDA_FLOAT_PATTERN,
    (match, prefix: string, value: string, offset: number) => {
      const valueOffset = offset + prefix.length;

      if (text.slice(Math.max(0, valueOffset - 6), valueOffset) === "#usda ") {
        return match;
      }

      const numericValue = Number(value);

      if (!Number.isFinite(numericValue)) {
        return match;
      }

      return `${prefix}${Number(
        numericValue.toPrecision(USD_GEOMETRY_FLOAT_PRECISION),
      ).toString()}`;
    },
  );
}

function zipUsdFiles(sourceFiles: Record<string, Uint8Array>) {
  const files: Record<string, UsdZipEntry> = { ...sourceFiles };
  let offset = 0;

  for (const filename in files) {
    const fileEntry = files[filename];
    const file = Array.isArray(fileEntry) ? fileEntry[0] : fileEntry;
    const headerSize = 34 + filename.length;

    offset += headerSize;

    const offsetMod64 = offset & 63;

    if (offsetMod64 !== 4) {
      files[filename] = [
        file,
        { extra: { 12345: new Uint8Array(64 - offsetMod64) } },
      ];
    }

    offset = file.length;
  }

  return zipSync(files, { level: 0 });
}

function getArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function makeUsdCompatibleMeshes(group: Object3D) {
  const restorers: Array<() => void> = [];
  const disposableGeometries: BufferGeometry[] = [];
  const disposableMaterials = new Set<Material>();
  const materialClones = new Map<Material, Material>();
  const meshes: Mesh[] = [];

  group.updateMatrixWorld(true);

  group.traverse((object) => {
    if (object instanceof Mesh) {
      meshes.push(object);
    }
  });

  const includeBackByMesh = createUsdBackfaceInclusion(meshes);

  for (const mesh of meshes) {
    if (!mesh.visible || !mesh.parent) {
      continue;
    }

    const surfaceBuckets = createUsdSurfaceBuckets(
      mesh,
      includeBackByMesh.get(mesh) ?? true,
      (material) => {
        const existing = materialClones.get(material);

        if (existing) {
          return existing;
        }

        const clone = material.clone();
        clone.side = FrontSide;
        clone.needsUpdate = true;
        materialClones.set(material, clone);
        disposableMaterials.add(clone);

        return clone;
      },
    );

    if (surfaceBuckets.length === 0) {
      continue;
    }

    mesh.updateMatrix();

    const originalVisible = mesh.visible;
    const surfaceGroup = new Group();
    surfaceGroup.name = `${mesh.name || "mesh"} USDZ surfaces`;
    surfaceGroup.matrix.copy(mesh.matrix);
    surfaceGroup.matrixAutoUpdate = false;

    for (const bucket of surfaceBuckets) {
      const surfaceMesh = new Mesh(bucket.geometry, bucket.material);
      surfaceMesh.name = bucket.name;
      surfaceMesh.castShadow = mesh.castShadow;
      surfaceMesh.receiveShadow = mesh.receiveShadow;
      surfaceMesh.renderOrder = mesh.renderOrder;
      surfaceMesh.userData = { ...mesh.userData };
      surfaceGroup.add(surfaceMesh);
      disposableGeometries.push(bucket.geometry);
    }

    mesh.visible = false;
    mesh.parent.add(surfaceGroup);

    restorers.push(() => {
      mesh.visible = originalVisible;
      surfaceGroup.removeFromParent();
    });
  }

  group.updateMatrixWorld(true);

  return () => {
    for (let index = restorers.length - 1; index >= 0; index -= 1) {
      restorers[index]();
    }

    for (const geometry of disposableGeometries) {
      geometry.dispose();
    }

    for (const material of disposableMaterials) {
      material.dispose();
    }
  };
}

function createUsdBackfaceInclusion(meshes: Mesh[]) {
  const layerMap = new Map<string, UsdLayer>();
  const includeBackByMesh = new Map<Mesh, boolean>();

  meshes.forEach((mesh, index) => {
    if (!mesh.visible || !mesh.parent) {
      return;
    }

    mesh.updateMatrix();

    const bounds = getGeometryZBounds(mesh.geometry);
    const positionZ = mesh.matrix.elements[14];
    const layerKey = getMeshLayerKey(mesh, index);
    const currentBottom = positionZ + bounds.min;
    const existing = layerMap.get(layerKey);

    if (existing) {
      existing.meshes.push(mesh);
      existing.currentBottom = Math.min(existing.currentBottom, currentBottom);
      return;
    }

    layerMap.set(layerKey, {
      meshes: [mesh],
      currentBottom,
      layerKey,
      order: getMeshLayerOrder(mesh, index),
    });
  });

  const layers = Array.from(layerMap.values()).sort(
    (left, right) =>
      left.currentBottom - right.currentBottom ||
      left.order - right.order ||
      left.layerKey.localeCompare(right.layerKey),
  );

  layers.forEach((layer, layerIndex) => {
    layer.meshes.forEach((mesh) => {
      includeBackByMesh.set(mesh, layerIndex === 0);
    });
  });

  return includeBackByMesh;
}

function getMeshLayerKey(mesh: Mesh, index: number) {
  const pathIndex = mesh.userData.pathIndex;

  return Number.isFinite(pathIndex) ? `path:${pathIndex}` : `mesh:${index}`;
}

function getMeshLayerOrder(mesh: Mesh, index: number) {
  const pathIndex = mesh.userData.pathIndex;

  return Number.isFinite(pathIndex) ? Number(pathIndex) : index;
}

function getGeometryZBounds(geometry: BufferGeometry) {
  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }

  return {
    min: geometry.boundingBox?.min.z ?? 0,
    max: geometry.boundingBox?.max.z ?? 0,
  };
}

function createUsdSurfaceBuckets(
  mesh: Mesh,
  includeBack: boolean,
  getUsdMaterial: (material: Material) => Material,
): UsdSurfaceBucket[] {
  const source = mesh.geometry.index
    ? mesh.geometry.toNonIndexed()
    : mesh.geometry.clone();

  if (!source.getAttribute("normal")) {
    source.computeVertexNormals();
  }

  const position = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  const buckets = new Map<string, UsdSurfaceBuildBucket>();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const zBounds = getGeometryZBounds(source);

  for (let triangle = 0; triangle < position.count; triangle += 3) {
    const materialIndex = getTriangleMaterialIndex(source, triangle);
    const sourceMaterial = materials[materialIndex] ?? materials[0];

    if (!sourceMaterial) {
      continue;
    }

    const surface = classifyTriangleSurface(
      position,
      normal,
      triangle,
      materialIndex,
      zBounds,
    );

    if (surface === "back" && !includeBack) {
      continue;
    }

    const bucket = getSurfaceBuildBucket(
      buckets,
      `${surface}:${sourceMaterial.uuid}`,
      `${mesh.name || "mesh"} ${surface}`,
      getUsdMaterial(sourceMaterial),
    );

    appendTriangleToBucket(bucket, source, triangle, surface, false);

    if (surface === "side") {
      appendTriangleToBucket(bucket, source, triangle, surface, true);
    }
  }

  const surfaceBuckets = Array.from(buckets.values()).map((bucket) => ({
    geometry: createGeometryFromBucket(bucket, source),
    material: bucket.material,
    name: bucket.name,
  }));

  source.dispose();

  return surfaceBuckets;
}

function getTriangleMaterialIndex(geometry: BufferGeometry, triangle: number) {
  for (const group of geometry.groups) {
    if (triangle >= group.start && triangle < group.start + group.count) {
      return group.materialIndex ?? 0;
    }
  }

  return 0;
}

function classifyTriangleSurface(
  position: GeometryAttribute,
  normal: GeometryAttribute,
  triangle: number,
  materialIndex: number,
  zBounds: { min: number; max: number },
): UsdSurfaceKind {
  if (materialIndex > 0) {
    return "side";
  }

  const z0 = position.getComponent(triangle, 2);
  const z1 = position.getComponent(triangle + 1, 2);
  const z2 = position.getComponent(triangle + 2, 2);
  const triangleDepth = Math.max(z0, z1, z2) - Math.min(z0, z1, z2);

  if (triangleDepth < 0.0001) {
    const averageZ = (z0 + z1 + z2) / 3;
    const centerZ = (zBounds.min + zBounds.max) / 2;

    return averageZ >= centerZ ? "front" : "back";
  }

  const averageNormal = getAverageNormal(normal, triangle);

  if (Math.abs(averageNormal.z) < 0.92) {
    return "side";
  }

  if (Math.abs(averageNormal.z) >= 0.45) {
    return averageNormal.z >= 0 ? "front" : "back";
  }

  return "side";
}

function getAverageNormal(normal: GeometryAttribute, triangle: number) {
  return new Vector3(
    normal.getComponent(triangle, 0) +
      normal.getComponent(triangle + 1, 0) +
      normal.getComponent(triangle + 2, 0),
    normal.getComponent(triangle, 1) +
      normal.getComponent(triangle + 1, 1) +
      normal.getComponent(triangle + 2, 1),
    normal.getComponent(triangle, 2) +
      normal.getComponent(triangle + 1, 2) +
      normal.getComponent(triangle + 2, 2),
  ).normalize();
}

function getSurfaceBuildBucket(
  buckets: Map<string, UsdSurfaceBuildBucket>,
  key: string,
  name: string,
  material: Material,
) {
  const existing = buckets.get(key);

  if (existing) {
    return existing;
  }

  const bucket = {
    attributes: new Map<string, number[]>(),
    material,
    name,
  };
  buckets.set(key, bucket);

  return bucket;
}

function appendTriangleToBucket(
  bucket: UsdSurfaceBuildBucket,
  source: BufferGeometry,
  triangle: number,
  surface: UsdSurfaceKind,
  reversed: boolean,
) {
  const { normalMultiplier, order } = getTriangleExportOrientation(
    source,
    triangle,
    surface,
    reversed,
  );

  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name);
    let target = bucket.attributes.get(name);

    if (!target) {
      target = [];
      bucket.attributes.set(name, target);
    }

    for (const vertex of order) {
      appendAttributeItem(
        attribute,
        target,
        vertex,
        name === "normal" ? normalMultiplier : 1,
      );
    }
  }
}

function getTriangleExportOrientation(
  geometry: BufferGeometry,
  triangle: number,
  surface: UsdSurfaceKind,
  reversed: boolean,
) {
  if (surface === "front" || surface === "back") {
    return getCapTriangleExportOrientation(geometry, triangle, surface);
  }

  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const faceNormal = getFaceNormal(position, triangle);
  const averageNormal = getAverageNormal(normal, triangle);
  const forwardOrder =
    faceNormal.dot(averageNormal) >= 0
      ? [triangle, triangle + 1, triangle + 2]
      : [triangle, triangle + 2, triangle + 1];

  return {
    normalMultiplier: reversed ? -1 : 1,
    order: reversed ? [...forwardOrder].reverse() : forwardOrder,
  };
}

function getCapTriangleExportOrientation(
  geometry: BufferGeometry,
  triangle: number,
  surface: Exclude<UsdSurfaceKind, "side">,
) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const desiredNormalZ = surface === "front" ? 1 : -1;
  const faceNormal = getFaceNormal(position, triangle);
  const averageNormal = getAverageNormal(normal, triangle);
  const shouldReverseOrder = faceNormal.z * desiredNormalZ < 0;
  const shouldFlipNormal = averageNormal.z * desiredNormalZ < 0;

  return {
    normalMultiplier: shouldFlipNormal ? -1 : 1,
    order: shouldReverseOrder
      ? [triangle, triangle + 2, triangle + 1]
      : [triangle, triangle + 1, triangle + 2],
  };
}

function getFaceNormal(position: GeometryAttribute, triangle: number) {
  const a = getPosition(position, triangle);
  const b = getPosition(position, triangle + 1);
  const c = getPosition(position, triangle + 2);

  return b.sub(a).cross(c.sub(a)).normalize();
}

function getPosition(position: GeometryAttribute, vertex: number) {
  return new Vector3(
    position.getComponent(vertex, 0),
    position.getComponent(vertex, 1),
    position.getComponent(vertex, 2),
  );
}

function createGeometryFromBucket(
  bucket: UsdSurfaceBuildBucket,
  source: BufferGeometry,
) {
  const geometry = new BufferGeometry();

  for (const name of Object.keys(source.attributes)) {
    const values = bucket.attributes.get(name);

    if (!values) {
      continue;
    }

    const sourceAttribute = source.getAttribute(name);
    geometry.setAttribute(
      name,
      new BufferAttribute(
        new Float32Array(values),
        sourceAttribute.itemSize,
        sourceAttribute.normalized,
      ),
    );
  }

  geometry.name = bucket.name;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function appendAttributeItem(
  attribute: GeometryAttribute,
  target: number[],
  sourceVertex: number,
  multiplier: number,
) {
  for (let itemIndex = 0; itemIndex < attribute.itemSize; itemIndex += 1) {
    target.push(attribute.getComponent(sourceVertex, itemIndex) * multiplier);
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
