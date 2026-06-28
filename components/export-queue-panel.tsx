"use client";

import {
  Check,
  Download,
  LoaderCircle,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  downloadCompletedExport,
  removeExportQueueItem,
  useExportQueueSnapshot,
  type ExportQueueItem,
} from "@/lib/export-queue";

interface ExportQueuePanelProps {
  variant?: "floating" | "toolbar";
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isFinished(item: ExportQueueItem) {
  return item.status === "completed" || item.status === "failed";
}

function getBadgeLabel(count: number) {
  return count > 99 ? "99+" : String(count);
}

function ExportQueueContent({ items }: { items: ExportQueueItem[] }) {
  if (items.length === 0) {
    return <div className="export-queue-empty">No exports yet</div>;
  }

  return (
    <div className="export-queue-list">
      {items.map((item) => (
        <div className="export-queue-item" key={item.id}>
          <div className="export-queue-icon" data-status={item.status}>
            {item.status === "running" ? (
              <LoaderCircle className="spin-icon" size={14} />
            ) : item.status === "completed" ? (
              <Check size={14} />
            ) : item.status === "failed" ? (
              <XCircle size={14} />
            ) : (
              <span />
            )}
          </div>
          <div className="export-queue-content">
            <div className="export-queue-title">
              <span>{item.label}</span>
              <small>
                {item.sizeBytes ? formatBytes(item.sizeBytes) : item.status}
              </small>
            </div>
            <div className="export-progress-track">
              <span style={{ width: `${item.progress}%` }} />
            </div>
            <div className="export-queue-footer">
              <div className="export-queue-status">
                {item.error ?? item.statusText}
              </div>
              {isFinished(item) ? (
                <div className="export-queue-actions">
                  {item.status === "completed" && item.canDownload ? (
                    <button
                      aria-label={`Download ${item.fileName}`}
                      className="export-queue-action"
                      onClick={() => downloadCompletedExport(item.id)}
                      title="Download again"
                      type="button"
                    >
                      <Download size={13} />
                    </button>
                  ) : null}
                  <button
                    aria-label={`Clear ${item.fileName}`}
                    className="export-queue-action"
                    onClick={() => removeExportQueueItem(item.id)}
                    title="Clear"
                    type="button"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ExportQueuePanel({ variant = "floating" }: ExportQueuePanelProps) {
  const queue = useExportQueueSnapshot();
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const knownItemIdsRef = useRef<Set<string> | null>(null);
  const hasItems = queue.items.length > 0;

  useEffect(() => {
    if (variant !== "toolbar") {
      return;
    }

    const knownItemIds = knownItemIdsRef.current;
    const currentItemIds = new Set(queue.items.map((item) => item.id));

    if (!knownItemIds) {
      knownItemIdsRef.current = currentItemIds;
      return;
    }

    const hasNewItem = queue.items.some((item) => !knownItemIds.has(item.id));

    knownItemIdsRef.current = currentItemIds;

    if (hasNewItem) {
      setIsOpen(true);
    }
  }, [queue.items, variant]);

  useEffect(() => {
    if (!isOpen || variant !== "toolbar") {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;

      if (target instanceof Node && rootRef.current?.contains(target)) {
        return;
      }

      setIsOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
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
  }, [isOpen, variant]);

  if (variant === "toolbar") {
    return (
      <div
        className="export-queue-dropdown"
        onPointerDown={(event) => event.stopPropagation()}
        ref={rootRef}
      >
        <button
          aria-expanded={isOpen}
          aria-label={`Export queue, ${queue.items.length} item${
            queue.items.length === 1 ? "" : "s"
          }`}
          className={
            isOpen
              ? "icon-button export-queue-trigger active"
              : "icon-button export-queue-trigger"
          }
          onClick={() => setIsOpen((current) => !current)}
          title="Export queue"
          type="button"
        >
          <Download size={15} />
          {hasItems ? (
            <span className="export-queue-badge">
              {getBadgeLabel(queue.items.length)}
            </span>
          ) : null}
        </button>
        {isOpen ? (
          <section aria-label="Export queue" className="export-queue-panel export-queue-menu">
            <div className="export-queue-header">
              <span>Export Queue</span>
              <small>{queue.items.length}</small>
            </div>
            <ExportQueueContent items={queue.items} />
          </section>
        ) : null}
      </div>
    );
  }

  if (!hasItems) {
    return null;
  }

  return (
    <section
      aria-label="Export queue"
      className="export-queue-panel"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="export-queue-header">
        <span>Export Queue</span>
        <small>{queue.items.length}</small>
      </div>
      <ExportQueueContent items={queue.items} />
    </section>
  );
}
