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
  /** Rate of Rise values (°C/min) aligned 1:1 with `points`. `null` = gap. */
  rorValues?: (number | null)[];
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

/** RoR line color — warm orange, distinct from the dark BT line. */
const ROR_COLOR = "#e07040";

/**
 * Live + historical BT chart with optional RoR overlay. Wraps uPlot. The
 * component is "uncontrolled" w.r.t. uPlot — we manage the instance via refs
 * and feed it new data via setData() rather than re-creating it on every prop
 * change.
 */
export function Chart({ points, markers = [], rorValues, height = 320 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const markersRef = useRef<ChartMarker[]>(markers);

  // Keep markers ref in sync without re-creating the plot, and trigger a
  // redraw so the marker overlay updates immediately.
  useEffect(() => {
    markersRef.current = markers;
    plotRef.current?.redraw();
  }, [markers]);

  // Create-or-recreate the plot whenever points or height change. This is a
  // deliberate trade for live streaming — uPlot's setData on a plot that was
  // born with empty data can leave its scales unresolved (we observed
  // scales.x._min/_max staying null indefinitely). Recreating per render is
  // cheap (uPlot is tuned for it), and constructing with non-empty data
  // every time makes auto-scaling reliable.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || points.length === 0) {
      // No data yet — make sure any prior plot is cleaned up so the container
      // is empty. Real points will trigger a fresh build.
      if (plotRef.current) {
        plotRef.current.destroy();
        plotRef.current = null;
      }
      return;
    }

    const xs = points.map((p) => p.tSec);
    const ys = points.map((p) => p.btC);

    // Build RoR data array for uPlot (use undefined for null gaps).
    const hasRoR = rorValues && rorValues.length === points.length;
    const rorData: (number | null | undefined)[] = hasRoR
      ? rorValues.map((v) => (v === null ? undefined : v))
      : xs.map(() => undefined);

    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      scales: {
        x: { time: false },
        ror: {
          auto: true,
          range: (_u, min, max) => {
            // Give the RoR axis a little padding and a sane floor.
            const lo = Math.min(min ?? 0, 0);
            const hi = Math.max(max ?? 20, 5);
            return [lo - 1, hi + 1];
          },
        },
      },
      axes: [
        { label: "time (s)" },
        { label: "BT (°C)" },
        {
          side: 1,       // right side
          scale: "ror",
          label: "RoR (°C/min)",
          stroke: ROR_COLOR,
          grid: { show: false },
        },
      ],
      series: [
        {}, // x
        { label: "BT", stroke: "#222", width: 2 },
        {
          label: "RoR",
          stroke: ROR_COLOR,
          width: 1.5,
          scale: "ror",
          dash: [6, 3],
          spanGaps: false,
        },
      ],
      hooks: {
        draw: [
          (u) => {
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

    if (plotRef.current) {
      plotRef.current.destroy();
    }
    const plot = new uPlot(opts, [xs, ys, rorData as number[]], el);
    plotRef.current = plot;

    return () => {
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
  }, [points, rorValues, height]);

  return <div ref={containerRef} style={{ width: "100%", height }} />;
}
