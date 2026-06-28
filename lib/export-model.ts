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
import {
  buildMedalGroup,
  disposeObject3D,
} from "@/lib/model-builder";
import type { ExportProgressUpdate } from "@/lib/export-worker-types";
import type { MedalSettings } from "@/lib/types";

type GeometryAttribute = BufferAttribute | InterleavedBufferAttribute;
type UsdSurfaceKind = "front" | "back" | "side";
type UsdZipEntry = Uint8Array | [Uint8Array, { extra: Record<number, Uint8Array> }];
type OpenUsdPxr = {
  FS: {
    deleteFile: (path: string) => void;
    mkdirp: (path: string) => void;
    readFile: (path: string) => unknown;
  };
  Sdf: {
    Layer: {
      CreateAnonymous: (name: string) => {
        delete?: () => void;
        Export: (path: string) => boolean;
        ImportFromString: (text: string) => boolean;
      };
    };
  };
};

const USD_GEOMETRY_FLOAT_PRECISION = 4;
const USD_VERTEX_KEY_FLOAT_PRECISION = 6;
const USDA_FLOAT_PATTERN =
  /(^|[^\w.])([-+]?(?:\d+\.\d*|\.\d+)(?:e[-+]?\d+)?|[-+]?\d+e[-+]?\d+)/gi;
const USDA_COMMA_WHITESPACE_PATTERN = /,\s+/g;
const USD_GEOMETRY_REFERENCE_PATTERN =
  /@\.\/geometries\/([^@]+)\.usda@/g;
const OPENUSD_CORE_SCRIPT_PATH = "/openusd/openusd_pxr_wasm.js";
const OPENUSD_CORE_WASM_PATH = "/openusd/openusd_pxr_wasm.wasm";
const TEXTURE_MATERIAL_KEYS = [
  "alphaMap",
  "aoMap",
  "bumpMap",
  "displacementMap",
  "emissiveMap",
  "envMap",
  "lightMap",
  "map",
  "metalnessMap",
  "normalMap",
  "roughnessMap",
  "specularColorMap",
  "specularIntensityMap",
] as const;

interface UsdSurfaceBucket {
  geometry: BufferGeometry;
  material: Material;
  name: string;
}

interface UsdSurfaceBuildBucket {
  attributes: Map<string, number[]>;
  indices: number[];
  material: Material;
  name: string;
  vertexKeys: Map<string, number>;
}

interface UsdLayer {
  meshes: Mesh[];
  currentBottom: number;
  layerKey: string;
  order: number;
}

interface UsdSurfaceBucketOptions {
  includeUvs: boolean;
}

type TextureBearingMaterial = Material &
  Partial<Record<(typeof TEXTURE_MATERIAL_KEYS)[number], unknown>>;

let openUsdPxrPromise: Promise<OpenUsdPxr> | null = null;

export type ModelExportFormat = "glb" | "usdz";

export interface ModelExportOption {
  format: ModelExportFormat;
  label: string;
  extension: string;
  mimeType: string;
}

export interface ModelExportOptions {
  onProgress?: (progress: ExportProgressUpdate) => void;
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
  options: ModelExportOptions = {},
): Promise<Blob> {
  reportExportProgress(options, 0.04, "building", "Building mesh");
  const group = buildMedalGroup(svgText, settings);

  try {
    if (group.userData.isEmptyPlaceholder) {
      throw new Error("No exportable SVG shapes found");
    }

    if (format === "usdz") {
      return await exportGroupUsdz(group, options);
    }

    return await exportGroupGlb(group, options);
  } finally {
    disposeObject3D(group);
  }
}

