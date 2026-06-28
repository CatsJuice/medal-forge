"use client";

import { Environment } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import {
  Download,
  Play,
  RotateCcw,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  CSSProperties,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { buildMedalGroup, disposeObject3D } from "@/lib/model-builder";
import {
  DEFAULT_PRESENTATION_DURATION_SECONDS,
  DEFAULT_PRESENTATION_FLIP_END_ANGLES,
  DEFAULT_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND,
  DEFAULT_PRESENTATION_FLIP_START_ANGLES,
  DEFAULT_PRESENTATION_FRAME_RATE,
  DEFAULT_PRESENTATION_QUALITY,
  DEFAULT_PRESENTATION_SPIN_SPEEDS,
  MAX_PRESENTATION_FLIP_ANGLE_DEGREES,
  MAX_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND,
  MIN_PRESENTATION_FLIP_ANGLE_DEGREES,
  MIN_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND,
  PRESENTATION_EXPORT_OPTIONS,
  PRESENTATION_QUALITY_OPTIONS,
  getCompatiblePresentationFrameRate,
  getPresentationExportOption,
  getPresentationFrameRateOptions,
  getPresentationQualityOption,
  getPresentationRotation,
  type PresentationEulerAngles,
  type PresentationExportConfig,
  type PresentationExportFormat,
  type PresentationFrameRate,
  type PresentationExportQuality,
  type PresentationMode,
  type PresentationSpinSpeeds,
} from "@/lib/presentation-export";
import {
  enqueuePresentationExport,
  type ExportSaveFileHandle,
} from "@/lib/export-queue";
import type { MedalSettings } from "@/lib/types";

interface PresentationModeDialogProps {
  disabled?: boolean;
  fileStem: string;
  onClose: () => void;
  onStatus: (status: string) => void;
  settings: MedalSettings;
  svgText: string;
}

interface PresentationSavePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      accept: Record<string, string[]>;
      description: string;
    }>;
  }) => Promise<ExportSaveFileHandle>;
}

interface NumberFieldProps {
  ariaLabel?: string;
  label: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  step?: number;
  unit?: string;
  value: number;
}

const MODE_OPTIONS: Array<{ label: string; value: PresentationMode }> = [
  {
    label: "Rotate",
    value: "spin",
  },
  {
    label: "Flip",
    value: "flip",
  },
];

const PRESENTATION_DIALOG_EXIT_MS = 260;

function NumberField({
  ariaLabel,
  label,
  max,
  min,
  onChange,
  step = 1,
  unit,
  value,
}: NumberFieldProps) {
  return (
    <label className="presentation-control-row">
      <span>{label}</span>
      <span className="presentation-number-field">
        <input
          aria-label={ariaLabel}
          inputMode="decimal"
          max={max}
          min={min}
          onChange={(event) => {
            const nextValue = Number(event.target.value);

            if (Number.isFinite(nextValue)) {
              onChange(nextValue);
            }
          }}
          step={step}
          type="number"
          value={value}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
    </label>
  );
}

function PresentationAnimatedModel({
  config,
  settings,
  svgText,
}: {
  config: PresentationExportConfig;
  settings: MedalSettings;
  svgText: string;
}) {
  const wrapperRef = useRef<THREE.Group>(null);
  const startTimeRef = useRef<number | null>(null);
  const group = useMemo(
    () => buildMedalGroup(svgText, settings),
    [settings, svgText],
  );

  useEffect(() => {
    return () => disposeObject3D(group);
  }, [group]);

  useEffect(() => {
    startTimeRef.current = null;
  }, [config]);

  useFrame(({ clock }) => {
    const wrapper = wrapperRef.current;

    if (!wrapper) {
      return;
    }

    startTimeRef.current ??= clock.elapsedTime;
    const rotation = getPresentationRotation(
      config,
      clock.elapsedTime - startTimeRef.current,
    );
    wrapper.rotation.set(rotation.x, rotation.y, rotation.z);
  });

  return (
    <group ref={wrapperRef}>
      <primitive object={group} />
    </group>
  );
}

function PresentationPreview({
  config,
  settings,
  svgText,
}: {
  config: PresentationExportConfig;
  settings: MedalSettings;
  svgText: string;
}) {
  return (
    <div className="presentation-preview-stage">
      <Canvas
        camera={{ position: [0, -7, 5.2], fov: 38 }}
        dpr={[1, 2]}
        gl={{
          alpha: true,
          antialias: true,
          premultipliedAlpha: false,
          preserveDrawingBuffer: true,
        }}
        style={{ height: "100%", width: "100%" }}
      >
        <ambientLight intensity={0.62} />
        <directionalLight intensity={2.2} position={[4.5, -5.5, 8]} />
        <directionalLight intensity={0.65} position={[-5, 3, 4]} />
        <Suspense fallback={null}>
          <PresentationAnimatedModel
            config={config}
            settings={settings}
            svgText={svgText}
          />
          <Environment preset="city" />
        </Suspense>
      </Canvas>
    </div>
  );
}

