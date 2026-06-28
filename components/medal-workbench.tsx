"use client";

import {
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  FileJson,
  Home,
  Layers3,
  LoaderCircle,
  Palette,
  Play,
  RotateCcw,
  Save,
  SlidersHorizontal,
  Upload,
} from "lucide-react";
import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { ExportQueuePanel } from "@/components/export-queue-panel";
import { ModelPreview } from "@/components/model-preview";
import { PresentationModeDialog } from "@/components/presentation-mode-dialog";
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
import { MATERIAL_PRESETS } from "@/lib/materials";
import { getShapeLabel, getSvgColor, resolveShapeSettings } from "@/lib/shape-settings";
import { summarizeSvgPaths } from "@/lib/svg-summary";
import {
  createWorkDocument,
  createWorkId,
  createWorkPayloadSignature,
  getPrimarySvgAsset,
} from "@/lib/work-document";
import { getWorkDocument, saveWorkDocument } from "@/lib/work-storage";
import { generateWorkSnapshot, needsSnapshot } from "@/lib/snapshot";
import { requestIdleTask } from "@/lib/idle";
import type {
  CanvasSettings,
  DomeSettings,
  MaterialId,
  MedalSettings,
  ModelQualitySettings,
  ShapeSettingsPatch,
  ShapeSvgAdjustments,
  ShapeWindingMode,
  SvgPathSummary,
  WorkDocument,
  WorkSnapshot,
} from "@/lib/types";

interface SegmentOption<T extends string> {
  label: string;
  value: T;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: SegmentOption<T>[];
  onChange: (value: T) => void;
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div
      className="segmented"
      style={{ "--segments": options.length } as CSSProperties}
    >
      {options.map((option) => (
        <button
          className={option.value === value ? "segment active" : "segment"}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

interface RangeControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}

function getNumericPrecision(step: number) {
  if (step >= 1) {
    return 0;
  }

  return step < 0.01 ? 3 : 2;
}

function formatNumericValue(value: number, step: number) {
  if (!Number.isFinite(value)) {
    return "";
  }

  return value.toFixed(getNumericPrecision(step));
}

function clampNumericValue(value: number, min?: number, max?: number) {
  let nextValue = value;

  if (typeof min === "number") {
    nextValue = Math.max(min, nextValue);
  }

  if (typeof max === "number") {
    nextValue = Math.min(max, nextValue);
  }

  return nextValue;
}

function normalizeNumericValue(
  value: number,
  step: number,
  min?: number,
  max?: number,
) {
  const base = typeof min === "number" ? min : 0;
  const precision = getNumericPrecision(step) + 2;
  const stepped =
    step > 0 ? Math.round((value - base) / step) * step + base : value;

  return clampNumericValue(Number(stepped.toFixed(precision)), min, max);
}

function getNumericDragDelta(
  movementX: number,
  step: number,
  min?: number,
  max?: number,
) {
  if (typeof min === "number" && typeof max === "number" && max > min) {
    return (movementX / 180) * (max - min);
  }

  return movementX * step;
}

interface NumericFieldProps {
  value: number;
  min?: number;
  max?: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}

function NumericField({
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: NumericFieldProps) {
  const [draft, setDraft] = useState(() => formatNumericValue(value, step));
  const [isEditing, setIsEditing] = useState(false);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const dragCleanupRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current();
    };
  }, []);

  function commitDraft() {
    const nextValue = Number(draft);

    setIsEditing(false);

    if (!Number.isFinite(nextValue)) {
      return;
    }

    const normalized = normalizeNumericValue(nextValue, step, min, max);
    valueRef.current = normalized;
    onChangeRef.current(normalized);
  }

  function cancelDraft() {
    setIsEditing(false);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    dragCleanupRef.current();

    const target = event.currentTarget;
    let isActive = true;

    const cleanup = (exitPointerLock = true) => {
      if (!isActive) {
        return;
      }

      isActive = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("pointerlockchange", handlePointerLockChange);

      if (exitPointerLock && document.pointerLockElement === target) {
        document.exitPointerLock();
      }

      dragCleanupRef.current = () => undefined;
    };

    const handleMouseMove = (mouseEvent: globalThis.MouseEvent) => {
      const delta = getNumericDragDelta(mouseEvent.movementX, step, min, max);
      const nextValue = normalizeNumericValue(
        valueRef.current + delta,
        step,
        min,
        max,
      );

      if (nextValue === valueRef.current) {
        return;
      }

      valueRef.current = nextValue;
      onChangeRef.current(nextValue);
    };

    const handleMouseUp = () => cleanup(true);

    const handlePointerLockChange = () => {
      if (document.pointerLockElement !== target) {
        cleanup(false);
      }
    };

    dragCleanupRef.current = cleanup;
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp, { once: true });
    document.addEventListener("pointerlockchange", handlePointerLockChange);

    try {
      target.requestPointerLock();
    } catch {
      // Pointer lock can fail in restricted browser contexts; document drag still works.
    }
  }

  return (
    <span className="numeric-field">
      <button
        aria-label="Drag value"
        className="numeric-drag-zone"
        onPointerDown={startDrag}
        type="button"
      />
      <span className="numeric-input-wrap">
        <input
          className="numeric-input"
          inputMode="decimal"
          onBlur={commitDraft}
          onChange={(event) => setDraft(event.target.value)}
          onFocus={(event) => {
            setDraft(formatNumericValue(valueRef.current, step));
            setIsEditing(true);
            event.currentTarget.select();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }

            if (event.key === "Escape") {
              event.preventDefault();
              cancelDraft();
              event.currentTarget.blur();
            }
          }}
          spellCheck={false}
          value={isEditing ? draft : formatNumericValue(value, step)}
        />
        {unit ? <span className="numeric-unit">{unit}</span> : null}
      </span>
      <button
        aria-label="Drag value"
        className="numeric-drag-zone"
        onPointerDown={startDrag}
        type="button"
      />
    </span>
  );
}

function RangeControl({
  label,
  value,
  min,
  max,
  step,
  unit = "",
  onChange,
}: RangeControlProps) {
  return (
    <label className="control-row">
      <span className="label-line">
        <span>{label}</span>
      </span>
      <NumericField
        max={max}
        min={min}
        onChange={onChange}
        step={step}
        unit={unit}
        value={value}
      />
    </label>
  );
}

interface NumberControlProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  onReset?: () => void;
}

