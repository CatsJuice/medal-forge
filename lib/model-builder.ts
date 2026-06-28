"use client";

import * as THREE from "three";
import { TessellateModifier } from "three/examples/jsm/modifiers/TessellateModifier.js";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import {
  DEFAULT_DOME_SETTINGS,
  DEFAULT_MODEL_QUALITY_SETTINGS,
} from "@/lib/defaults";
import { getMaterialPreset } from "@/lib/materials";
import { resolveShapeSettings } from "@/lib/shape-settings";
import { summarizeSvgPaths } from "@/lib/svg-summary";
import type {
  DomeSettings,
  MedalSettings,
  ShapeWindingMode,
  SvgPathSummary,
} from "@/lib/types";

interface SvgShapeRecord {
  pathIndex: number;
  shape: THREE.Shape;
  fill: string;
  summary: SvgPathSummary;
}

interface ShapeBounds {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

interface AdaptiveCurveSamplingOptions {
  maxSegments: number;
  minSegments: number;
  tolerance: number;
}

export interface MedalBuildOptions {
  adaptiveCurveSampling?: AdaptiveCurveSamplingOptions;
  maxBevelSegments?: number;
  maxCurveSegments?: number;
}

type AdaptiveCurve = THREE.Curve<THREE.Vector2> & {
  isLineCurve?: boolean;
  isLineCurve3?: boolean;
};

const SVG_LAYER_STEP = 0.004;
const MODEL_QUALITY_TOLERANCE_PRECISION_PRODUCT = 0.036;
const POINT_EPSILON = 1e-8;
const ATTR_PATTERN = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
const SHAPE_TAG_PATTERN =
  /<(path|rect|circle|ellipse|polygon|polyline|line)\b[^>]*(?:\/>|>[\s\S]*?<\/\1>)/gi;

function safeColor(input: string | undefined, fallback: string): string {
  if (!input || input === "none" || input.startsWith("url(")) {
    return fallback;
  }

  try {
    new THREE.Color(input);
    return input;
  } catch {
    return fallback;
  }
}

function makeMaterial(
  materialId: string,
  colorOverride: string,
  name: string,
): THREE.MeshStandardMaterial {
  const preset = getMaterialPreset(materialId);

  return new THREE.MeshStandardMaterial({
    name,
    color: safeColor(colorOverride, preset.color),
    emissive: "#000000",
    emissiveIntensity: 0,
    metalness: preset.metalness,
    roughness: preset.roughness,
    side: THREE.DoubleSide,
  });
}

function getAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const openTag = tag.match(/^<[^>]+>/)?.[0] ?? tag;

  for (const match of openTag.matchAll(ATTR_PATTERN)) {
    attributes[match[1]] = match[3] ?? match[4] ?? "";
  }

  return attributes;
}

function parseSvgNumber(value: string | undefined, fallback = 0) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatSvgNumber(value: number) {
  return Number(value.toFixed(4)).toString();
}

function setSvgAttribute(tag: string, name: string, value: number) {
  const openTag = tag.match(/^<[^>]+>/)?.[0];
  if (!openTag || !Number.isFinite(value)) {
    return tag;
  }

  const formatted = formatSvgNumber(value);
  const attributePattern = new RegExp(
    `(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`,
    "i",
  );
  const nextOpenTag = attributePattern.test(openTag)
    ? openTag.replace(attributePattern, `$1"${formatted}"`)
    : openTag.replace(/\/?>$/, (ending) => ` ${name}="${formatted}"${ending}`);

  return tag.replace(openTag, nextOpenTag);
}

function applyCircleAdjustments(tag: string, radius: number | undefined) {
  if (radius === undefined) {
    return tag;
  }

  return setSvgAttribute(tag, "r", Math.max(0, radius));
}