function ModeSegmented({
  onChange,
  value,
}: {
  onChange: (value: PresentationMode) => void;
  value: PresentationMode;
}) {
  return (
    <div
      className="presentation-mode-segmented"
      style={{ "--segments": MODE_OPTIONS.length } as CSSProperties}
    >
      {MODE_OPTIONS.map((option) => (
        <button
          className={option.value === value ? "active" : ""}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.value === "spin" ? (
            <RotateCcw size={14} />
          ) : (
            <Play size={14} />
          )}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function formatByteSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
  }

  return `${Math.max(1, Math.round(bytes / 1024 / 1024))}MB`;
}

export function PresentationModeDialog({
  disabled = false,
  fileStem,
  onClose,
  onStatus,
  settings,
  svgText,
}: PresentationModeDialogProps) {
  const [mode, setMode] = useState<PresentationMode>("spin");
  const [spinSpeeds, setSpinSpeeds] = useState<PresentationSpinSpeeds>(
    DEFAULT_PRESENTATION_SPIN_SPEEDS,
  );
  const [flipStartAngles, setFlipStartAngles] =
    useState<PresentationEulerAngles>(
      DEFAULT_PRESENTATION_FLIP_START_ANGLES,
    );
  const [flipEndAngles, setFlipEndAngles] = useState<PresentationEulerAngles>(
    DEFAULT_PRESENTATION_FLIP_END_ANGLES,
  );
  const [flipSpeed, setFlipSpeed] = useState(
    DEFAULT_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND,
  );
  const [durationSeconds, setDurationSeconds] = useState(
    DEFAULT_PRESENTATION_DURATION_SECONDS,
  );
  const [frameRate, setFrameRate] = useState<PresentationFrameRate>(
    DEFAULT_PRESENTATION_FRAME_RATE,
  );
  const [quality, setQuality] = useState<PresentationExportQuality>(
    DEFAULT_PRESENTATION_QUALITY,
  );
  const [format, setFormat] = useState<PresentationExportFormat>("mov");
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const config = useMemo<PresentationExportConfig>(() => {
    if (mode === "flip") {
      return {
        durationSeconds,
        endAngles: flipEndAngles,
        flipSpeedDegPerSecond: flipSpeed,
        frameRate,
        mode,
        quality,
        startAngles: flipStartAngles,
      };
    }

    return {
      durationSeconds,
      frameRate,
      mode,
      quality,
      rotationSpeeds: spinSpeeds,
    };
  }, [
    durationSeconds,
    flipEndAngles,
    flipSpeed,
    flipStartAngles,
    frameRate,
    mode,
    quality,
    spinSpeeds,
  ]);

  const qualityOption = getPresentationQualityOption(quality);
  const formatOption = getPresentationExportOption(format);
  const frameRateOptions = getPresentationFrameRateOptions(format);
  const compatibleFrameRate = getCompatiblePresentationFrameRate(
    format,
    frameRate,
  );
  const exportFrameCount = Math.max(
    1,
    Math.round(durationSeconds * compatibleFrameRate),
  );
  const estimatedMovSize =
    format === "mov"
      ? Math.round(
          qualityOption.size * qualityOption.size * exportFrameCount * 0.38,
        )
      : null;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        requestClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  });

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  function requestClose() {
    if (isClosing) {
      return;
    }

    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, PRESENTATION_DIALOG_EXIT_MS);
  }

  function updateSpinSpeed(axis: keyof PresentationSpinSpeeds, value: number) {
    setSpinSpeeds((current) => ({
      ...current,
      [axis]: value,
    }));
  }

  function updateFlipStartAngle(
    axis: keyof PresentationEulerAngles,
    value: number,
  ) {
    setFlipStartAngles((current) => ({
      ...current,
      [axis]: value,
    }));
  }

  function updateFlipEndAngle(
    axis: keyof PresentationEulerAngles,
    value: number,
  ) {
    setFlipEndAngles((current) => ({
      ...current,
      [axis]: value,
    }));
  }

  function resetCurrentMode() {
    if (mode === "spin") {
      setSpinSpeeds(DEFAULT_PRESENTATION_SPIN_SPEEDS);
      return;
    }

    setFlipStartAngles(DEFAULT_PRESENTATION_FLIP_START_ANGLES);
    setFlipEndAngles(DEFAULT_PRESENTATION_FLIP_END_ANGLES);
    setFlipSpeed(DEFAULT_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND);
  }

  function updateFormat(nextFormat: PresentationExportFormat) {
    setFormat(nextFormat);
    setFrameRate((current) =>
      getCompatiblePresentationFrameRate(nextFormat, current),
    );
  }

  async function queueExport() {
    if (disabled) {
      onStatus("Finish loading SVG before exporting");
      return;
    }

    const fileName = `${fileStem}-presentation-${mode}.${formatOption.extension}`;
    const saveHandle =
      format === "mov"
        ? await requestMovSaveHandle(fileName, formatOption.mimeType)
        : undefined;

    if (saveHandle === null) {
      onStatus("MOV export canceled");
      return;
    }

    enqueuePresentationExport({
      config,
      fileName,
      format,
      saveHandle,
      settings,
      svgText,
    });
    onStatus(`${formatOption.label} presentation export queued`);
  }

  return (
    <section
      aria-label="Presentation mode"
      aria-modal="true"
      className={
        isClosing
          ? "presentation-dialog-shell closing"
          : "presentation-dialog-shell"
      }
      role="dialog"
    >
      <div className="presentation-dialog" data-state={isClosing ? "closing" : "open"}>
        <header className="presentation-dialog-header">
          <div className="presentation-dialog-title">
            <Play size={15} />
            <span>Presentation Mode</span>
          </div>
          <button
            aria-label="Close presentation mode"
            className="icon-button presentation-close"
            onClick={requestClose}
            title="Close"
            type="button"
          >
            <X size={16} />
          </button>
        </header>

        <div className="presentation-dialog-body">
          <PresentationPreview
            config={config}
            settings={settings}
            svgText={svgText}
          />

          <aside className="presentation-controls-panel">
            <section className="presentation-section">
              <div className="presentation-section-title">
                <SlidersHorizontal size={14} />
                <span>Mode</span>
              </div>
              <ModeSegmented onChange={setMode} value={mode} />
            </section>

            <section className="presentation-section">
              <div className="presentation-section-title action-title">
                <span>
                  <SlidersHorizontal size={14} />
                  <span>{mode === "spin" ? "Rotation" : "Flip"}</span>
                </span>
                <button
                  className="mini-action"
                  onClick={resetCurrentMode}
                  type="button"
                >
                  <RotateCcw size={12} />
                  Reset
                </button>
              </div>
              <div className="presentation-control-stack">
                {mode === "spin" ? (
                  <>
                    <NumberField
                      label="X speed"
                      max={720}
                      min={-720}
                      onChange={(value) => updateSpinSpeed("x", value)}
                      unit="deg/s"
                      value={spinSpeeds.x}
                    />
                    <NumberField
                      label="Y speed"
                      max={720}
                      min={-720}
                      onChange={(value) => updateSpinSpeed("y", value)}
                      unit="deg/s"
                      value={spinSpeeds.y}
                    />
                    <NumberField
                      label="Z speed"
                      max={720}
                      min={-720}
                      onChange={(value) => updateSpinSpeed("z", value)}
                      unit="deg/s"
                      value={spinSpeeds.z}
                    />
                  </>
                ) : (
                  <>
                    <NumberField
                      label="Speed"
                      max={MAX_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND}
                      min={MIN_PRESENTATION_FLIP_SPEED_DEG_PER_SECOND}
                      onChange={setFlipSpeed}
                      step={30}
                      unit="deg/s"
                      value={flipSpeed}
                    />
                    <div className="presentation-angle-group">
                      <span className="presentation-angle-group-title">
                        Initial angle
                      </span>
                      <div className="presentation-angle-grid">
                        <NumberField
                          ariaLabel="Initial X angle"
                          label="X"
                          max={MAX_PRESENTATION_FLIP_ANGLE_DEGREES}
                          min={MIN_PRESENTATION_FLIP_ANGLE_DEGREES}
                          onChange={(value) => updateFlipStartAngle("x", value)}
                          step={5}
                          unit="deg"
                          value={flipStartAngles.x}
                        />
                        <NumberField
                          ariaLabel="Initial Y angle"
                          label="Y"
                          max={MAX_PRESENTATION_FLIP_ANGLE_DEGREES}
                          min={MIN_PRESENTATION_FLIP_ANGLE_DEGREES}
                          onChange={(value) => updateFlipStartAngle("y", value)}
                          step={5}
                          unit="deg"
                          value={flipStartAngles.y}
                        />
                        <NumberField
                          ariaLabel="Initial Z angle"
                          label="Z"
                          max={MAX_PRESENTATION_FLIP_ANGLE_DEGREES}
                          min={MIN_PRESENTATION_FLIP_ANGLE_DEGREES}
                          onChange={(value) => updateFlipStartAngle("z", value)}
                          step={5}
                          unit="deg"
                          value={flipStartAngles.z}
                        />
                      </div>
                    </div>
                    <div className="presentation-angle-group">
                      <span className="presentation-angle-group-title">
                        Final angle
                      </span>
                      <div className="presentation-angle-grid">
                        <NumberField
                          ariaLabel="Final X angle"
                          label="X"
                          max={MAX_PRESENTATION_FLIP_ANGLE_DEGREES}
                          min={MIN_PRESENTATION_FLIP_ANGLE_DEGREES}
                          onChange={(value) => updateFlipEndAngle("x", value)}
                          step={5}
                          unit="deg"
                          value={flipEndAngles.x}
                        />
                        <NumberField
                          ariaLabel="Final Y angle"
                          label="Y"
                          max={MAX_PRESENTATION_FLIP_ANGLE_DEGREES}
                          min={MIN_PRESENTATION_FLIP_ANGLE_DEGREES}
                          onChange={(value) => updateFlipEndAngle("y", value)}
                          step={5}
                          unit="deg"
                          value={flipEndAngles.y}
                        />
                        <NumberField
                          ariaLabel="Final Z angle"
                          label="Z"
                          max={MAX_PRESENTATION_FLIP_ANGLE_DEGREES}
                          min={MIN_PRESENTATION_FLIP_ANGLE_DEGREES}
                          onChange={(value) => updateFlipEndAngle("z", value)}
                          step={5}
                          unit="deg"
                          value={flipEndAngles.z}
                        />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="presentation-section">
              <div className="presentation-section-title">
                <Download size={14} />
                <span>Export</span>
              </div>
              <div className="presentation-control-stack">
                <div
                  className="presentation-format-grid"
                  style={
                    {
                      "--segments": PRESENTATION_EXPORT_OPTIONS.length,
                    } as CSSProperties
                  }
                >
                  {PRESENTATION_EXPORT_OPTIONS.map((option) => (
                    <button
                      className={option.format === format ? "active" : ""}
                      key={option.format}
                      onClick={() => updateFormat(option.format)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <NumberField
                  label="Duration"
                  max={12}
                  min={1}
                  onChange={setDurationSeconds}
                  step={0.5}
                  unit="s"
                  value={durationSeconds}
                />
                <label className="presentation-control-row">
                  <span>Quality</span>
                  <select
                    className="presentation-select"
                    onChange={(event) =>
                      setQuality(
                        event.target.value as PresentationExportQuality,
                      )
                    }
                    value={quality}
                  >
                    {PRESENTATION_QUALITY_OPTIONS.map((option) => (
                      <option key={option.quality} value={option.quality}>
                        {option.label} - {option.size}px
                      </option>
                    ))}
                  </select>
                </label>
                <label className="presentation-control-row">
                  <span>Frame rate</span>
                  <select
                    className="presentation-select"
                    onChange={(event) =>
                      setFrameRate(
                        Number(event.target.value) as PresentationFrameRate,
                      )
                    }
                    value={compatibleFrameRate}
                  >
                    {frameRateOptions.map((option) => (
                      <option key={option.fps} value={option.fps}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="presentation-export-summary">
                  {qualityOption.size}px square - {compatibleFrameRate}fps -
                  transparent
                  {estimatedMovSize
                    ? ` - ~${formatByteSize(estimatedMovSize)} ProRes MOV`
                    : ""}
                </div>
                <button
                  className="text-button primary presentation-export-button"
                  disabled={disabled}
                  onClick={queueExport}
                  type="button"
                >
                  <Download size={16} />
                  Queue {formatOption.label}
                </button>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </section>
  );
}

async function requestMovSaveHandle(fileName: string, mimeType: string) {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (navigator.webdriver) {
    return undefined;
  }

  const showSaveFilePicker = (window as PresentationSavePickerWindow)
    .showSaveFilePicker;

  if (!showSaveFilePicker) {
    return undefined;
  }

  try {
    return await showSaveFilePicker({
      suggestedName: fileName,
      types: [
        {
          accept: {
            [mimeType]: [".mov"],
          },
          description: "ProRes MOV",
        },
      ],
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }

    return undefined;
  }
}