function NumberControl({
  label,
  value,
  min,
  max,
  step = 0.1,
  onChange,
  onReset,
}: NumberControlProps) {
  return (
    <label className="control-row">
      <span className="label-line">
        <span>{label}</span>
      </span>
      <span className={onReset ? "control-field with-reset" : "control-field"}>
        <NumericField
          max={max}
          min={min}
          onChange={onChange}
          step={step}
          value={Number.isFinite(value) ? value : 0}
        />
        {onReset ? (
          <button className="mini-action" onClick={onReset} type="button">
            <RotateCcw size={12} />
            Reset
          </button>
        ) : null}
      </span>
    </label>
  );
}

interface MaterialSelectProps {
  label: string;
  value: MaterialId;
  onChange: (value: MaterialId) => void;
}

function MaterialPreview({ src }: { src: string }) {
  return (
    <span
      aria-hidden="true"
      className="material-preview"
      style={{ "--material-preview-src": `url(${src})` } as CSSProperties}
    />
  );
}

function MaterialSelect({ label, value, onChange }: MaterialSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedMaterial =
    MATERIAL_PRESETS.find((material) => material.id === value) ??
    MATERIAL_PRESETS[0];

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handlePointerDown(event: globalThis.PointerEvent) {
      if (
        event.target instanceof Node &&
        rootRef.current?.contains(event.target)
      ) {
        return;
      }

      setIsOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div className="control-row">
      <span className="label-line">
        <span>{label}</span>
      </span>
      <div className="material-select" ref={rootRef}>
        <button
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          className="material-select-trigger"
          onClick={() => setIsOpen((current) => !current)}
          type="button"
        >
          <MaterialPreview src={selectedMaterial.previewSrc} />
          <span className="material-select-name">{selectedMaterial.name}</span>
          <ChevronDown
            className={isOpen ? "material-select-chevron open" : "material-select-chevron"}
            size={16}
          />
        </button>
        {isOpen ? (
          <div className="material-select-menu" role="listbox">
            {MATERIAL_PRESETS.map((material) => {
              const selected = material.id === value;

              return (
                <button
                  aria-selected={selected}
                  className={
                    selected
                      ? "material-select-option selected"
                      : "material-select-option"
                  }
                  key={material.id}
                  onClick={() => {
                    onChange(material.id);
                    setIsOpen(false);
                  }}
                  role="option"
                  type="button"
                >
                  <MaterialPreview src={material.previewSrc} />
                  <span className="material-select-option-text">
                    <span>{material.name}</span>
                    <small>
                      Metal {material.metalness.toFixed(2)} / Rough{" "}
                      {material.roughness.toFixed(2)}
                    </small>
                  </span>
                  {selected ? <Check size={15} /> : null}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getFileStem(fileName: string) {
  return fileName.replace(/\.svg$/i, "").replace(/[^\w.-]+/g, "-") || "medal";
}

function getSummaryByIndex(summaries: SvgPathSummary[], pathIndex: number) {
  return summaries.find((summary) => summary.pathIndex === pathIndex);
}

function getSummaryNumber(
  summary: SvgPathSummary | undefined,
  key: string,
  fallback = 0,
) {
  const parsed = Number.parseFloat(summary?.attributes[key] ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getRectCornerRadius(summary: SvgPathSummary | undefined) {
  return getSummaryNumber(
    summary,
    "rx",
    getSummaryNumber(summary, "ry", 0),
  );
}

const WINDING_OPTIONS: SegmentOption<ShapeWindingMode>[] = [
  {
    label: "SVG",
    value: "svg",
  },
  {
    label: "CW",
    value: "solidCw",
  },
  {
    label: "CCW",
    value: "solidCcw",
  },
];

function createTimestamp() {
  return new Date().toISOString();
}

export function createWorkTitle(fileName: string) {
  return getFileStem(fileName);
}

interface MedalWorkbenchProps {
  initialWorkId?: string;
}

export function MedalWorkbench({ initialWorkId }: MedalWorkbenchProps) {
  const router = useRouter();
  const [settings, setSettings] = useState<MedalSettings>(DEFAULT_SETTINGS);
  const [svgText, setSvgText] = useState(DEFAULT_SVG);
  const [fileName, setFileName] = useState(DEFAULT_FILE_NAME);
  const defaultTitle = createWorkTitle(DEFAULT_FILE_NAME);
  const [workMeta, setWorkMeta] = useState(() => {
    const createdAt = createTimestamp();

    return {
      id: createWorkId(),
      title: defaultTitle,
      createdAt,
      snapshot: null as WorkSnapshot | null,
    };
  });
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(defaultTitle);
  const [selectedPathIndexes, setSelectedPathIndexes] = useState<number[]>([]);
  const [hoveredPathIndex, setHoveredPathIndex] = useState<number | null>(null);
  const [isDragActive, setIsDragActive] = useState(false);
  const [isDocumentReady, setIsDocumentReady] = useState(!initialWorkId);
  const [status, setStatus] = useState(initialWorkId ? "Loading work" : "Ready");
  const [isBusy, setIsBusy] = useState(false);
  const [isAutoSaveAnimating, setIsAutoSaveAnimating] = useState(false);
  const [isPresentationOpen, setIsPresentationOpen] = useState(false);
  const [editingLayerPathIndex, setEditingLayerPathIndex] = useState<number | null>(
    null,
  );
  const [layerNameDraft, setLayerNameDraft] = useState("");
  const [hasPersistedWork, setHasPersistedWork] = useState(false);
  const selectionAnchorRef = useRef<number | null>(null);
  const suppressLayerClickRef = useRef(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleEditCancelledRef = useRef(false);
  const layerNameInputRef = useRef<HTMLInputElement>(null);
  const layerNameEditCancelledRef = useRef(false);
  const autoSaveSpinnerTimerRef = useRef<number | null>(null);
  const isImportingSvgRef = useRef(false);
  const [lastSavedSignature, setLastSavedSignature] = useState(() =>
    createWorkPayloadSignature({
      title: defaultTitle,
      fileName: DEFAULT_FILE_NAME,
      svgText: DEFAULT_SVG,
      settings: DEFAULT_SETTINGS,
      selectedPathIndexes: [],
    }),
  );

  const pathSummaries = useMemo(() => summarizeSvgPaths(svgText), [svgText]);
  const activePathSummaries = useMemo(
    () =>
      pathSummaries.filter(
        (summary) =>
          !resolveShapeSettings(settings, summary.pathIndex, summary).deleted,
      ),
    [pathSummaries, settings],
  );
  const selectedSummaries = useMemo(
    () =>
      selectedPathIndexes
        .map((pathIndex) => getSummaryByIndex(activePathSummaries, pathIndex))
        .filter((summary): summary is SvgPathSummary => Boolean(summary)),
    [activePathSummaries, selectedPathIndexes],
  );
  const activeSummary = selectedSummaries[0];
  const activeShapeSettings = activeSummary
    ? resolveShapeSettings(settings, activeSummary.pathIndex, activeSummary)
    : null;
  const activeDomeSettings = settings.dome ?? DEFAULT_SETTINGS.dome;
  const activeQualitySettings = settings.quality ?? DEFAULT_SETTINGS.quality;
  const currentSignature = useMemo(
    () =>
      createWorkPayloadSignature({
        title: workMeta.title,
        fileName,
        svgText,
        settings,
        selectedPathIndexes,
      }),
    [fileName, selectedPathIndexes, settings, svgText, workMeta.title],
  );

  const hasUnsavedChanges = useCallback(() => {
    return lastSavedSignature !== currentSignature;
  }, [currentSignature, lastSavedSignature]);

  const createCurrentWorkDocument = useCallback(
    (
      updatedAt = createTimestamp(),
      snapshot = workMeta.snapshot,
      titleOverride?: string,
    ): WorkDocument => {
      const title = titleOverride?.trim() || workMeta.title.trim() || createWorkTitle(fileName);

      return createWorkDocument({
        id: workMeta.id,
        title,
        createdAt: workMeta.createdAt,
        updatedAt,
        fileName,
        svgText,
        settings,
        selectedPathIndexes,
        snapshot,
      });
    },
    [
      fileName,
      selectedPathIndexes,
      settings,
      svgText,
      workMeta.createdAt,
      workMeta.id,
      workMeta.snapshot,
      workMeta.title,
    ],
  );

  const saveCurrentWork = useCallback(async (quiet = false, titleOverride?: string) => {
    let document = createCurrentWorkDocument(
      createTimestamp(),
      workMeta.snapshot,
      titleOverride,
    );

    if (needsSnapshot(document)) {
      try {
        const snapshot = await generateWorkSnapshot(document);
        document = {
          ...document,
          preview: {
            snapshot,
          },
        };
      } catch {
        document = {
          ...document,
          preview: {
            snapshot: workMeta.snapshot,
          },
        };
      }
    }

    await saveWorkDocument(document);
    setLastSavedSignature(
      createWorkPayloadSignature({
        title: document.document.title,
        fileName,
        svgText,
        settings,
        selectedPathIndexes,
      }),
    );
    setWorkMeta({
      id: document.document.id,
      title: document.document.title,
      createdAt: document.document.createdAt,
      snapshot: document.preview.snapshot,
    });
    setHasPersistedWork(true);

    if (!quiet) {
      setStatus(`Saved ${document.document.title}`);
    }

    return document;
  }, [
    createCurrentWorkDocument,
    fileName,
    selectedPathIndexes,
    settings,
    svgText,
    workMeta.snapshot,
  ]);

  function applyWorkDocument(document: WorkDocument) {
    const asset = getPrimarySvgAsset(document);

    setSvgText(asset.text);
    setFileName(asset.fileName);
    setSettings(document.scene.settings);
    setSelectedPathIndexes(document.editorState.selectedPathIndexes);
    setHoveredPathIndex(null);
    setEditingLayerPathIndex(null);
    setLayerNameDraft("");
    selectionAnchorRef.current =
      document.editorState.selectedPathIndexes[0] ?? null;
    setWorkMeta({
      id: document.document.id,
      title: document.document.title,
      createdAt: document.document.createdAt,
      snapshot: document.preview.snapshot,
    });
    setHasPersistedWork(true);
    setTitleDraft(document.document.title);
    setLastSavedSignature(
      createWorkPayloadSignature({
        title: document.document.title,
        fileName: asset.fileName,
        svgText: asset.text,
        settings: document.scene.settings,
        selectedPathIndexes: document.editorState.selectedPathIndexes,
      }),
    );
  }

  function normalizeTitleDraft() {
    return titleDraft.trim() || workMeta.title.trim() || createWorkTitle(fileName);
  }

  function beginTitleEdit() {
    titleEditCancelledRef.current = false;
    setTitleDraft(workMeta.title);
    setIsEditingTitle(true);
  }

  function commitTitleEdit() {
    if (titleEditCancelledRef.current) {
      titleEditCancelledRef.current = false;
      return;
    }

    const nextTitle = normalizeTitleDraft();
    setIsEditingTitle(false);
    setTitleDraft(nextTitle);

    if (nextTitle !== workMeta.title) {
      setWorkMeta((current) => ({
        ...current,
        title: nextTitle,
      }));
      setStatus(`Renamed ${nextTitle}`);
    }
  }

  function cancelTitleEdit() {
    titleEditCancelledRef.current = true;
    setTitleDraft(workMeta.title);
    setIsEditingTitle(false);
  }

  function handleTitleKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitTitleEdit();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelTitleEdit();
    }
  }

  async function confirmBeforeReplacingWork(
    actionLabel: string,
    titleOverride?: string,
  ) {
    const hasTitleOverrideChange =
      Boolean(titleOverride) && titleOverride !== workMeta.title;

    if (!hasTitleOverrideChange && !hasUnsavedChanges()) {
      return true;
    }

    const shouldSave = window.confirm(
      `当前作品有未保存更改。${actionLabel} 会丢失当前编辑状态。是否先保存当前作品？`,
    );

    if (shouldSave) {
      try {
        await saveCurrentWork(true, titleOverride);
        return true;
      } catch {
        setStatus("Save failed");
        return false;
      }
    }

    return window.confirm(`不保存并继续${actionLabel}吗？当前编辑状态会丢失。`);
  }

  async function goHome() {
    const pendingTitle = isEditingTitle ? normalizeTitleDraft() : undefined;

    if (isEditingTitle) {
      commitTitleEdit();
    }

    const canLeave = await confirmBeforeReplacingWork("返回首页", pendingTitle);

    if (canLeave) {
      router.push("/");
    }
  }

  function updateCanvasSetting<K extends keyof CanvasSettings>(
    key: K,
    value: CanvasSettings[K],
  ) {
    setSettings((current) => ({
      ...current,
      canvas: {
        ...current.canvas,
        [key]: value,
      },
    }));
  }

  function updateDomeSetting<K extends keyof DomeSettings>(
    key: K,
    value: DomeSettings[K],
  ) {
    setSettings((current) => ({
      ...current,
      dome: {
        ...DEFAULT_SETTINGS.dome,
        ...current.dome,
        [key]: value,
      },
    }));
  }

  function updateQualitySetting<K extends keyof ModelQualitySettings>(
    key: K,
    value: ModelQualitySettings[K],
  ) {
    setSettings((current) => ({
      ...current,
      quality: {
        ...DEFAULT_SETTINGS.quality,
        ...current.quality,
        [key]: value,
      },
    }));
  }

  function updateShapes(
    pathIndexes: number[],
    patchOrFactory:
      | ShapeSettingsPatch
      | ((summary: SvgPathSummary) => ShapeSettingsPatch),
  ) {
    if (pathIndexes.length === 0) {
      return;
    }

    setSettings((current) => {
      const nextShapeSettings = { ...current.shapeSettings };

      for (const pathIndex of pathIndexes) {
        const summary = getSummaryByIndex(pathSummaries, pathIndex);
        if (!summary) {
          continue;
        }

        const patch =
          typeof patchOrFactory === "function"
            ? patchOrFactory(summary)
            : patchOrFactory;

        nextShapeSettings[String(pathIndex)] = {
          ...nextShapeSettings[String(pathIndex)],
          ...patch,
        };
      }

      return {
        ...current,
        shapeSettings: nextShapeSettings,
      };
    });
  }

  function updateSelectedShapes(patch: ShapeSettingsPatch) {
    updateShapes(selectedPathIndexes, patch);
  }

  function getLayerLabel(
    summary: SvgPathSummary,
    shapeSettings?: { name?: string },
  ) {
    return shapeSettings?.name?.trim() || getShapeLabel(summary);
  }

  function beginLayerNameEdit(
    summary: SvgPathSummary,
    shapeSettings: { name?: string },
  ) {
    layerNameEditCancelledRef.current = false;
    setEditingLayerPathIndex(summary.pathIndex);
    setLayerNameDraft(getLayerLabel(summary, shapeSettings));
  }

  function commitLayerNameEdit(pathIndex: number, summary: SvgPathSummary) {
    if (layerNameEditCancelledRef.current) {
      layerNameEditCancelledRef.current = false;
      return;
    }

    const fallbackName = getShapeLabel(summary);
    const nextName = layerNameDraft.trim();

    setEditingLayerPathIndex(null);
    setLayerNameDraft("");
    updateShapes([pathIndex], {
      name: nextName && nextName !== fallbackName ? nextName : undefined,
    });
    setStatus(nextName ? `Renamed layer to ${nextName}` : "Reset layer name");
  }

  function cancelLayerNameEdit() {
    layerNameEditCancelledRef.current = true;
    setEditingLayerPathIndex(null);
    setLayerNameDraft("");
  }

  function handleLayerNameKeyDown(
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      cancelLayerNameEdit();
    }
  }

  function updateActiveSvgAdjustment<K extends keyof ShapeSvgAdjustments>(
    key: K,
    value: ShapeSvgAdjustments[K],
  ) {
    if (!activeSummary || !activeShapeSettings) {
      return;
    }

    updateShapes([activeSummary.pathIndex], {
      svgAdjustments: {
        ...activeShapeSettings.svgAdjustments,
        [key]: value,
      },
    });
  }

  function resetActiveSvgAdjustment<K extends keyof ShapeSvgAdjustments>(key: K) {
    if (!activeSummary || !activeShapeSettings) {
      return;
    }

    const nextAdjustments = {
      ...activeShapeSettings.svgAdjustments,
    };
    delete nextAdjustments[key];

    updateShapes([activeSummary.pathIndex], {
      svgAdjustments: nextAdjustments,
    });
  }

  function getPathOrder() {
    return activePathSummaries.map((summary) => summary.pathIndex);
  }

  function sortPathIndexes(pathIndexes: number[]) {
    const order = getPathOrder();
    return Array.from(new Set(pathIndexes)).sort(
      (left, right) => order.indexOf(left) - order.indexOf(right),
    );
  }

  function getRangePathIndexes(fromPathIndex: number, toPathIndex: number) {
    const order = getPathOrder();
    const from = order.indexOf(fromPathIndex);
    const to = order.indexOf(toPathIndex);

    if (from === -1 || to === -1) {
      return [toPathIndex];
    }

    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return order.slice(start, end + 1);
  }

  function selectLayer(
    pathIndex: number,
    event: Pick<
      MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>,
      "ctrlKey" | "metaKey" | "preventDefault" | "shiftKey"
    >,
  ) {
    const summary = getSummaryByIndex(pathSummaries, pathIndex);
    const shapeSettings = summary
      ? resolveShapeSettings(settings, pathIndex, summary)
      : undefined;
    const additive = event.metaKey || event.ctrlKey;
    const ranged = event.shiftKey;

    event.preventDefault();

    setSelectedPathIndexes((current) => {
      if (ranged) {
        const anchor =
          selectionAnchorRef.current ?? current[0] ?? pathIndex;
        const range = getRangePathIndexes(anchor, pathIndex);
        return additive ? sortPathIndexes([...current, ...range]) : range;
      }

      selectionAnchorRef.current = pathIndex;

      if (!additive) {
        return [pathIndex];
      }

      return current.includes(pathIndex)
        ? current.filter((item) => item !== pathIndex)
        : sortPathIndexes([...current, pathIndex]);
    });

    setStatus(
      ranged
        ? "Selected layer range"
        : `${additive ? "Toggled" : "Selected"} ${summary ? getLayerLabel(summary, shapeSettings) : `#${pathIndex}`}`,
    );
  }

  function handleLayerPointerDown(
    pathIndex: number,
    event: PointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) {
      return;
    }

    suppressLayerClickRef.current = true;
    selectLayer(pathIndex, event);
  }

  function handleLayerClick(
    pathIndex: number,
    event: MouseEvent<HTMLDivElement>,
  ) {
    if (suppressLayerClickRef.current) {
      suppressLayerClickRef.current = false;
      return;
    }

    selectLayer(pathIndex, event);
  }

  function clearSelection() {
    selectionAnchorRef.current = null;
    setSelectedPathIndexes([]);
    setStatus("Selection cleared");
  }

  const deleteSelectedLayers = useCallback(() => {
    const pathIndexesToDelete = selectedPathIndexes.filter((pathIndex) =>
      activePathSummaries.some((summary) => summary.pathIndex === pathIndex),
    );

    if (pathIndexesToDelete.length === 0) {
      return;
    }

    setSettings((current) => {
      const nextShapeSettings = { ...current.shapeSettings };

      for (const pathIndex of pathIndexesToDelete) {
        nextShapeSettings[String(pathIndex)] = {
          ...nextShapeSettings[String(pathIndex)],
          deleted: true,
        };
      }

      return {
        ...current,
        shapeSettings: nextShapeSettings,
      };
    });

    setHoveredPathIndex(null);
    selectionAnchorRef.current = null;
    setSelectedPathIndexes([]);
    setStatus(
      pathIndexesToDelete.length === 1
        ? "Deleted 1 layer"
        : `Deleted ${pathIndexesToDelete.length} layers`,
    );
  }, [activePathSummaries, selectedPathIndexes]);

  useEffect(() => {
    const activePathIndexes = new Set(
      activePathSummaries.map((summary) => summary.pathIndex),
    );

    setSelectedPathIndexes((current) => {
      const next = current.filter((pathIndex) => activePathIndexes.has(pathIndex));

      if (next.length === current.length) {
        return current;
      }

      selectionAnchorRef.current = next[0] ?? null;
      return next;
    });

    setHoveredPathIndex((current) =>
      current !== null && !activePathIndexes.has(current) ? null : current,
    );

    setEditingLayerPathIndex((current) =>
      current !== null && !activePathIndexes.has(current) ? null : current,
    );
  }, [activePathSummaries]);

  useEffect(() => {
    function isTypingTarget(target: EventTarget | null) {
      if (!(target instanceof HTMLElement)) {
        return false;
      }

      return (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable
      );
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const allPathIndexes = activePathSummaries.map(
          (summary) => summary.pathIndex,
        );
        selectionAnchorRef.current = allPathIndexes[0] ?? null;
        setSelectedPathIndexes(allPathIndexes);
        setStatus(
          allPathIndexes.length > 0
            ? `Selected ${allPathIndexes.length} layers`
            : "No layers to select",
        );
        return;
      }

      if (
        (event.key === "Delete" || event.key === "Backspace") &&
        selectedPathIndexes.length > 0
      ) {
        event.preventDefault();
        deleteSelectedLayers();
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        selectionAnchorRef.current = null;
        setSelectedPathIndexes([]);
        setStatus("Selection cleared");
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePathSummaries, deleteSelectedLayers, selectedPathIndexes]);

  useEffect(() => {
    if (!initialWorkId) {
      return;
    }

    let active = true;

    getWorkDocument(initialWorkId)
      .then((document) => {
        if (!active) {
          return;
        }

        if (!document) {
          const createdAt = createTimestamp();
          const title = createWorkTitle(DEFAULT_FILE_NAME);
          setWorkMeta({
            id: initialWorkId,
            title,
            createdAt,
            snapshot: null,
          });
          setTitleDraft(title);
          setHasPersistedWork(false);
          setStatus("New unsaved work");
          setIsDocumentReady(true);
          return;
        }

        applyWorkDocument(document);
        setStatus(`Loaded ${document.document.title}`);
        setIsDocumentReady(true);
      })
      .catch(() => {
        if (active) {
          setStatus("Load failed");
          setIsDocumentReady(true);
        }
      });

    return () => {
      active = false;
    };
  }, [initialWorkId]);

  useEffect(() => {
    if (!isEditingTitle) {
      return;
    }

    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isEditingTitle]);

  useEffect(() => {
    if (editingLayerPathIndex === null) {
      return;
    }

    layerNameInputRef.current?.focus();
    layerNameInputRef.current?.select();
  }, [editingLayerPathIndex]);

  const finishAutoSaveSpinner = useCallback((startedAt: number) => {
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, 1000 - elapsed);

    if (autoSaveSpinnerTimerRef.current !== null) {
      window.clearTimeout(autoSaveSpinnerTimerRef.current);
    }

    autoSaveSpinnerTimerRef.current = window.setTimeout(() => {
      setIsAutoSaveAnimating(false);
      autoSaveSpinnerTimerRef.current = null;
    }, remaining);
  }, []);

  const runAutoSave = useCallback(async () => {
    const startedAt = Date.now();

    if (autoSaveSpinnerTimerRef.current !== null) {
      window.clearTimeout(autoSaveSpinnerTimerRef.current);
      autoSaveSpinnerTimerRef.current = null;
    }

    setIsAutoSaveAnimating(true);

    try {
      await saveCurrentWork(true);
      setStatus("Auto saved");
    } catch {
      setStatus("Auto save failed");
    } finally {
      finishAutoSaveSpinner(startedAt);
    }
  }, [finishAutoSaveSpinner, saveCurrentWork]);

  useEffect(() => {
    if (!isDocumentReady || !hasUnsavedChanges()) {
      return;
    }

    let cancelIdle: () => void = () => undefined;
    const timer = window.setTimeout(() => {
      cancelIdle = requestIdleTask(() => {
        void runAutoSave();
      }, 2000);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
      cancelIdle();
    };
  }, [hasUnsavedChanges, isDocumentReady, runAutoSave]);

  useEffect(() => {
    return () => {
      if (autoSaveSpinnerTimerRef.current !== null) {
        window.clearTimeout(autoSaveSpinnerTimerRef.current);
      }
    };
  }, []);

  function resetForNewWork(nextFileName: string, preserveCurrentDraft = false) {
    const createdAt = createTimestamp();
    const title = createWorkTitle(nextFileName);
    setWorkMeta({
      id: preserveCurrentDraft ? workMeta.id : createWorkId(),
      title,
      createdAt: preserveCurrentDraft ? workMeta.createdAt : createdAt,
      snapshot: null,
    });
    setIsEditingTitle(false);
    setTitleDraft(title);
    titleEditCancelledRef.current = false;
    setHasPersistedWork(false);
    setSelectedPathIndexes([]);
    setHoveredPathIndex(null);
    setEditingLayerPathIndex(null);
    setLayerNameDraft("");
    selectionAnchorRef.current = null;
    setLastSavedSignature("");
  }

  async function loadSvgFile(file: File) {
    if (isImportingSvgRef.current) {
      setStatus("Import already in progress");
      return;
    }

    if (!file.name.toLowerCase().endsWith(".svg")) {
      setStatus("Only SVG uploads are accepted");
      return;
    }

    const canReplace = await confirmBeforeReplacingWork("导入新的 SVG");
    if (!canReplace) {
      setStatus("Import cancelled");
      return;
    }

    isImportingSvgRef.current = true;
    setIsBusy(true);
    setStatus(`Loading ${file.name}`);

    try {
      const text = await file.text();

      flushSync(() => {
        resetForNewWork(file.name, !hasPersistedWork);
        setSvgText(text);
        setFileName(file.name);
        setSettings((current) => ({
          ...current,
          shapeSettings: {},
        }));
      });

      setStatus(`Loaded ${file.name}`);
    } catch {
      setStatus("Import failed");
    } finally {
      isImportingSvgRef.current = false;
      setIsBusy(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    await loadSvgFile(file);
  }

  function handleDropzoneDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragActive(true);
  }

  function handleDropzoneDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragActive(false);
  }

  async function handleDropzoneDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDragActive(false);

    const file = event.dataTransfer.files[0];
    if (file) {
      await loadSvgFile(file);
    }
  }

  function exportModel(format: ModelExportFormat) {
    if (isImportingSvgRef.current) {
      setStatus("Finish loading SVG before exporting");
      return;
    }

    const option = getModelExportOption(format);

    enqueueModelExport({
      fileName: `${getFileStem(fileName)}.${option.extension}`,
      format,
      settings,
      svgText,
    });
    setStatus(`${option.label} export queued`);
  }

  async function saveWork() {
    const titleOverride = isEditingTitle ? normalizeTitleDraft() : undefined;

    if (isEditingTitle) {
      commitTitleEdit();
    }

    setIsBusy(true);
    setStatus("Saving work");

    try {
      await saveCurrentWork(false, titleOverride);
    } catch {
      setStatus("Save failed");
    } finally {
      setIsBusy(false);
    }
  }

  async function exportWorkJson() {
    if (isImportingSvgRef.current) {
      setStatus("Finish loading SVG before exporting");
      return;
    }

    let document = createCurrentWorkDocument(
      createTimestamp(),
      workMeta.snapshot,
      isEditingTitle ? normalizeTitleDraft() : undefined,
    );

    if (needsSnapshot(document)) {
      try {
        const snapshot = await generateWorkSnapshot(document);
        document = {
          ...document,
          preview: {
            snapshot,
          },
        };
      } catch {
        document = {
          ...document,
          preview: {
            snapshot: workMeta.snapshot,
          },
        };
      }
    }

    const blob = new Blob([JSON.stringify(document, null, 2)], {
      type: "application/json",
    });

    downloadBlob(blob, `${getFileStem(fileName)}.medal-forge.json`);
    setStatus("Work JSON exported");
  }

  const selectedCount = selectedPathIndexes.length;
  const hasPendingTitleDraft =
    isEditingTitle && normalizeTitleDraft() !== workMeta.title;
  const hasPendingChanges = hasUnsavedChanges() || hasPendingTitleDraft;
  const saveButtonStateClass = isAutoSaveAnimating
    ? "saving"
    : hasPendingChanges
      ? "primary"
      : "outline";
  const saveButtonLabel = isAutoSaveAnimating
    ? "Saving"
    : hasPendingChanges
      ? "Save"
      : "Saved";

  if (!isDocumentReady) {
    return (
      <div className="app-shell loading-shell">
        <div className="loading-state">Loading work</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <button
            aria-label="Back to home"
            className="home-button"
            onClick={() => void goHome()}
            type="button"
          >
            <Home size={17} />
          </button>
          {isEditingTitle ? (
            <input
              aria-label="Work name"
              className="work-title-input"
              onBlur={commitTitleEdit}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={handleTitleKeyDown}
              ref={titleInputRef}
              value={titleDraft}
            />
          ) : (
            <button
              className="work-title-button"
              onClick={beginTitleEdit}
              title={workMeta.title}
              type="button"
            >
              {workMeta.title}
            </button>
          )}
        </div>
        <div className="topbar-actions">
          <button
            aria-label="Open presentation mode"
            className={
              isPresentationOpen
                ? "icon-button presentation-trigger active"
                : "icon-button presentation-trigger"
            }
            onClick={() => setIsPresentationOpen(true)}
            title="Presentation mode"
            type="button"
          >
            <Play size={15} />
          </button>
          <ExportQueuePanel variant="toolbar" />
          <button
            aria-label="Save work"
            className={`text-button save-action ${saveButtonStateClass}`}
            disabled={isBusy}
            onClick={saveWork}
            title={status}
            type="button"
          >
            {isAutoSaveAnimating ? (
              <LoaderCircle className="spin-icon" size={15} />
            ) : (
              <Save size={15} />
            )}
            {saveButtonLabel}
          </button>
        </div>
      </header>

      {isPresentationOpen ? (
        <PresentationModeDialog
          disabled={isBusy}
          fileStem={getFileStem(fileName)}
          onClose={() => setIsPresentationOpen(false)}
          onStatus={setStatus}
          settings={settings}
          svgText={svgText}
        />
      ) : null}

      <main className="workspace">
        <aside className="layers-sidebar">
          <div className="panel-scroll">
            <section className="panel-section">
              <div className="section-title">
                <span>Input</span>
                <Upload size={14} />
              </div>
              <div className="control-stack">
                <button
                  className={
                    isDragActive
                      ? "upload-dropzone drag-active"
                      : "upload-dropzone"
                  }
                  disabled={isBusy}
                  onClick={() => uploadInputRef.current?.click()}
                  onDragLeave={handleDropzoneDragLeave}
                  onDragOver={handleDropzoneDragOver}
                  onDrop={handleDropzoneDrop}
                  type="button"
                >
                  <Upload size={18} />
                  <span>Drop SVG here</span>
                  <small>or click to upload</small>
                </button>
                <input
                  accept=".svg,image/svg+xml"
                  className="hidden-input"
                  disabled={isBusy}
                  onChange={handleFileChange}
                  ref={uploadInputRef}
                  type="file"
                />
              </div>
            </section>

            <section className="panel-section">
              <div className="section-title">
                <span>Layers</span>
                <Layers3 size={14} />
              </div>
              <div className="layer-list">
                {activePathSummaries.map((summary) => {
                  const shapeSettings = resolveShapeSettings(
                    settings,
                    summary.pathIndex,
                    summary,
                  );
                  const selected = selectedPathIndexes.includes(summary.pathIndex);
                  const layerLabel = getLayerLabel(summary, shapeSettings);
                  const isEditingLayerName =
                    editingLayerPathIndex === summary.pathIndex;

                  return (
                    <div
                      aria-label={layerLabel}
                      aria-selected={selected}
                      className={[
                        "layer-item",
                        selected ? "selected" : "",
                        hoveredPathIndex === summary.pathIndex ? "hovered" : "",
                        isEditingLayerName ? "editing" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      key={summary.pathIndex}
                      onClick={(event) => handleLayerClick(summary.pathIndex, event)}
                      onContextMenu={(event) => event.preventDefault()}
                      onMouseEnter={() => setHoveredPathIndex(summary.pathIndex)}
                      onMouseLeave={() =>
                        setHoveredPathIndex((current) =>
                          current === summary.pathIndex ? null : current,
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) {
                          return;
                        }

                        if (event.key === "Enter" || event.key === " ") {
                          selectLayer(summary.pathIndex, event);
                        }
                      }}
                      onPointerDown={(event) =>
                        handleLayerPointerDown(summary.pathIndex, event)
                      }
                      role="option"
                      tabIndex={0}
                    >
                      <span
                        className="material-swatch"
                        style={{ background: shapeSettings.color }}
                      />
                      {isEditingLayerName ? (
                        <input
                          aria-label={`Rename ${layerLabel}`}
                          className="layer-name-input"
                          onBlur={() =>
                            commitLayerNameEdit(summary.pathIndex, summary)
                          }
                          onChange={(event) =>
                            setLayerNameDraft(event.target.value)
                          }
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={handleLayerNameKeyDown}
                          onPointerDown={(event) => event.stopPropagation()}
                          ref={layerNameInputRef}
                          value={layerNameDraft}
                        />
                      ) : (
                        <button
                          className="layer-name-button"
                          onClick={(event) => {
                            event.stopPropagation();

                            if (
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              !selected
                            ) {
                              selectLayer(summary.pathIndex, event);
                              return;
                            }

                            beginLayerNameEdit(summary, shapeSettings);
                          }}
                          onPointerDown={(event) => event.stopPropagation()}
                          title={layerLabel}
                          type="button"
                        >
                          {layerLabel}
                        </button>
                      )}
                      <button
                        aria-label={
                          shapeSettings.visible
                            ? `Hide ${layerLabel}`
                            : `Show ${layerLabel}`
                        }
                        className="icon-button layer-eye"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          updateShapes([summary.pathIndex], {
                            visible: !shapeSettings.visible,
                          });
                        }}
                        type="button"
                      >
                        {shapeSettings.visible ? (
                          <Eye size={14} />
                        ) : (
                          <EyeOff size={14} />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </aside>

        <section className="viewport-panel">
          <div className="canvas-settings">
            <div className="canvas-settings-title">
              <SlidersHorizontal size={13} />
              Canvas
            </div>
            <button
              aria-pressed={settings.canvas.showGrid}
              className={
                settings.canvas.showGrid
                  ? "compact-switch active"
                  : "compact-switch"
              }
              onClick={() =>
                updateCanvasSetting("showGrid", !settings.canvas.showGrid)
              }
              type="button"
            >
              <span className="switch-track" />
              <span>Grid</span>
            </button>
            <button
              aria-pressed={settings.canvas.showShadows}
              className={
                settings.canvas.showShadows
                  ? "compact-switch active"
                  : "compact-switch"
              }
              onClick={() =>
                updateCanvasSetting("showShadows", !settings.canvas.showShadows)
              }
              type="button"
            >
              <span className="switch-track" />
              <span>Shadow</span>
            </button>
            <label className="canvas-color">
              <Palette size={13} />
              <input
                aria-label="Canvas background"
                onChange={(event) =>
                  updateCanvasSetting("backgroundColor", event.target.value)
                }
                type="color"
                value={settings.canvas.backgroundColor}
              />
            </label>
          </div>
          <ModelPreview
            highlightedPathIndex={hoveredPathIndex}
            settings={settings}
            svgText={svgText}
          />
        </section>

        <aside className="settings-panel">
          <div className="panel-scroll">
            <section className="panel-section">
              <div className="section-title">
                <span>Shape</span>
                <SlidersHorizontal size={14} />
              </div>
              {activeShapeSettings && activeSummary ? (
                <div className="control-stack">
                  <label className="control-row inline">
                    <span className="label-line">
                      <span>Path winding</span>
                    </span>
                    <select
                      className="select-input native-select"
                      onChange={(event) =>
                        updateSelectedShapes({
                          windingMode: event.target.value as ShapeWindingMode,
                        })
                      }
                      value={activeShapeSettings.windingMode}
                    >
                      {WINDING_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <RangeControl
                    label="Thickness"
                    max={1.6}
                    min={0.02}
                    onChange={(value) => updateSelectedShapes({ thickness: value })}
                    step={0.01}
                    value={activeShapeSettings.thickness}
                  />
                  <RangeControl
                    label="Depth steps"
                    max={12}
                    min={1}
                    onChange={(value) => updateSelectedShapes({ depthSteps: value })}
                    step={1}
                    value={activeShapeSettings.depthSteps}
                  />
                  <RangeControl
                    label="Bevel"
                    max={0.22}
                    min={0}
                    onChange={(value) => updateSelectedShapes({ bevel: value })}
                    step={0.005}
                    value={activeShapeSettings.bevel}
                  />
                  <RangeControl
                    label="Bevel segments"
                    max={12}
                    min={0}
                    onChange={(value) =>
                      updateSelectedShapes({ bevelSegments: value })
                    }
                    step={1}
                    value={activeShapeSettings.bevelSegments}
                  />
                  <RangeControl
                    label="Height offset"
                    max={1.2}
                    min={-1.2}
                    onChange={(value) => updateSelectedShapes({ zOffset: value })}
                    step={0.01}
                    value={activeShapeSettings.zOffset}
                  />
                  <RangeControl
                    label="Curve segments"
                    max={128}
                    min={4}
                    onChange={(value) =>
                      updateSelectedShapes({ curveSegments: value })
                    }
                    step={1}
                    value={activeShapeSettings.curveSegments}
                  />
                </div>
              ) : (
                <div className="empty-panel">Select a layer in the left sidebar.</div>
              )}
            </section>

            {activeShapeSettings &&
            activeSummary &&
            selectedCount === 1 &&
            (activeSummary.tagName === "circle" ||
              activeSummary.tagName === "rect") ? (
              <section className="panel-section">
                <div className="section-title">
                  <span>SVG</span>
                  <SlidersHorizontal size={14} />
                </div>
                {activeSummary.tagName === "circle" ? (
                  <div className="control-stack">
                    <NumberControl
                      label="Radius"
                      min={0}
                      onChange={(value) =>
                        updateActiveSvgAdjustment("circleRadius", value)
                      }
                      onReset={() => resetActiveSvgAdjustment("circleRadius")}
                      step={0.1}
                      value={
                        activeShapeSettings.svgAdjustments.circleRadius ??
                        getSummaryNumber(activeSummary, "r")
                      }
                    />
                  </div>
                ) : activeSummary.tagName === "rect" ? (
                  <div className="control-stack">
                    <NumberControl
                      label="Width"
                      min={0}
                      onChange={(value) =>
                        updateActiveSvgAdjustment("rectWidth", value)
                      }
                      onReset={() => resetActiveSvgAdjustment("rectWidth")}
                      step={0.1}
                      value={
                        activeShapeSettings.svgAdjustments.rectWidth ??
                        getSummaryNumber(activeSummary, "width")
                      }
                    />
                    <NumberControl
                      label="Height"
                      min={0}
                      onChange={(value) =>
                        updateActiveSvgAdjustment("rectHeight", value)
                      }
                      onReset={() => resetActiveSvgAdjustment("rectHeight")}
                      step={0.1}
                      value={
                        activeShapeSettings.svgAdjustments.rectHeight ??
                        getSummaryNumber(activeSummary, "height")
                      }
                    />
                    <NumberControl
                      label="Corner radius"
                      min={0}
                      onChange={(value) =>
                        updateActiveSvgAdjustment("rectCornerRadius", value)
                      }
                      onReset={() =>
                        resetActiveSvgAdjustment("rectCornerRadius")
                      }
                      step={0.1}
                      value={
                        activeShapeSettings.svgAdjustments.rectCornerRadius ??
                        getRectCornerRadius(activeSummary)
                      }
                    />
                  </div>
                ) : null}
              </section>
            ) : null}

            {activeShapeSettings && activeSummary ? (
              <section className="panel-section">
                <div className="section-title">
                  <span>Material</span>
                  <Palette size={14} />
                </div>
                <div className="control-stack">
                  <MaterialSelect
                    label="Material"
                    onChange={(value) => updateSelectedShapes({ material: value })}
                    value={activeShapeSettings.material}
                  />
                  <label className="control-row">
                    <span className="label-line">
                      <span>Color</span>
                    </span>
                    <span className="color-field">
                      <label className="color-control">
                        <input
                          aria-label="Shape color"
                          className="color-input"
                          onChange={(event) =>
                            updateSelectedShapes({ color: event.target.value })
                          }
                          type="color"
                          value={activeShapeSettings.color}
                        />
                        <span
                          aria-hidden="true"
                          className="color-swatch"
                          style={{ backgroundColor: activeShapeSettings.color }}
                        />
                        <span className="color-value">
                          {activeShapeSettings.color.toUpperCase()}
                        </span>
                      </label>
                      <button
                        aria-label="Reset to SVG color"
                        className="mini-action icon-only"
                        onClick={() =>
                          updateShapes(selectedPathIndexes, (summary) => ({
                            color: getSvgColor(summary),
                          }))
                        }
                        type="button"
                      >
                        <RotateCcw size={12} />
                      </button>
                    </span>
                  </label>
                </div>
              </section>
            ) : null}

            <section className="panel-section">
              <div className="section-title">
                <span>Quality</span>
                <SlidersHorizontal size={14} />
              </div>
              <div className="control-stack">
                <RangeControl
                  label="Curve segments"
                  max={96}
                  min={4}
                  onChange={(value) =>
                    updateQualitySetting("curveSegments", value)
                  }
                  step={1}
                  value={activeQualitySettings.curveSegments}
                />
                <RangeControl
                  label="Curve precision"
                  max={64}
                  min={2}
                  onChange={(value) =>
                    updateQualitySetting("curvePrecision", value)
                  }
                  step={1}
                  value={activeQualitySettings.curvePrecision}
                />
                <RangeControl
                  label="Bevel segments"
                  max={12}
                  min={0}
                  onChange={(value) =>
                    updateQualitySetting("bevelSegments", value)
                  }
                  step={1}
                  value={activeQualitySettings.bevelSegments}
                />
              </div>
            </section>

            <section className="panel-section">
              <div className="section-title section-title-with-action">
                <span className="section-title-label">
                  <SlidersHorizontal size={14} />
                  <span>Dome</span>
                </span>
                <label className="title-switch">
                  <input
                    aria-label="Front convex / back concave"
                    checked={activeDomeSettings.enabled}
                    onChange={(event) =>
                      updateDomeSetting("enabled", event.target.checked)
                    }
                    type="checkbox"
                  />
                  <span className="switch-track" />
                </label>
              </div>
              {activeDomeSettings.enabled ? (
                <div className="control-stack">
                  <RangeControl
                    label="Arc depth"
                    max={1.2}
                    min={0.02}
                    onChange={(value) => updateDomeSetting("depth", value)}
                    step={0.01}
                    value={activeDomeSettings.depth}
                  />
                  <RangeControl
                    label="Arc radius"
                    max={1.45}
                    min={0.65}
                    onChange={(value) => updateDomeSetting("radius", value)}
                    step={0.01}
                    value={activeDomeSettings.radius}
                  />
                  <RangeControl
                    label="Arc smoothness"
                    max={128}
                    min={8}
                    onChange={(value) => updateDomeSetting("segments", value)}
                    step={1}
                    value={activeDomeSettings.segments}
                  />
                </div>
              ) : null}
            </section>

            <section className="panel-section">
              <div className="section-title">
                <span>Export</span>
                <Download size={14} />
              </div>
              <div className="export-actions">
                {MODEL_EXPORT_OPTIONS.map((option, index) => (
                  <button
                    className={
                      index === 0
                        ? "text-button primary export-button"
                        : "text-button export-button"
                    }
                    key={option.format}
                    disabled={isBusy}
                    onClick={() => exportModel(option.format)}
                    type="button"
                  >
                    <Download size={16} />
                    Export {option.label}
                  </button>
                ))}
                <button
                  className="text-button export-button"
                  disabled={isBusy}
                  onClick={exportWorkJson}
                  type="button"
                >
                  <FileJson size={16} />
                  Export JSON
                </button>
              </div>
            </section>
          </div>
        </aside>
      </main>
    </div>
  );
}