function applyRectAdjustments(
  tag: string,
  adjustments: NonNullable<
    ReturnType<typeof resolveShapeSettings>["svgAdjustments"]
  >,
) {
  let nextTag = tag;
  const attributes = getAttributes(tag);
  const originalX = parseSvgNumber(attributes.x);
  const originalY = parseSvgNumber(attributes.y);
  const originalWidth = parseSvgNumber(attributes.width);
  const originalHeight = parseSvgNumber(attributes.height);
  const width = adjustments.rectWidth ?? originalWidth;
  const height = adjustments.rectHeight ?? originalHeight;

  if (adjustments.rectWidth !== undefined) {
    const centerX = originalX + originalWidth / 2;
    nextTag = setSvgAttribute(nextTag, "x", centerX - Math.max(0, width) / 2);
    nextTag = setSvgAttribute(nextTag, "width", Math.max(0, width));
  }

  if (adjustments.rectHeight !== undefined) {
    const centerY = originalY + originalHeight / 2;
    nextTag = setSvgAttribute(nextTag, "y", centerY - Math.max(0, height) / 2);
    nextTag = setSvgAttribute(nextTag, "height", Math.max(0, height));
  }

  if (adjustments.rectCornerRadius !== undefined) {
    const cornerRadius = Math.max(0, adjustments.rectCornerRadius);
    nextTag = setSvgAttribute(nextTag, "rx", cornerRadius);
    nextTag = setSvgAttribute(nextTag, "ry", cornerRadius);
  }

  return nextTag;
}

function applySvgAdjustments(svgText: string, settings: MedalSettings) {
  let pathIndex = 0;

  return svgText.replace(SHAPE_TAG_PATTERN, (tag, tagName: string) => {
    const shapeSettings = resolveShapeSettings(settings, pathIndex);
    const adjustments = shapeSettings.svgAdjustments;
    pathIndex += 1;

    if (shapeSettings.deleted) {
      return tag;
    }

    if (tagName.toLowerCase() === "circle") {
      return applyCircleAdjustments(tag, adjustments.circleRadius);
    }

    if (tagName.toLowerCase() === "rect") {
      return applyRectAdjustments(tag, adjustments);
    }

    return tag;
  });
}

function createShapesForWindingMode(
  path: THREE.ShapePath,
  windingMode: ShapeWindingMode,
) {
  if (windingMode === "solidCw") {
    return path.toShapes(false);
  }

  if (windingMode === "solidCcw") {
    return path.toShapes(true);
  }

  try {
    const shapes = SVGLoader.createShapes(path);
    return shapes.length > 0 ? shapes : path.toShapes(true);
  } catch {
    return path.toShapes(true);
  }
}

function parseSvgShapes(svgText: string, settings: MedalSettings): SvgShapeRecord[] {
  const loader = new SVGLoader();
  const adjustedSvgText = applySvgAdjustments(svgText, settings);
  const data = loader.parse(adjustedSvgText);
  const summaries = summarizeSvgPaths(svgText);
  const records: SvgShapeRecord[] = [];

  data.paths.forEach((path, pathIndex) => {
    const style = path.userData?.style as
      | { fill?: string; fillOpacity?: string | number }
      | undefined;
    const fillOpacity = Number(style?.fillOpacity ?? 1);
    const fill = safeColor(style?.fill, path.color?.getStyle() ?? "#d8a737");

    if (fillOpacity <= 0 || style?.fill === "none") {
      return;
    }

    const fallbackSummary: SvgPathSummary = {
      pathIndex,
      name: `Shape ${pathIndex + 1}`,
      tagName: "shape",
      attributes: {},
      fill,
      stroke: "",
      d: "",
    };
    const summary = {
      ...fallbackSummary,
      ...(summaries[pathIndex] ?? {}),
      fill: summaries[pathIndex]?.fill || fill,
    };
    const shapeSettings = resolveShapeSettings(settings, pathIndex, summary);

    if (shapeSettings.deleted) {
      return;
    }

    const shapes = createShapesForWindingMode(path, shapeSettings.windingMode);
    for (const shape of shapes) {
      records.push({
        pathIndex,
        shape,
        fill,
        summary,
      });
    }
  });

  return records;
}

function computeBounds(records: SvgShapeRecord[]): ShapeBounds {
  const box = new THREE.Box2();

  for (const record of records) {
    const geometry = new THREE.ShapeGeometry(record.shape, 24);
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;

    if (bounds) {
      box.expandByPoint(new THREE.Vector2(bounds.min.x, bounds.min.y));
      box.expandByPoint(new THREE.Vector2(bounds.max.x, bounds.max.y));
    }

    geometry.dispose();
  }

  if (box.isEmpty()) {
    return {
      centerX: 0,
      centerY: 0,
      width: 1,
      height: 1,
    };
  }

  const size = new THREE.Vector2();
  const center = new THREE.Vector2();
  box.getSize(size);
  box.getCenter(center);

  return {
    centerX: center.x,
    centerY: center.y,
    width: Math.max(size.x, 1),
    height: Math.max(size.y, 1),
  };
}

