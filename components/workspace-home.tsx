"use client";

import JSZip from "jszip";
import { Box, Download, Eye, MoreHorizontal, Plus, Upload } from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ExportQueuePanel } from "@/components/export-queue-panel";
import {
  HomeLivePreviewLayer,
  type HomeLivePreviewRect,
  type HomeLivePreviewLayerHandle,
  type HomeLivePreviewZoom,
  type HomePreviewRotation,
} from "@/components/home-live-preview-layer";
import {
  DEFAULT_FILE_NAME,
  DEFAULT_SETTINGS,
  DEFAULT_SVG,
} from "@/lib/defaults";
import {
  MODEL_EXPORT_OPTIONS,
  downloadBlob,
  getModelExportOption,
  type ModelExportFormat,
} from "@/lib/export-model";
import { enqueueModelExport } from "@/lib/export-queue";
import { waitForIdle } from "@/lib/idle";
import { generateWorkSnapshot, needsSnapshot } from "@/lib/snapshot";
import type { SavedWorkSummary, WorkDocument } from "@/lib/types";
import {
  createWorkDocument,
  createWorkId,
  getPrimarySvgAsset,
  isWorkDocument,
  normalizeWorkDocument,
} from "@/lib/work-document";
import {
  HOME_PREVIEW_ROTATION_X,
  HOME_PREVIEW_ROTATION_Y,
  HOME_PREVIEW_ZOOM_DURATION_MS,
} from "@/lib/preview-pose";
import {
  deleteWorkDocument,
  getWorkDocument,
  listSavedWorks,
  listWorkDocuments,
  saveWorkDocument,
} from "@/lib/work-storage";

const CARD_SPACING_X = 360;
const CARD_SPACING_Y = 360;
const CARD_WIDTH = 260;
const CARD_HEIGHT = 288;
const VIEW_FIT_PADDING_X = 96;
const VIEW_FIT_PADDING_Y = 180;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.2;
const LIVE_PREVIEW_QUEUE_DELAY_MS = 100;
const SHOWCASE_IMPORT_CARD_ID = "showcase-import";

interface ViewTransform {
  x: number;
  y: number;
  scale: number;
}

interface WorkMenuAnchor {
  right: number;
  top: number;
}

type PositionedWork = SavedWorkSummary & { x: number; y: number };
type PositionedLayoutItem = { x: number; y: number };

function createTimestamp() {
  return new Date().toISOString();
}

function createSampleDocument(index = 0): WorkDocument {
  const now = createTimestamp();
  const suffix = index > 0 ? `-${index + 1}` : "";

  return createWorkDocument({
    id: createWorkId(),
    title: `2026-03${suffix}`,
    createdAt: now,
    updatedAt: now,
    fileName: DEFAULT_FILE_NAME,
    svgText: DEFAULT_SVG,
    settings: DEFAULT_SETTINGS,
    selectedPathIndexes: [],
    snapshot: null,
  });
}

