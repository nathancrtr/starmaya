import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { RoastEvent } from "@starmaya/shared";

/** A point on the BT curve. `tSec` is seconds since CHARGE. */
export interface ChartPoint {
  tSec: number;
  btC: number;
}

/** A vertical event marker overlaid on the chart. */
export interface ChartMarker {
  tSec: number;
  event: RoastEvent;
}

interface Props {
  points: ChartPoint[];
  markers?: ChartMarker[];
  /** Optional pixel height. Width follows the container. Default 320. */
  height?: number;
}

/** Stable color per event type. */
const EVENT_COLOR: Record<RoastEvent, string> = {
  CHARGE: "#1f9e3d",
  DRY_END: "#d2a106",
  FC_START: "#d63d3d",
  FC_END: "#9c1f1f",
  DROP: "#1f44d6",
};

/**
 * Live + historical BT chart. Wraps uPlot. The component is "uncontrolled"
 * w.r.t. uPlot — we manage the instance via refs and feed it new data via
 * setData() rather than re-creating it on every prop change.
 */
export function Chart({ points, markers = [], height = 320 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);

  // ── Create the plot once ──────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      scales: {
        x: { time: false },
        y: { auto: true },
      },
      axes: [
        { label: "time (s)" },
        { label: "BT (°C)" },
      ],
      series: [
        {}, // x
        { label: "BT", stroke: "#222", width: 2 },
      ],
      hooks: {
        draw: [
          (u) => {
            // Draw event markers as vertical lines.
            const ctx = u.ctx;
            const top = u.bbox.top;
            const bottom = u.bbox.top + u.bbox.height;
            ctx.save();
            for (const m of markersRef.current) {
              const x = u.valToPos(m.tSec, "x", true);
              ctx.strokeStyle = EVENT_COLOR[m.event];
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.moveTo(x, top);
              ctx.lineTo(x, bottom);
              ctx.stroke();
              ctx.fillStyle = EVENT_COLOR[m.event];
              ctx.font = "11px sans-serif";
              ctx.fillText(m.event, x + 3, top + 12);
            }
            ctx.restore();
          },
        ],
      },
    };

    const plot = new uPlot(opts, [[], []], el);
    plotRef.current = plot;

    // Resize with the container.
    const observer = new ResizeObserver(() => {
      plot.setSize({ width: el.clientWidth, height });
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [height]);

  // ── Push new data on every prop change ────────────────────────────
  // Keep markers in a ref so the draw hook (created once above) sees the
  // latest set without us re-creating the plot.
  const markersRef = useRef<ChartMarker[]>(markers);
  useEffect(() => {
    markersRef.current = markers;
    plotRef.current?.redraw();
  }, [markers]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const xs = points.map((p) => p.tSec);
    const ys = points.map((p) => p.btC);
    plot.setData([xs, ys]);
  }, [points]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}