function pointsEqual(left: THREE.Vector2, right: THREE.Vector2) {
  return left.distanceToSquared(right) <= POINT_EPSILON * POINT_EPSILON;
}

function pushUniquePoint(points: THREE.Vector2[], point: THREE.Vector2) {
  const last = points.at(-1);

  if (last && pointsEqual(last, point)) {
    return;
  }

  points.push(point.clone());
}

function pointSegmentDistance(
  point: THREE.Vector2,
  start: THREE.Vector2,
  end: THREE.Vector2,
) {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const segmentLengthSq = segmentX * segmentX + segmentY * segmentY;

  if (segmentLengthSq <= POINT_EPSILON * POINT_EPSILON) {
    return point.distanceTo(start);
  }

  const projected =
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) /
    segmentLengthSq;
  const clamped = Math.min(1, Math.max(0, projected));
  const closestX = start.x + segmentX * clamped;
  const closestY = start.y + segmentY * clamped;
  const deltaX = point.x - closestX;
  const deltaY = point.y - closestY;

  return Math.sqrt(deltaX * deltaX + deltaY * deltaY);
}

function getCurveDepth(segmentCount: number) {
  return Math.max(0, Math.ceil(Math.log2(Math.max(1, segmentCount))));
}

function appendAdaptiveCurvePoints(
  curve: AdaptiveCurve,
  startT: number,
  endT: number,
  startPoint: THREE.Vector2,
  endPoint: THREE.Vector2,
  points: THREE.Vector2[],
  options: AdaptiveCurveSamplingOptions,
  depth: number,
) {
  const midT = (startT + endT) / 2;
  const midPoint = curve.getPoint(midT);
  const minDepth = getCurveDepth(options.minSegments);
  const maxDepth = getCurveDepth(options.maxSegments);
  const isFlatEnough =
    pointSegmentDistance(midPoint, startPoint, endPoint) <= options.tolerance;

  if ((isFlatEnough && depth >= minDepth) || depth >= maxDepth) {
    pushUniquePoint(points, endPoint);
    return;
  }

  appendAdaptiveCurvePoints(
    curve,
    startT,
    midT,
    startPoint,
    midPoint,
    points,
    options,
    depth + 1,
  );
  appendAdaptiveCurvePoints(
    curve,
    midT,
    endT,
    midPoint,
    endPoint,
    points,
    options,
    depth + 1,
  );
}

function getAdaptiveCurvePoints(
  curve: AdaptiveCurve,
  options: AdaptiveCurveSamplingOptions,
) {
  const startPoint = curve.getPoint(0);
  const endPoint = curve.getPoint(1);
  const points = [startPoint.clone()];

  if (curve.isLineCurve || curve.isLineCurve3) {
    pushUniquePoint(points, endPoint);
    return points;
  }

  appendAdaptiveCurvePoints(
    curve,
    0,
    1,
    startPoint,
    endPoint,
    points,
    options,
    0,
  );

  return points;
}

function getAdaptivePathPoints(
  path: THREE.Path,
  options: AdaptiveCurveSamplingOptions,
) {
  const points: THREE.Vector2[] = [];

  for (const curve of path.curves as AdaptiveCurve[]) {
    for (const point of getAdaptiveCurvePoints(curve, options)) {
      pushUniquePoint(points, point);
    }
  }

  const first = points[0];
  const last = points.at(-1);

  if (first && last && pointsEqual(first, last)) {
    points.pop();
  }

  return points;
}

function createLinearPath(points: THREE.Vector2[]) {
  const path = new THREE.Path();
  const first = points[0];

  if (!first) {
    return path;
  }

  path.moveTo(first.x, first.y);

  for (const point of points.slice(1)) {
    path.lineTo(point.x, point.y);
  }

  return path;
}