async function exportGroupGlb(
  group: Object3D,
  options: ModelExportOptions,
): Promise<Blob> {
  const exporter = new GLTFExporter();
  reportExportProgress(options, 0.22, "exporting", "Writing GLB");
  const result = await exporter.parseAsync(group, { binary: true });
  reportExportProgress(options, 0.92, "done", "Preparing download");

  if (result instanceof ArrayBuffer) {
    return new Blob([result], {
      type: getModelExportOption("glb").mimeType,
    });
  }

  return new Blob([JSON.stringify(result, null, 2)], {
    type: "model/gltf+json",
  });
}

async function exportGroupUsdz(
  group: Object3D,
  options: ModelExportOptions,
): Promise<Blob> {
  const exporter = new USDZExporter();
  reportExportProgress(options, 0.12, "preparing", "Preparing USDZ surfaces");
  const restoreForUsd = makeUsdCompatibleMeshes(group);

  try {
    reportExportProgress(options, 0.34, "exporting", "Writing USDZ package");
    const result = await exporter.parseAsync(group);
    reportExportProgress(options, 0.82, "optimizing", "Optimizing geometry text");
    const optimizedTextResult = optimizeUsdGeometryPrecision(result);
    reportExportProgress(options, 0.88, "optimizing", "Loading OpenUSD WASM");
    const optimizedResult = await optimizeUsdGeometryBinary(
      optimizedTextResult,
      options,
    );
    reportExportProgress(options, 0.96, "done", "Preparing download");

    return new Blob([optimizedResult], {
      type: getModelExportOption("usdz").mimeType,
    });
  } finally {
    restoreForUsd();
  }
}

