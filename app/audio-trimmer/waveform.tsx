"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { formatTimecode } from "../_lib/format";

export interface Interval {
  start: number;
  end: number;
}

export interface Region extends Interval {
  id: number;
  /** Added by silence detection; replaced on the next detection run. */
  auto?: boolean;
}

/** Rectified, downsampled mono audio used to draw the waveform. */
export interface Peaks {
  samples: Int16Array;
  /** Samples per second. */
  rate: number;
  /** Largest sample, so quiet recordings still fill the height. */
  max: number;
}

interface WaveformProps {
  peaks: Peaks;
  duration: number;
  regions: Region[];
  selectedId: number | null;
  /** Kept parts of the timeline; everything else is drawn greyed out. */
  kept: Interval[];
  /** Region colouring: red for parts to remove, green for parts to keep. */
  tone: "remove" | "keep";
  zoom: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  disabled: boolean;
  onSeek: (seconds: number) => void;
  onSelect: (id: number | null) => void;
  onCreate: (start: number, end: number) => void;
  onUpdate: (id: number, start: number, end: number) => void;
  onDelete: (id: number) => void;
  onTogglePlay: () => void;
}

type Drag =
  | { kind: "create"; anchor: number; current: number }
  | { kind: "resize"; id: number; edge: "start" | "end"; start: number; end: number }
  | { kind: "move"; id: number; offset: number; start: number; end: number };

const HEIGHT = 168;
const RULER = 20;
const EDGE_HIT_PX = 6;
const CLICK_SLOP_PX = 3;
/** Drags shorter than this create no region. */
const MIN_REGION_SECONDS = 0.05;
const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