function createAdaptiveShape(
  shape: THREE.Shape,
  options: AdaptiveCurveSamplingOptions,
) {
  const contour = getAdaptivePathPoints(shape, options);

  if (contour.length < 3) {
    return shape;
  }

  const adaptiveShape = new THREE.Shape(contour);

  adaptiveShape.holes = shape.holes.flatMap((hole) => {
    const points = getAdaptivePathPoints(hole, options);

    return points.length >= 3 ? [createLinearPath(points)] : [];
  });

  return adaptiveShape;
}

function getQualityShape(
  shape: THREE.Shape,
  scale: number,
  options: MedalBuildOptions,
) {
  const sampling = options.adaptiveCurveSampling;

  if (!sampling) {
    return shape;
  }

  return createAdaptiveShape(shape, {
    ...sampling,
    tolerance: sampling.tolerance / Math.max(scale, 0.000001),
  });
}

function clampInteger(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function createQualityBuildOptions(settings: MedalSettings): MedalBuildOptions {
  const quality = {
    ...DEFAULT_MODEL_QUALITY_SETTINGS,
    ...settings.quality,
  };
  const curveSegments = clampInteger(quality.curveSegments, 4, 96);
  const curvePrecision = clampInteger(quality.curvePrecision, 2, 64);

  return {
    adaptiveCurveSampling: {
      maxSegments: curveSegments,
      minSegments: 1,
      tolerance: MODEL_QUALITY_TOLERANCE_PRECISION_PRODUCT / curvePrecision,
    },
    maxBevelSegments: clampInteger(quality.bevelSegments, 0, 12),
    maxCurveSegments: curveSegments,
  };
}

function resolveBuildOptions(
  settings: MedalSettings,
  options?: MedalBuildOptions,
) {
  const qualityOptions = createQualityBuildOptions(settings);

  return {
    ...qualityOptions,
    ...options,
    adaptiveCurveSampling:
      options?.adaptiveCurveSampling ?? qualityOptions.adaptiveCurveSampling,
  };
}

function createSvgGeometry(
  shape: THREE.Shape,
  bounds: ShapeBounds,
  scale: number,
  thickness: number,
  bevel: number,
  curveSegments: number,
  bevelSegments: number,
  depthSteps: number,
  options: MedalBuildOptions,
): THREE.ExtrudeGeometry {
  const scaledDepth = Math.max(thickness / scale, 0.001);
  const scaledBevel = Math.min(bevel / scale, scaledDepth * 0.45);
  const effectiveShape = getQualityShape(shape, scale, options);
  const effectiveCurveSegments = Math.max(
    1,
    Math.min(curveSegments, options.maxCurveSegments ?? curveSegments),
  );
  const effectiveBevelSegments = Math.max(
    0,
    Math.min(bevelSegments, options.maxBevelSegments ?? bevelSegments),
  );
  const geometry = new THREE.ExtrudeGeometry(effectiveShape, {
    depth: scaledDepth,
    bevelEnabled: scaledBevel > 0.0001 && effectiveBevelSegments > 0,
    bevelSize: scaledBevel,
    bevelThickness: scaledBevel,
    bevelSegments: scaledBevel > 0.0001 ? effectiveBevelSegments : 0,
    curveSegments: options.adaptiveCurveSampling ? 1 : effectiveCurveSegments,
    steps: depthSteps,
  });

  geometry.translate(-bounds.centerX, -bounds.centerY, 0);
  geometry.scale(scale, -scale, scale);
  geometry.computeVertexNormals();
  return geometry;
}

function resolveDomeSettings(settings: MedalSettings): DomeSettings {
  return {
    ...DEFAULT_DOME_SETTINGS,
    ...settings.dome,
  };
}

function getDomeDisplacement(radius: number, domeRadius: number, depth: number) {
  if (depth <= 0 || domeRadius <= 0 || radius >= domeRadius) {
    return 0;
  }

  const sphereRadius =
    (domeRadius * domeRadius + depth * depth) / (2 * depth);
  const edgeHeight = Math.sqrt(
    Math.max(sphereRadius * sphereRadius - domeRadius * domeRadius, 0),
  );

  return (
    Math.sqrt(Math.max(sphereRadius * sphereRadius - radius * radius, 0)) -
    edgeHeight
  );
}

function applyDomeToGeometry(
  geometry: THREE.BufferGeometry,
  settings: MedalSettings,
) {
  const dome = resolveDomeSettings(settings);

  if (!dome.enabled || dome.depth <= 0) {
    geometry.computeVertexNormals();
    return geometry;
  }

  const domeRadius = Math.max(settings.modelSize * dome.radius * 0.5, 0.001);
  const maxEdgeLength =
    settings.modelSize / Math.max(4, Math.round(dome.segments));
  const modifier = new TessellateModifier(maxEdgeLength, 7);
  const tessellatedGeometry = modifier.modify(geometry);

  if (tessellatedGeometry !== geometry) {
    geometry.dispose();
  }

  const positions = tessellatedGeometry.getAttribute("position");
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const radius = Math.sqrt(x * x + y * y);

    positions.setZ(
      index,
      positions.getZ(index) + getDomeDisplacement(radius, domeRadius, dome.depth),
    );
  }

  positions.needsUpdate = true;
  tessellatedGeometry.computeVertexNormals();
  return tessellatedGeometry;
}