function getSpiralCell(index: number) {
  if (index === 0) {
    return { x: 0, y: 0 };
  }

  let x = 0;
  let y = 0;
  let dx = 0;
  let dy = -1;

  for (let i = 0; i < index; i += 1) {
    if (x === y || (x < 0 && x === -y) || (x > 0 && x === 1 - y)) {
      const nextDx = -dy;
      dy = dx;
      dx = nextDx;
    }

    x += dx;
    y += dy;
  }

  return { x, y };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function getSafeFileStem(value: string) {
  return value.trim().replace(/[^\w.-]+/g, "-") || "medal";
}

function getUniqueArchiveFileName(title: string, usedNames: Set<string>) {
  const baseName = getSafeFileStem(title);
  let fileName = `${baseName}.medal-forge.json`;
  let suffix = 2;

  while (usedNames.has(fileName)) {
    fileName = `${baseName}-${suffix}.medal-forge.json`;
    suffix += 1;
  }

  usedNames.add(fileName);
  return fileName;
}

function positionWorkSummaries(works: SavedWorkSummary[]): PositionedWork[] {
  return works
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((work, index) => {
      const cell = getSpiralCell(index);

      return {
        ...work,
        x: cell.x * CARD_SPACING_X,
        y: cell.y * CARD_SPACING_Y,
      };
    });
}

function getInitialView(
  works: PositionedLayoutItem[],
  viewport: DOMRect,
): ViewTransform {
  const minX = Math.min(...works.map((work) => work.x - CARD_WIDTH / 2));
  const maxX = Math.max(...works.map((work) => work.x + CARD_WIDTH / 2));
  const minY = Math.min(...works.map((work) => work.y - CARD_HEIGHT / 2));
  const maxY = Math.max(...works.map((work) => work.y + CARD_HEIGHT / 2));
  const boundsWidth = Math.max(CARD_WIDTH, maxX - minX);
  const boundsHeight = Math.max(CARD_HEIGHT, maxY - minY);
  const availableWidth = Math.max(1, viewport.width - VIEW_FIT_PADDING_X);
  const availableHeight = Math.max(1, viewport.height - VIEW_FIT_PADDING_Y);
  const scale = clamp(
    Math.min(1, availableWidth / boundsWidth, availableHeight / boundsHeight),
    MIN_ZOOM,
    1,
  );
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  return {
    scale,
    x: -centerX * scale,
    y: -centerY * scale,
  };
}

export function WorkspaceHome() {
  const router = useRouter();
  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const livePreviewLayerRef = useRef<HomeLivePreviewLayerHandle>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const didInitializeViewRef = useRef(false);
  const viewRef = useRef<ViewTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const pendingViewRef = useRef<ViewTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });
  const viewFrameRef = useRef<number | null>(null);
  const viewCommitTimerRef = useRef<number | null>(null);
  const livePreviewZoomTimerRef = useRef<number | null>(null);
  const livePreviewVersionsRef = useRef<Record<string, string>>({});
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const livePreviewDragRef = useRef<{
    pointerId: number;
    workId: string;
    x: number;
    y: number;
    rotation: HomePreviewRotation;
  } | null>(null);
  const [works, setWorks] = useState<SavedWorkSummary[]>([]);
  const [loadingSnapshots, setLoadingSnapshots] = useState<Record<string, boolean>>(
    {},
  );
  const [isLivePreviewEnabled, setIsLivePreviewEnabled] = useState(false);
  const [livePreviewDocuments, setLivePreviewDocuments] = useState<
    Record<string, WorkDocument>
  >({});
  const [loadingLivePreviews, setLoadingLivePreviews] = useState<
    Record<string, boolean>
  >({});
  const [readyLivePreviews, setReadyLivePreviews] = useState<
    Record<string, boolean>
  >({});
  const [livePreviewRotations, setLivePreviewRotations] = useState<
    Record<string, HomePreviewRotation>
  >({});
  const [livePreviewZoom, setLivePreviewZoom] =
    useState<HomeLivePreviewZoom | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [workMenuAnchor, setWorkMenuAnchor] = useState<WorkMenuAnchor | null>(
    null,
  );
  const [isBooting, setIsBooting] = useState(true);
  const [isImportingShowcase, setIsImportingShowcase] = useState(false);
  const [view, setView] = useState<ViewTransform>({
    x: 0,
    y: 0,
    scale: 1,
  });

  const applyWorldTransform = useCallback((nextView: ViewTransform) => {
    const world = worldRef.current;
    if (!world) {
      return;
    }

    world.style.transform = `translate3d(${nextView.x}px, ${nextView.y}px, 0) scale(${nextView.scale})`;
  }, []);

  const renderView = useCallback(
    (nextView: ViewTransform) => {
      viewRef.current = nextView;
      pendingViewRef.current = nextView;

      if (viewFrameRef.current !== null) {
        return;
      }

      viewFrameRef.current = window.requestAnimationFrame(() => {
        viewFrameRef.current = null;
        applyWorldTransform(pendingViewRef.current);
        livePreviewLayerRef.current?.requestRender();
      });
    },
    [applyWorldTransform],
  );

  const scheduleViewCommit = useCallback((delay = 120) => {
    if (viewCommitTimerRef.current !== null) {
      window.clearTimeout(viewCommitTimerRef.current);
    }

    viewCommitTimerRef.current = window.setTimeout(() => {
      viewCommitTimerRef.current = null;
      setView(viewRef.current);
    }, delay);
  }, []);

  const positionedWorks = useMemo(() => {
    return positionWorkSummaries(works);
  }, [works]);

  const positionedShowcaseImportCard = useMemo(() => {
    if (works.length >= 2) {
      return null;
    }

    const cell = getSpiralCell(positionedWorks.length);

    return {
      id: SHOWCASE_IMPORT_CARD_ID,
      x: cell.x * CARD_SPACING_X,
      y: cell.y * CARD_SPACING_Y,
    };
  }, [positionedWorks.length, works.length]);

  const positionedLayoutItems = useMemo(
    () =>
      positionedShowcaseImportCard
        ? [...positionedWorks, positionedShowcaseImportCard]
        : positionedWorks,
    [positionedShowcaseImportCard, positionedWorks],
  );

  const livePreviewQueueKey = useMemo(() => {
    return works
      .slice()
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((work) => `${work.id}\t${work.updatedAt}`)
      .join("\n");
  }, [works]);
  const openMenuWork = useMemo(() => {
    return openMenuId
      ? positionedWorks.find((work) => work.id === openMenuId)
      : undefined;
  }, [openMenuId, positionedWorks]);

  const markLivePreviewReady = useCallback((workId: string) => {
    setReadyLivePreviews((current) =>
      current[workId] ? current : { ...current, [workId]: true },
    );
  }, []);

  function clearLivePreviewState() {
    if (livePreviewZoomTimerRef.current !== null) {
      window.clearTimeout(livePreviewZoomTimerRef.current);
      livePreviewZoomTimerRef.current = null;
    }
    livePreviewVersionsRef.current = {};
    setLivePreviewZoom(null);
    setLivePreviewDocuments({});
    setLoadingLivePreviews({});
    setReadyLivePreviews({});
  }

  function toggleLivePreviewMode() {
    setOpenMenuId(null);

    if (isLivePreviewEnabled) {
      clearLivePreviewState();
    }

    setIsLivePreviewEnabled((current) => !current);
  }

  function toggleWorkMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    work: SavedWorkSummary,
  ) {
    event.stopPropagation();

    if (openMenuId === work.id) {
      setOpenMenuId(null);
      setWorkMenuAnchor(null);
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    setWorkMenuAnchor({
      right: Math.max(8, window.innerWidth - rect.right),
      top: rect.bottom + 6,
    });
    setOpenMenuId(work.id);
  }

  function getLivePreviewRotation(workId: string): HomePreviewRotation {
    return (
      livePreviewRotations[workId] ?? {
        x: HOME_PREVIEW_ROTATION_X,
        y: HOME_PREVIEW_ROTATION_Y,
      }
    );
  }

  function getLivePreviewRect(element: HTMLElement): HomeLivePreviewRect | null {
    const viewport = viewportRef.current;
    if (!viewport) {
      return null;
    }

    const rootRect = viewport.getBoundingClientRect();
    const frameRect = element.getBoundingClientRect();

    return {
      height: frameRect.height,
      left: frameRect.left - rootRect.left,
      top: frameRect.top - rootRect.top,
      width: frameRect.width,
    };
  }

  function openLivePreviewZoom(workId: string) {
    const livePreviewFrames = Array.from(
      viewportRef.current?.querySelectorAll<HTMLElement>(
        "[data-live-preview-id]",
      ) ?? [],
    );
    const frame =
      livePreviewFrames.find((element) => element.dataset.livePreviewId === workId) ??
      livePreviewFrames[0];
    const fromRect = frame ? getLivePreviewRect(frame) : null;
    if (!fromRect) {
      return;
    }

    if (livePreviewZoomTimerRef.current !== null) {
      window.clearTimeout(livePreviewZoomTimerRef.current);
      livePreviewZoomTimerRef.current = null;
    }

    setOpenMenuId(null);
    setLivePreviewRotations((current) =>
      current[workId]
        ? current
        : {
            ...current,
            [workId]: getLivePreviewRotation(workId),
          },
    );
    setLivePreviewZoom({
      fromRect,
      phase: "opening",
      startedAt: performance.now(),
      workId,
    });
  }

  function closeLivePreviewZoom() {
    setLivePreviewZoom((current) => {
      if (!current || current.phase === "closing") {
        return current;
      }

      return {
        ...current,
        phase: "closing",
        startedAt: performance.now(),
      };
    });

    if (livePreviewZoomTimerRef.current !== null) {
      window.clearTimeout(livePreviewZoomTimerRef.current);
    }

    livePreviewZoomTimerRef.current = window.setTimeout(() => {
      livePreviewZoomTimerRef.current = null;
      setLivePreviewZoom(null);
    }, HOME_PREVIEW_ZOOM_DURATION_MS);
  }

  useEffect(() => {
    let active = true;

    async function bootWorkspace() {
      setIsBooting(true);
      let savedWorks = await listSavedWorks();

      if (savedWorks.length === 0) {
        const sample = createSampleDocument();
        await saveWorkDocument(sample);
        savedWorks = await listSavedWorks();
      }

      if (active) {
        setWorks(savedWorks);
        setIsBooting(false);
      }
    }

    bootWorkspace().catch(() => {
      if (active) {
        setIsBooting(false);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    async function loadSnapshotsSequentially() {
      const orderedWorks = works
        .slice()
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

      for (const work of orderedWorks) {
        if (!active) {
          continue;
        }

        await waitForIdle(2000);

        const document = await getWorkDocument(work.id);
        if (!active || !document) {
          continue;
        }

        if (!needsSnapshot(document)) {
          continue;
        }

        setLoadingSnapshots((current) => ({
          ...current,
          [work.id]: true,
        }));

        let nextDocument = document;
        const snapshot = await generateWorkSnapshot(document);
        nextDocument = {
          ...document,
          preview: {
            snapshot,
          },
        };
        await saveWorkDocument(nextDocument);

        const asset = getPrimarySvgAsset(nextDocument);
        setWorks((current) =>
          current.map((item) =>
            item.id === work.id
              ? {
                  ...item,
                  sourceFileName: asset.fileName,
                  snapshotDataUrl: nextDocument.preview.snapshot?.dataUrl ?? null,
                }
              : item,
          ),
        );
        setLoadingSnapshots((current) => ({
          ...current,
          [work.id]: false,
        }));
      }
    }

    if (!isBooting) {
      loadSnapshotsSequentially().catch(() => undefined);
    }

    return () => {
      active = false;
    };
  }, [isBooting, works]);

  useEffect(() => {
    if (isBooting || !isLivePreviewEnabled) {
      return undefined;
    }

    let active = true;
    const queue = livePreviewQueueKey
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, updatedAt] = line.split("\t");
        return { id, updatedAt };
      });

    async function loadLivePreviewsSequentially() {
      for (const work of queue) {
        if (!active) {
          return;
        }

        if (livePreviewVersionsRef.current[work.id] === work.updatedAt) {
          continue;
        }

        setLoadingLivePreviews((current) => ({
          ...current,
          [work.id]: true,
        }));
        setReadyLivePreviews((current) => ({
          ...current,
          [work.id]: false,
        }));
        await waitForIdle(600);

        const document = await getWorkDocument(work.id);
        if (!active) {
          return;
        }

        if (!document) {
          setLoadingLivePreviews((current) => ({
            ...current,
            [work.id]: false,
          }));
          continue;
        }

        setLivePreviewDocuments((current) => ({
          ...current,
          [work.id]: document,
        }));

        livePreviewVersionsRef.current[work.id] = work.updatedAt;
        setLoadingLivePreviews((current) => ({
          ...current,
          [work.id]: false,
        }));

        await wait(LIVE_PREVIEW_QUEUE_DELAY_MS);
      }
    }

    loadLivePreviewsSequentially().catch(() => undefined);

    return () => {
      active = false;
    };
  }, [isBooting, isLivePreviewEnabled, livePreviewQueueKey]);

  useLayoutEffect(() => {
    viewRef.current = view;
    pendingViewRef.current = view;
    applyWorldTransform(view);
    livePreviewLayerRef.current?.requestRender();
  }, [applyWorldTransform, view]);

  useEffect(() => {
    return () => {
      if (viewFrameRef.current !== null) {
        window.cancelAnimationFrame(viewFrameRef.current);
      }

      if (viewCommitTimerRef.current !== null) {
        window.clearTimeout(viewCommitTimerRef.current);
      }

      if (livePreviewZoomTimerRef.current !== null) {
        window.clearTimeout(livePreviewZoomTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (
      isBooting ||
      didInitializeViewRef.current ||
      positionedLayoutItems.length === 0 ||
      !viewportRef.current
    ) {
      return;
    }

    didInitializeViewRef.current = true;
    setView(
      getInitialView(
        positionedLayoutItems,
        viewportRef.current.getBoundingClientRect(),
      ),
    );
  }, [isBooting, positionedLayoutItems]);

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    if (livePreviewZoom) {
      return;
    }

    const root = viewportRef.current;
    if (!root) {
      return;
    }

    const rect = root.getBoundingClientRect();
    const current = viewRef.current;
    const nextScale = clamp(
      current.scale * Math.exp(-event.deltaY * 0.001),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const pointerX = event.clientX - rect.left;
    const pointerY = event.clientY - rect.top;
    const worldX = (pointerX - centerX - current.x) / current.scale;
    const worldY = (pointerY - centerY - current.y) / current.scale;

    renderView({
      scale: nextScale,
      x: pointerX - centerX - worldX * nextScale,
      y: pointerY - centerY - worldY * nextScale,
    });
    scheduleViewCommit();
  }, [livePreviewZoom, renderView, scheduleViewCommit]);

  useEffect(() => {
    if (isBooting) {
      return;
    }

    const root = viewportRef.current;
    if (!root) {
      return;
    }

    root.addEventListener("wheel", handleWheel, {
      passive: false,
    });

    return () => {
      root.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel, isBooting]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || livePreviewZoom) {
      return;
    }

    setOpenMenuId(null);
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const current = viewRef.current;

    dragRef.current = {
      ...drag,
      x: event.clientX,
      y: event.clientY,
    };

    renderView({
      ...current,
      x: current.x + dx,
      y: current.y + dy,
    });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setView(viewRef.current);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleLivePreviewPointerDown(
    event: ReactPointerEvent<HTMLElement>,
    workId: string,
  ) {
    if (!isLivePreviewEnabled || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setOpenMenuId(null);

    livePreviewDragRef.current = {
      pointerId: event.pointerId,
      workId,
      x: event.clientX,
      y: event.clientY,
      rotation: getLivePreviewRotation(workId),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleLivePreviewPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = livePreviewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const nextRotation: HomePreviewRotation = {
      x: clamp(drag.rotation.x + dy * 0.012, -Math.PI / 2, Math.PI / 2),
      y: drag.rotation.y + dx * 0.012,
    };

    setLivePreviewRotations((current) => ({
      ...current,
      [drag.workId]: nextRotation,
    }));
  }

  function handleLivePreviewPointerUp(event: ReactPointerEvent<HTMLElement>) {
    const drag = livePreviewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    livePreviewDragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function createNewWork() {
    router.push(`/work/${createWorkId()}`);
  }

  function fitWorksInView(nextWorks: SavedWorkSummary[]) {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const nextPositionedWorks = positionWorkSummaries(nextWorks);
    if (nextPositionedWorks.length === 0) {
      return;
    }

    setView(getInitialView(nextPositionedWorks, viewport.getBoundingClientRect()));
  }

  async function importWorkDocumentsFromZipBlob(blob: Blob) {
    const zip = await JSZip.loadAsync(blob);
    let importedCount = 0;
    let skippedCount = 0;

    for (const entry of Object.values(zip.files)) {
      if (entry.dir || !entry.name.endsWith(".json")) {
        continue;
      }

      try {
        const parsed = JSON.parse(await entry.async("string")) as unknown;

        if (!isWorkDocument(parsed)) {
          skippedCount += 1;
          continue;
        }

        await saveWorkDocument(normalizeWorkDocument(parsed));
        importedCount += 1;
      } catch {
        skippedCount += 1;
      }
    }

    return { importedCount, skippedCount };
  }

  async function importShowcaseWorks() {
    if (isImportingShowcase) {
      return;
    }

    setOpenMenuId(null);
    setIsImportingShowcase(true);

    try {
      const response = await fetch("/api/showcase");

      if (!response.ok) {
        throw new Error(`Showcase import failed with ${response.status}`);
      }

      const { importedCount } = await importWorkDocumentsFromZipBlob(
        await response.blob(),
      );
      const nextWorks = await listSavedWorks();

      setWorks(nextWorks);
      fitWorksInView(nextWorks);

      if (importedCount === 0) {
        window.alert("No showcase works were imported.");
      }
    } catch {
      window.alert("Could not import showcase works.");
    } finally {
      setIsImportingShowcase(false);
    }
  }

  async function exportAllWorkJson() {
    setOpenMenuId(null);
    const documents = await listWorkDocuments();
    const zip = new JSZip();
    const usedNames = new Set<string>();
    let refreshedSnapshotCount = 0;

    for (const document of documents
      .slice()
      .sort((left, right) =>
        left.document.createdAt.localeCompare(right.document.createdAt),
      )) {
      let nextDocument = document;

      if (needsSnapshot(document)) {
        try {
          const snapshot = await generateWorkSnapshot(document);
          nextDocument = {
            ...document,
            preview: {
              snapshot,
            },
          };
          await saveWorkDocument(nextDocument);
          refreshedSnapshotCount += 1;
        } catch {
          nextDocument = document;
        }
      }

      zip.file(
        getUniqueArchiveFileName(nextDocument.document.title, usedNames),
        JSON.stringify(nextDocument, null, 2),
      );
    }

    zip.file(
      "manifest.json",
      JSON.stringify(
        {
          kind: "com.medal-forge.export",
          exportedAt: createTimestamp(),
          documentCount: documents.length,
          refreshedSnapshotCount,
        },
        null,
        2,
      ),
    );

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: {
        level: 6,
      },
    });
    downloadBlob(blob, `medal-forge-works-${Date.now()}.zip`);

    if (refreshedSnapshotCount > 0) {
      setWorks(await listSavedWorks());
    }
  }

  async function importWorkJsonFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";

    if (files.length === 0) {
      return;
    }

    setOpenMenuId(null);
    let importedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      try {
        const parsed = JSON.parse(await file.text()) as unknown;

        if (!isWorkDocument(parsed)) {
          skippedCount += 1;
          continue;
        }

        await saveWorkDocument(normalizeWorkDocument(parsed));
        importedCount += 1;
      } catch {
        skippedCount += 1;
      }
    }

    setWorks(await listSavedWorks());

    if (skippedCount > 0) {
      window.alert(`Imported ${importedCount} JSON files. Skipped ${skippedCount}.`);
    }
  }

  async function renameWork(work: SavedWorkSummary) {
    setOpenMenuId(null);
    const nextTitle = window.prompt("Rename work", work.title)?.trim();

    if (!nextTitle || nextTitle === work.title) {
      return;
    }

    const document = await getWorkDocument(work.id);
    if (!document) {
      setWorks((current) => current.filter((item) => item.id !== work.id));
      return;
    }

    const updatedAt = createTimestamp();
    const nextDocument: WorkDocument = {
      ...document,
      document: {
        ...document.document,
        title: nextTitle,
        updatedAt,
      },
    };

    await saveWorkDocument(nextDocument);
    setWorks((current) =>
      current.map((item) =>
        item.id === work.id
          ? {
              ...item,
              title: nextTitle,
              updatedAt,
            }
          : item,
      ),
    );
  }

  async function downloadWorkJson(work: SavedWorkSummary) {
    setOpenMenuId(null);

    const document = await getWorkDocument(work.id);
    if (!document) {
      setWorks((current) => current.filter((item) => item.id !== work.id));
      return;
    }

    let nextDocument = document;
    if (needsSnapshot(document)) {
      try {
        const snapshot = await generateWorkSnapshot(document);
        nextDocument = {
          ...document,
          preview: {
            snapshot,
          },
        };
        await saveWorkDocument(nextDocument);
        setWorks((current) =>
          current.map((item) =>
            item.id === work.id
              ? {
                  ...item,
                  snapshotDataUrl: snapshot.dataUrl,
                }
              : item,
          ),
        );
      } catch {
        nextDocument = document;
      }
    }

    downloadBlob(
      new Blob([JSON.stringify(nextDocument, null, 2)], {
        type: "application/json",
      }),
      `${getSafeFileStem(nextDocument.document.title)}.medal-forge.json`,
    );
  }

  async function exportWorkModel(
    work: SavedWorkSummary,
    format: ModelExportFormat,
  ) {
    setOpenMenuId(null);

    const document = await getWorkDocument(work.id);
    if (!document) {
      setWorks((current) => current.filter((item) => item.id !== work.id));
      return;
    }

    const asset = getPrimarySvgAsset(document);
    const option = getModelExportOption(format);
    enqueueModelExport({
      fileName: `${getSafeFileStem(document.document.title)}.${option.extension}`,
      format,
      settings: document.scene.settings,
      svgText: asset.text,
    });
  }

  async function deleteWork(work: SavedWorkSummary) {
    setOpenMenuId(null);

    if (!window.confirm(`Delete "${work.title}"?`)) {
      return;
    }

    await deleteWorkDocument(work.id);
    setWorks((current) => current.filter((item) => item.id !== work.id));
    setLoadingSnapshots((current) => {
      const next = { ...current };
      delete next[work.id];
      return next;
    });
    setLivePreviewDocuments((current) => {
      const next = { ...current };
      delete next[work.id];
      return next;
    });
    setLoadingLivePreviews((current) => {
      const next = { ...current };
      delete next[work.id];
      return next;
    });
    setReadyLivePreviews((current) => {
      const next = { ...current };
      delete next[work.id];
      return next;
    });
    delete livePreviewVersionsRef.current[work.id];
  }

  if (isBooting) {
    return (
      <main className="home-shell home-loading-shell">
        <div className="home-spinner" />
      </main>
    );
  }

  return (
    <main
      className="home-shell"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerCancel={handlePointerUp}
      onPointerUp={handlePointerUp}
      ref={viewportRef}
    >
      <div className="home-backdrop" aria-hidden="true" />
      {isLivePreviewEnabled ? (
        <HomeLivePreviewLayer
          documents={livePreviewDocuments}
          onReady={markLivePreviewReady}
          preview={livePreviewZoom}
          ref={livePreviewLayerRef}
          rotations={livePreviewRotations}
          viewportRef={viewportRef}
          works={positionedWorks}
        />
      ) : null}
      <div className="home-canvas">
        <div
          className="home-world"
          ref={worldRef}
        >
          {positionedWorks.map((work) => {
            const liveDocument = isLivePreviewEnabled
              ? livePreviewDocuments[work.id]
              : undefined;
            const livePreviewReady = readyLivePreviews[work.id];
            const livePreviewLoading =
              isLivePreviewEnabled &&
              (!liveDocument ||
                loadingLivePreviews[work.id] ||
                !livePreviewReady);

            return (
              <div
                className={
                  openMenuId === work.id ? "work-card menu-open" : "work-card"
                }
                key={work.id}
                onPointerDown={(event) => event.stopPropagation()}
                style={{
                  left: work.x,
                  top: work.y,
                }}
              >
                <button
                  className="work-card-open"
                  onClick={() => {
                    setOpenMenuId(null);
                    router.push(`/work/${work.id}`);
                  }}
                  type="button"
                >
	                  <span
	                    className={
	                      isLivePreviewEnabled
	                        ? "work-preview-frame live-preview"
	                        : "work-preview-frame"
	                    }
	                    data-live-preview-id={
	                      isLivePreviewEnabled ? work.id : undefined
	                    }
	                    onClick={(event) => {
	                      if (isLivePreviewEnabled) {
	                        event.stopPropagation();
	                      }
	                    }}
	                    onPointerCancel={handleLivePreviewPointerUp}
	                    onPointerDown={(event) =>
	                      handleLivePreviewPointerDown(event, work.id)
	                    }
	                    onPointerMove={handleLivePreviewPointerMove}
	                    onPointerUp={handleLivePreviewPointerUp}
	                  >
	                    {isLivePreviewEnabled ? (
	                      <>
	                        {livePreviewLoading && work.snapshotDataUrl ? (
	                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            alt=""
                            className="live-preview-cover"
	                            src={work.snapshotDataUrl}
	                          />
	                        ) : null}
	                      </>
                    ) : work.snapshotDataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img alt="" src={work.snapshotDataUrl} />
                    ) : (
                      <span className="home-spinner small" />
                    )}
                    {livePreviewLoading ? (
                      <span
                        className={
                          work.snapshotDataUrl
                            ? "live-preview-loading transparent"
                            : "live-preview-loading"
                        }
                      >
                        <span className="home-spinner small" />
                      </span>
                    ) : null}
                    {!isLivePreviewEnabled && loadingSnapshots[work.id] ? (
                      <span className="snapshot-loading-dot" />
                    ) : null}
                  </span>
                  <span className="work-card-title">{work.title}</span>
                </button>
              {isLivePreviewEnabled &&
              liveDocument &&
              !loadingLivePreviews[work.id] ? (
                <button
                  aria-label={`Preview ${work.title}`}
                  className="work-preview-zoom-trigger"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openLivePreviewZoom(work.id);
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openLivePreviewZoom(work.id);
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openLivePreviewZoom(work.id);
                  }}
                  type="button"
                >
                  <Eye size={16} />
                </button>
              ) : null}
              <button
                aria-label={`Open menu for ${work.title}`}
                aria-expanded={openMenuId === work.id}
                className="work-menu-trigger"
                onClick={(event) => toggleWorkMenu(event, work)}
                onPointerDown={(event) => event.stopPropagation()}
                type="button"
              >
                <MoreHorizontal size={17} />
              </button>
              </div>
            );
          })}
          {positionedShowcaseImportCard ? (
            <div
              className="work-card showcase-import-card"
              key={positionedShowcaseImportCard.id}
              onPointerDown={(event) => event.stopPropagation()}
              style={{
                left: positionedShowcaseImportCard.x,
                top: positionedShowcaseImportCard.y,
              }}
            >
              <button
                aria-label="Import showcase works"
                className="showcase-import-button"
                disabled={isImportingShowcase}
                onClick={importShowcaseWorks}
                type="button"
              >
                <span className="showcase-import-frame">
                  {isImportingShowcase ? (
                    <span className="home-spinner" />
                  ) : (
                    <Upload size={34} />
                  )}
                </span>
                <span className="work-card-title">
                  {isImportingShowcase ? "Importing..." : "Import Showcase"}
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>

      {isLivePreviewEnabled && livePreviewZoom ? (
        <>
          <button
            aria-label="Close preview"
            className={
              livePreviewZoom.phase === "closing"
                ? "live-preview-zoom-scrim closing"
                : "live-preview-zoom-scrim"
            }
            onClick={closeLivePreviewZoom}
            onPointerDown={(event) => event.stopPropagation()}
            type="button"
          />
          <div
            className={
              livePreviewZoom.phase === "closing"
                ? "live-preview-zoom-hitbox closing"
                : "live-preview-zoom-hitbox"
            }
            onClick={(event) => event.stopPropagation()}
            onPointerCancel={handleLivePreviewPointerUp}
            onPointerDown={(event) =>
              handleLivePreviewPointerDown(event, livePreviewZoom.workId)
            }
            onPointerMove={handleLivePreviewPointerMove}
            onPointerUp={handleLivePreviewPointerUp}
          />
        </>
      ) : null}

      {openMenuWork && workMenuAnchor && typeof document !== "undefined"
        ? createPortal(
            <div
              className="work-card-menu"
              onPointerDown={(event) => event.stopPropagation()}
              style={{
                right: workMenuAnchor.right,
                top: workMenuAnchor.top,
              }}
            >
              <button onClick={() => downloadWorkJson(openMenuWork)} type="button">
                Download JSON
              </button>
              {MODEL_EXPORT_OPTIONS.map((option) => (
                <button
                  key={option.format}
                  onClick={() => exportWorkModel(openMenuWork, option.format)}
                  type="button"
                >
                  Export {option.label}
                </button>
              ))}
              <button onClick={() => renameWork(openMenuWork)} type="button">
                Rename
              </button>
              <button
                className="danger"
                onClick={() => deleteWork(openMenuWork)}
                type="button"
              >
                Delete
              </button>
            </div>,
            document.body,
          )
        : null}

      <button
        aria-label="Export all works"
        className="home-action home-action-button home-action-export"
        onClick={exportAllWorkJson}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        <Download size={19} />
      </button>
      <button
        aria-label="Import works"
        className="home-action home-action-button home-action-import"
        onClick={() => importInputRef.current?.click()}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        <Upload size={19} />
      </button>
      <button
        className="home-action new-work-button home-action-new"
        onClick={createNewWork}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        <Plus size={17} />
        <span>New</span>
      </button>
      <button
        aria-label={
          isLivePreviewEnabled
            ? "Disable live 3D previews"
            : "Enable live 3D previews"
        }
        aria-pressed={isLivePreviewEnabled}
        className={
          isLivePreviewEnabled
            ? "home-action home-action-button home-action-live active"
            : "home-action home-action-button home-action-live"
        }
        onClick={toggleLivePreviewMode}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        <span className="cube-toggle-icon">
          <Box size={20} />
          <span className="cube-toggle-slash" />
        </span>
      </button>
      <input
        accept=".json,application/json"
        className="hidden-input"
        multiple
        onChange={importWorkJsonFiles}
        ref={importInputRef}
        type="file"
      />
      <ExportQueuePanel />
    </main>
  );
}