function reportExportProgress(
  options: ModelExportOptions,
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

async function optimizeUsdGeometryBinary(
  result: ArrayBuffer,
  options: ModelExportOptions,
) {
  try {
    const files = unzipSync(new Uint8Array(result));
    const geometryEntries = Object.entries(files).filter(
      ([filename]) =>
        filename.startsWith("geometries/") && filename.endsWith(".usda"),
    );

    if (geometryEntries.length === 0 || !files["model.usda"]) {
      return result;
    }

    const pxr = await getOpenUsdPxr();
    const outputDirectory = `/tmp/medal-forge-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    pxr.FS.mkdirp(outputDirectory);

    let convertedCount = 0;

    for (const [index, [filename, data]] of geometryEntries.entries()) {
      reportExportProgress(
        options,
        0.88 + (index / geometryEntries.length) * 0.06,
        "optimizing",
        `Converting geometry ${index + 1}/${geometryEntries.length}`,
      );

      const targetFilename = filename.replace(/\.usda$/u, ".usdc");
      const outputPath = `${outputDirectory}/${targetFilename.replace(
        /[^A-Za-z0-9_.-]/g,
        "_",
      )}`;
      const layer = pxr.Sdf.Layer.CreateAnonymous(filename);

      try {
        if (!layer.ImportFromString(strFromU8(data))) {
          return result;
        }

        if (!layer.Export(outputPath)) {
          return result;
        }

        files[targetFilename] = coerceUint8Array(pxr.FS.readFile(outputPath));
        delete files[filename];
        pxr.FS.deleteFile(outputPath);
        convertedCount += 1;
      } finally {
        layer.delete?.();
      }
    }

    if (convertedCount === 0) {
      return result;
    }

    files["model.usda"] = strToU8(
      strFromU8(files["model.usda"]).replace(
        USD_GEOMETRY_REFERENCE_PATTERN,
        "@./geometries/$1.usdc@",
      ),
    );

    const optimizedResult = getArrayBuffer(zipUsdFiles(files));

    return optimizedResult.byteLength < result.byteLength
      ? optimizedResult
      : result;
  } catch {
    return result;
  }
}

async function getOpenUsdPxr() {
  const coreURL = getOpenUsdAssetUrl(OPENUSD_CORE_SCRIPT_PATH);
  const wasmURL = getOpenUsdAssetUrl(OPENUSD_CORE_WASM_PATH);

  openUsdPxrPromise ??= Promise.all([
    import(/* webpackIgnore: true */ coreURL),
    import("@openusd-wasm/pxr"),
  ]).then(([coreModule, pxrModule]) =>
    pxrModule.createPxr({
      core: coreModule.default,
      coreURL,
      wasmURL,
      workerURL: coreURL,
    }) as unknown as Promise<OpenUsdPxr>,
  ).catch((error: unknown) => {
    openUsdPxrPromise = null;
    throw error;
  });

  return openUsdPxrPromise;
}

function getOpenUsdAssetUrl(path: string) {
  return new URL(path, globalThis.location.href).href;
}

function coerceUint8Array(value: unknown) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error("Unable to read OpenUSD output");
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
  const surfaceOptions: UsdSurfaceBucketOptions = {
    includeUvs: meshes.some(meshUsesTexture),
  };

  for (const mesh of meshes) {
    if (!mesh.visible || !mesh.parent) {
      continue;
    }

    const surfaceBuckets = createUsdSurfaceBuckets(
      mesh,
      includeBackByMesh.get(mesh) ?? true,
      surfaceOptions,
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
  options: UsdSurfaceBucketOptions,
  getUsdMaterial: (material: Material) => Material,
): UsdSurfaceBucket[] {
  const source = mesh.geometry.index
    ? mesh.geometry.toNonIndexed()
    : mesh.geometry.clone();

  if (!options.includeUvs) {
    removeUvAttributes(source);
  }

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

function removeUvAttributes(geometry: BufferGeometry) {
  for (const name of Object.keys(geometry.attributes)) {
    if (name === "uv" || name.startsWith("uv")) {
      geometry.deleteAttribute(name);
    }
  }
}

function meshUsesTexture(mesh: Mesh) {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

  return materials.some(materialUsesTexture);
}

function materialUsesTexture(material: Material) {
  const textureBearingMaterial = material as TextureBearingMaterial;

  return TEXTURE_MATERIAL_KEYS.some((key) =>
    Boolean(textureBearingMaterial[key]),
  );
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
    indices: [],
    material,
    name,
    vertexKeys: new Map<string, number>(),
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
    if (!bucket.attributes.has(name)) {
      bucket.attributes.set(name, []);
    }
  }

  for (const vertex of order) {
    bucket.indices.push(
      appendVertexToBucket(bucket, source, vertex, normalMultiplier),
    );
  }
}

function appendVertexToBucket(
  bucket: UsdSurfaceBuildBucket,
  source: BufferGeometry,
  sourceVertex: number,
  normalMultiplier: number,
) {
  const attributeValues = new Map<string, number[]>();
  const keyParts: string[] = [];

  for (const name of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(name);
    const multiplier = name === "normal" ? normalMultiplier : 1;
    const values: number[] = [];

    keyParts.push(name);

    for (let itemIndex = 0; itemIndex < attribute.itemSize; itemIndex += 1) {
      const value = attribute.getComponent(sourceVertex, itemIndex) * multiplier;

      values.push(value);
      keyParts.push(formatVertexKeyNumber(value));
    }

    attributeValues.set(name, values);
  }

  const key = keyParts.join("|");
  const existing = bucket.vertexKeys.get(key);

  if (existing !== undefined) {
    return existing;
  }

  const vertexIndex =
    (bucket.attributes.get("position")?.length ?? 0) /
    (source.getAttribute("position")?.itemSize ?? 3);

  for (const [name, values] of attributeValues) {
    bucket.attributes.get(name)?.push(...values);
  }

  bucket.vertexKeys.set(key, vertexIndex);

  return vertexIndex;
}

function formatVertexKeyNumber(value: number) {
  const normalizedValue = Object.is(value, -0) ? 0 : value;

  return Number(
    normalizedValue.toPrecision(USD_VERTEX_KEY_FLOAT_PRECISION),
  ).toString();
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

  geometry.setIndex(bucket.indices);
  geometry.name = bucket.name;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
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