function getLayerOffset(pathIndex: number): number {
  return Math.min(pathIndex * SVG_LAYER_STEP, SVG_LAYER_STEP * 16);
}

function addEmptyPlaceholder(group: THREE.Group) {
  group.userData.isEmptyPlaceholder = true;
  const material = new THREE.MeshStandardMaterial({
    color: "#d8a737",
    metalness: 1,
    roughness: 0.35,
  });
  const geometry = new THREE.TorusGeometry(1.2, 0.16, 16, 96);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function addHighlightOutline(mesh: THREE.Mesh) {
  const edges = new THREE.EdgesGeometry(mesh.geometry, 16);
  const material = new THREE.LineBasicMaterial({
    color: "#f5ff5c",
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  const outline = new THREE.LineSegments(edges, material);
  outline.name = `${mesh.name} hover highlight`;
  outline.renderOrder = 999;
  outline.userData.pathIndex = mesh.userData.pathIndex;
  outline.userData.pathName = mesh.userData.pathName;
  mesh.add(outline);
}

export function buildMedalGroup(
  svgText: string,
  settings: MedalSettings,
  highlightedPathIndex: number | null = null,
  options?: MedalBuildOptions,
): THREE.Group {
  const group = new THREE.Group();
  group.name = "medal-forge-model";

  let records: SvgShapeRecord[] = [];
  try {
    records = parseSvgShapes(svgText, settings);
  } catch {
    records = [];
  }

  if (records.length === 0) {
    addEmptyPlaceholder(group);
    return group;
  }

  const bounds = computeBounds(records);
  const maxDimension = Math.max(bounds.width, bounds.height, 1);
  const scale = settings.modelSize / maxDimension;
  const buildOptions = resolveBuildOptions(settings, options);

  for (const record of records) {
    const shapeSettings = resolveShapeSettings(
      settings,
      record.pathIndex,
      record.summary,
    );

    if (!shapeSettings.visible || shapeSettings.deleted) {
      continue;
    }

    const geometry = applyDomeToGeometry(
      createSvgGeometry(
        record.shape,
        bounds,
        scale,
        shapeSettings.thickness,
        shapeSettings.bevel,
        shapeSettings.curveSegments,
        shapeSettings.bevelSegments,
        shapeSettings.depthSteps,
        buildOptions,
      ),
      settings,
    );
    const mesh = new THREE.Mesh(
      geometry,
      makeMaterial(
        shapeSettings.material,
        shapeSettings.color || record.fill,
        `${record.summary.name} path ${record.pathIndex}`,
      ),
    );

    mesh.name = record.summary.name;
    mesh.userData.pathIndex = record.pathIndex;
    mesh.userData.pathName = record.summary.name;
    mesh.position.z = shapeSettings.zOffset + getLayerOffset(record.pathIndex);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    if (record.pathIndex === highlightedPathIndex) {
      addHighlightOutline(mesh);
    }

    group.add(mesh);
  }

  return group;
}

export function disposeObject3D(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.LineSegments)) {
      return;
    }

    child.geometry.dispose();
    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const material of materials) {
      material.dispose();
    }
  });
}