const COLORS = {
  background: "#f7f7f7",
  ruler: "#ebebeb",
  rulerText: "#616161",
  tick: "#cccccc",
  wave: "#2c6ecb",
  waveCut: "#c4c7cb",
  playhead: "#1a1a1a",
  remove: { fill: "rgba(229, 28, 0, 0.10)", edge: "#e51c00" },
  keep: { fill: "rgba(4, 123, 93, 0.12)", edge: "#047b5d" },
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Loudest sample per pixel column of the visible window, normalised to 0..1. */
function computeColumns(peaks: Peaks, viewStart: number, secondsPerPx: number, width: number) {
  const columns = new Float32Array(width);
  const { samples, rate, max } = peaks;
  for (let x = 0; x < width; x++) {
    const from = Math.floor((viewStart + x * secondsPerPx) * rate);
    const to = Math.max(from + 1, Math.floor((viewStart + (x + 1) * secondsPerPx) * rate));
    let peak = 0;
    for (let i = Math.max(0, from); i < Math.min(to, samples.length); i++) {
      const value = samples[i] < 0 ? -samples[i] : samples[i];
      if (value > peak) peak = value;
    }
    columns[x] = max > 0 ? Math.min(1, peak / max) : 0;
  }
  return columns;
}

export function Waveform(props: WaveformProps) {
  const { duration, zoom, audioRef, disabled } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  // The draw loop reads the latest props without restarting on every render.
  const propsRef = useRef(props);
  const dragRef = useRef<Drag | null>(null);
  const pointerRef = useRef<{ id: number; x: number; moved: boolean } | null>(null);
  const dirtyRef = useRef(true);
  const columnsRef = useRef<{ key: string; data: Float32Array } | null>(null);

  useLayoutEffect(() => {
    propsRef.current = props;
    dirtyRef.current = true;
  });

  const totalWidth = width * zoom;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(container.clientWidth)));
    observer.observe(container);
    setWidth(Math.floor(container.clientWidth));
    return () => observer.disconnect();
  }, []);

  // Keep the playhead in view when zooming.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || width === 0) return;
    const time = audioRef.current?.currentTime ?? 0;
    container.scrollLeft = (time / duration) * width * zoom - width / 2;
    dirtyRef.current = true;
  }, [zoom, width, duration, audioRef]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || width === 0) return;
    const { peaks, regions, selectedId, kept, tone } = propsRef.current;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(HEIGHT * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const secondsPerPx = duration / (width * zoom);
    const viewStart = container.scrollLeft * secondsPerPx;
    const toX = (seconds: number) => (seconds - viewStart) / secondsPerPx;

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, HEIGHT);

    // Ruler.
    ctx.fillStyle = COLORS.ruler;
    ctx.fillRect(0, 0, width, RULER);
    const step = TICK_STEPS.find((s) => s / secondsPerPx >= 90) ?? 3600;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (let t = Math.floor(viewStart / step) * step; t <= viewStart + width * secondsPerPx; t += step) {
      const x = Math.round(toX(t)) + 0.5;
      ctx.strokeStyle = COLORS.tick;
      ctx.beginPath();
      ctx.moveTo(x, RULER - 6);
      ctx.lineTo(x, RULER);
      ctx.stroke();
      ctx.fillStyle = COLORS.rulerText;
      ctx.fillText(formatTimecode(t, { fractional: step < 1 }), x + 4, RULER / 2);
    }

    // Waveform, greyed out where the audio will be cut.
    const key = `${peaks.samples.length}|${viewStart}|${secondsPerPx}|${width}`;
    if (columnsRef.current?.key !== key) {
      columnsRef.current = { key, data: computeColumns(peaks, viewStart, secondsPerPx, width) };
    }
    const columns = columnsRef.current.data;
    const mid = RULER + (HEIGHT - RULER) / 2;
    const half = (HEIGHT - RULER) / 2 - 6;
    let keptIndex = 0;
    for (let x = 0; x < width; x++) {
      const t = viewStart + (x + 0.5) * secondsPerPx;
      while (keptIndex < kept.length && kept[keptIndex].end <= t) keptIndex++;
      const isKept = keptIndex < kept.length && kept[keptIndex].start <= t;
      const h = Math.max(1, columns[x] * half);
      ctx.fillStyle = isKept ? COLORS.wave : COLORS.waveCut;
      ctx.fillRect(x, mid - h, 1, h * 2);
    }

    // Regions (with the one being dragged replacing its committed version).
    const drag = dragRef.current;
    const shown: (Interval & { id: number })[] = regions.map((region) =>
      drag && drag.kind !== "create" && drag.id === region.id ? { id: region.id, start: drag.start, end: drag.end } : region,
    );
    if (drag?.kind === "create") {
      shown.push({ id: -1, start: Math.min(drag.anchor, drag.current), end: Math.max(drag.anchor, drag.current) });
    }
    const palette = COLORS[tone];
    for (const region of shown) {
      const x0 = toX(region.start);
      const x1 = toX(region.end);
      if (x1 < 0 || x0 > width) continue;
      const selected = region.id === selectedId || region.id === -1;
      ctx.fillStyle = palette.fill;
      ctx.fillRect(x0, RULER, x1 - x0, HEIGHT - RULER);
      ctx.strokeStyle = palette.edge;
      ctx.lineWidth = selected ? 2 : 1;
      for (const x of [x0, x1]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER);
        ctx.lineTo(Math.round(x) + 0.5, HEIGHT);
        ctx.stroke();
        if (selected) {
          ctx.fillStyle = palette.edge;
          ctx.fillRect(Math.round(x) - 3, mid - 12, 7, 24);
        }
      }
    }
    ctx.lineWidth = 1;

    // Playhead.
    const playX = Math.round(toX(audioRef.current?.currentTime ?? 0)) + 0.5;
    if (playX >= 0 && playX <= width) {
      ctx.strokeStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, HEIGHT);
      ctx.stroke();
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(playX - 5, 0);
      ctx.lineTo(playX + 5, 0);
      ctx.lineTo(playX, 6);
      ctx.fill();
    }
  }, [audioRef, duration, width, zoom]);

  // Redraws when something changed or while audio plays; follows the playhead when zoomed in.
  useEffect(() => {
    let frame = 0;
    let lastTime = -1;
    const tick = () => {
      const audio = audioRef.current;
      const container = containerRef.current;
      const time = audio?.currentTime ?? 0;
      if (audio && !audio.paused && container && !dragRef.current && zoom > 1) {
        const x = (time / duration) * width * zoom;
        if (x < container.scrollLeft || x > container.scrollLeft + width * 0.95) {
          container.scrollLeft = x - width * 0.1;
          dirtyRef.current = true;
        }
      }
      if (dirtyRef.current || time !== lastTime) {
        dirtyRef.current = false;
        lastTime = time;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [audioRef, draw, duration, width, zoom]);

  const timeAt = (clientX: number) => {
    const container = containerRef.current!;
    const x = clientX - container.getBoundingClientRect().left + container.scrollLeft;
    return clamp((x / (width * zoom)) * duration, 0, duration);
  };

  /** What a pointer at `clientX` would grab: a region edge, a region body, or nothing. */
  const hitTest = (clientX: number) => {
    const { regions, selectedId } = propsRef.current;
    const pxPerSecond = (width * zoom) / duration;
    const t = timeAt(clientX);
    // The selected region wins when edges overlap.
    const ordered = [...regions].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
    for (const region of ordered) {
      if (Math.abs(region.start - t) * pxPerSecond <= EDGE_HIT_PX) return { region, edge: "start" as const };
      if (Math.abs(region.end - t) * pxPerSecond <= EDGE_HIT_PX) return { region, edge: "end" as const };
    }
    const inside = ordered.find((region) => region.start <= t && t <= region.end);
    return inside ? { region: inside, edge: null } : null;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const container = containerRef.current!;
    // Ignore the horizontal scrollbar under the canvas.
    if (event.clientY - container.getBoundingClientRect().top > HEIGHT) return;
    container.setPointerCapture(event.pointerId);
    container.focus();
    pointerRef.current = { id: event.pointerId, x: event.clientX, moved: false };
    const t = timeAt(event.clientX);
    const hit = hitTest(event.clientX);
    if (hit?.edge) {
      dragRef.current = { kind: "resize", id: hit.region.id, edge: hit.edge, start: hit.region.start, end: hit.region.end };
    } else if (hit) {
      dragRef.current = { kind: "move", id: hit.region.id, offset: t - hit.region.start, start: hit.region.start, end: hit.region.end };
    } else {
      dragRef.current = { kind: "create", anchor: t, current: t };
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current!;
    const pointer = pointerRef.current;
    const drag = dragRef.current;
    if (!pointer || !drag) {
      if (disabled) return;
      const hit = hitTest(event.clientX);
      container.style.cursor = hit?.edge ? "ew-resize" : hit ? "grab" : "crosshair";
      return;
    }
    if (!pointer.moved && Math.abs(event.clientX - pointer.x) < CLICK_SLOP_PX) return;
    pointer.moved = true;
    const t = timeAt(event.clientX);
    if (drag.kind === "create") {
      drag.current = t;
    } else if (drag.kind === "resize") {
      drag[drag.edge] = t;
    } else {
      const length = drag.end - drag.start;
      drag.start = clamp(t - drag.offset, 0, duration - length);
      drag.end = drag.start + length;
      container.style.cursor = "grabbing";
    }
    dirtyRef.current = true;
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>, commit: boolean) => {
    const pointer = pointerRef.current;
    const drag = dragRef.current;
    pointerRef.current = null;
    dragRef.current = null;
    dirtyRef.current = true;
    if (!pointer || !drag || !commit) return;
    const { onCreate, onUpdate, onSeek, onSelect } = propsRef.current;
    if (!pointer.moved) {
      const t = timeAt(event.clientX);
      onSeek(t);
      const hit = hitTest(event.clientX);
      onSelect(hit ? hit.region.id : null);
      return;
    }
    if (drag.kind === "create") {
      const start = Math.min(drag.anchor, drag.current);
      const end = Math.max(drag.anchor, drag.current);
      if (end - start >= MIN_REGION_SECONDS) onCreate(start, end);
    } else {
      const start = Math.min(drag.start, drag.end);
      const end = Math.max(drag.start, drag.end);
      if (end - start >= MIN_REGION_SECONDS) onUpdate(drag.id, start, end);
      onSelect(drag.id);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const { selectedId, onDelete, onSelect, onSeek, onTogglePlay } = propsRef.current;
    const time = audioRef.current?.currentTime ?? 0;
    if (event.key === " ") onTogglePlay();
    else if ((event.key === "Delete" || event.key === "Backspace") && selectedId !== null) onDelete(selectedId);
    else if (event.key === "Escape") onSelect(null);
    else if (event.key === "ArrowLeft") onSeek(clamp(time - (event.shiftKey ? 5 : 1), 0, duration));
    else if (event.key === "ArrowRight") onSeek(clamp(time + (event.shiftKey ? 5 : 1), 0, duration));
    else if (event.key === "Home") onSeek(0);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label="Dạng sóng âm thanh. Kéo để chọn đoạn, kéo mép để chỉnh, Space để phát, Delete để xóa đoạn đang chọn."
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event, true)}
      onPointerCancel={(event) => finishPointer(event, false)}
      onScroll={() => {
        dirtyRef.current = true;
      }}
      onKeyDown={handleKeyDown}
      style={{
        position: "relative",
        overflowX: zoom > 1 ? "auto" : "hidden",
        overflowY: "hidden",
        borderRadius: "var(--p-border-radius-200)",
        border: "var(--p-border-width-025) solid var(--p-color-border)",
        outlineOffset: 2,
        touchAction: "none",
        userSelect: "none",
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? "default" : "crosshair",
      }}
    >
      <div style={{ width: totalWidth || "100%", height: HEIGHT }}>
        <canvas
          ref={canvasRef}
          style={{ position: "sticky", left: 0, display: "block", width: width || "100%", height: HEIGHT }}
        />
      </div>
    </div>
  );
}
