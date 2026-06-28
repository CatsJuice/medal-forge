"use client";

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildMedalGroup, disposeObject3D } from "@/lib/model-builder";
import {
  HOME_PREVIEW_ROTATION_X,
  HOME_PREVIEW_ROTATION_Y,
} from "@/lib/preview-pose";
import type { WorkDocument, WorkSnapshot } from "@/lib/types";
import {
  createWorkSnapshotSourceSignature,
  getPrimarySvgAsset,
} from "@/lib/work-document";

const SNAPSHOT_WIDTH = 320;
const SNAPSHOT_HEIGHT = 320;
const SNAPSHOT_RENDER_VERSION = 16;
const SNAPSHOT_CAMERA_FOV = 38;

export function getSnapshotSourceSignature(document: WorkDocument) {
  const asset = getPrimarySvgAsset(document);

  return JSON.stringify({
    renderVersion: SNAPSHOT_RENDER_VERSION,
    source: createWorkSnapshotSourceSignature({
      svgText: asset.text,
      settings: document.scene.settings,
    }),
  });
}

export function needsSnapshot(document: WorkDocument) {
  const snapshot = document.preview.snapshot;

  return (
    !snapshot ||
    snapshot.width !== SNAPSHOT_WIDTH ||
    snapshot.height !== SNAPSHOT_HEIGHT ||
    snapshot.sourceSignature !== getSnapshotSourceSignature(document)
  );
}

export async function generateWorkSnapshot(
  document: WorkDocument,
): Promise<WorkSnapshot> {
  const canvas = documentCloneCanvas();
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    canvas,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(SNAPSHOT_WIDTH, SNAPSHOT_HEIGHT, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const environment = await createSnapshotEnvironment(pmremGenerator);
  scene.environment = environment.texture;
  const asset = getPrimarySvgAsset(document);
  const group = buildMedalGroup(asset.text, document.scene.settings);
  group.rotation.set(HOME_PREVIEW_ROTATION_X, HOME_PREVIEW_ROTATION_Y, 0);
  group.updateMatrixWorld(true);
  tuneSnapshotMaterials(group);
  scene.add(group);

  const ambient = new THREE.AmbientLight(0xffffff, 0.9);
  const key = new THREE.DirectionalLight(0xffffff, 3.05);
  key.position.set(4.5, -5.5, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.00014;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 3.5;
  const fill = new THREE.DirectionalLight(0xffffff, 1.16);
  fill.position.set(-5, 3, 4);
  const rim = new THREE.DirectionalLight(0xffffff, 0.68);
  rim.position.set(-3.5, 4.4, 3.4);
  const keyTarget = new THREE.Object3D();
  scene.add(ambient, key, fill, rim, keyTarget);

  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  keyTarget.position.copy(center);
  key.target = keyTarget;

  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const cameraDistance =
    (Math.max(sphere.radius, 0.1) /
      Math.sin(THREE.MathUtils.degToRad(SNAPSHOT_CAMERA_FOV) / 2)) *
    0.78;
  const cameraDirection = new THREE.Vector3(0, -7, 5.2).normalize();
  const camera = new THREE.PerspectiveCamera(
    SNAPSHOT_CAMERA_FOV,
    SNAPSHOT_WIDTH / SNAPSHOT_HEIGHT,
    0.01,
    Math.max(cameraDistance + sphere.radius * 4, 100),
  );
  camera.position.copy(center).add(cameraDirection.multiplyScalar(cameraDistance));
  camera.up.set(0, 1, 0);
  camera.lookAt(center.x, center.y, center.z);
  camera.updateProjectionMatrix();
  const shadowExtent = Math.max(size.x, size.y, 1) * 0.64;
  key.shadow.camera.left = -shadowExtent;
  key.shadow.camera.right = shadowExtent;
  key.shadow.camera.top = shadowExtent;
  key.shadow.camera.bottom = -shadowExtent;
  key.shadow.camera.near = 0.01;
  key.shadow.camera.far = 24;
  key.shadow.camera.updateProjectionMatrix();

  renderer.render(scene, camera);
  const dataUrl = canvas.toDataURL("image/png");

  disposeObject3D(group);
  environment.dispose();
  pmremGenerator.dispose();
  renderer.dispose();

  return {
    id: "snapshot_front_png",
    kind: "model-front-png",
    mediaType: "image/png",
    width: SNAPSHOT_WIDTH,
    height: SNAPSHOT_HEIGHT,
    dataUrl,
    sourceSignature: getSnapshotSourceSignature(document),
    createdAt: new Date().toISOString(),
  };
}

function documentCloneCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = SNAPSHOT_WIDTH;
  canvas.height = SNAPSHOT_HEIGHT;
  return canvas;
}

async function createSnapshotEnvironment(pmremGenerator: THREE.PMREMGenerator) {
  const roomEnvironment = new RoomEnvironment();
  const renderTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
  roomEnvironment.clear();

  return {
    texture: renderTarget.texture,
    dispose: () => renderTarget.dispose(),
  };
}

function tuneSnapshotMaterials(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    const materials = Array.isArray(child.material)
      ? child.material
      : [child.material];

    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        material.envMapIntensity = 1.55;
        material.needsUpdate = true;
      }
    }
  });
}
