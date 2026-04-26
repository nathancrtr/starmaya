import { useMemo, useState } from "react";
import type { RoastEvent } from "@starmaya/shared";
import { useStream } from "../hooks/useStream.ts";
import { Chart, type ChartPoint, type ChartMarker } from "../components/Chart.tsx";
import { api } from "../api.ts";

/** Events that go through the generic events endpoint (not CHARGE or DROP). */
const MID_ROAST_EVENTS: RoastEvent[] = ["DRY_END", "FC_START", "FC_END"];

export function RoastPage() {
  const stream = useStream();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<RoastEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = stream.activeRoast;
  const recordedEvents = useMemo(
    () => new Set(stream.events.map((e) => e.event)),
    [stream.events],
  );

  // Build chart data from streamed ticks, expressed as seconds since CHARGE.
  const chartPoints: ChartPoint[] = useMemo(() => {
    if (!active) return [];
    return stream.ticks.map((t) => ({
      tSec: (t.ts - active.chargeTs) / 1000,
      btC: t.btC,
    }));
  }, [stream.ticks, active]);

  const chartMarkers: ChartMarker[] = useMemo(() => {
    if (!active) return [];
    return stream.events.map((e) => ({
      tSec: (e.ts - active.chargeTs) / 1000,
      event: e.event,
    }));
  }, [stream.events, active]);

  const elapsedSec = active && stream.lastTick
    ? Math.max(0, (stream.lastTick.ts - active.chargeTs) / 1000)
    : null;

  // ── Actions ──────────────────────────────────────────────────────

  const handleCharge = async () => {
    if (active || busy) return;
    if (name.trim().length === 0) {
      setError("Enter a roast name first");
      return;
    }
    setBusy("CHARGE");
    setError(null);
    try {
      await api.startRoast({
        name: name.trim(),
        chargeTs: Date.now(),
        clientId: crypto.randomUUID(),
      });
      // SSE will deliver roast_started; useStream picks it up.
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleEvent = async (event: RoastEvent) => {
    if (!active || busy) return;
    setBusy(event);
    setError(null);
    try {
      await api.recordEvent({
        roastId: active.id,
        event,
        ts: Date.now(),
        clientId: crypto.randomUUID(),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const handleDrop = async () => {
    if (!active || busy) return;
    setBusy("DROP");
    setError(null);
    try {
      await api.endRoast({
        roastId: active.id,
        dropTs: Date.now(),
        clientId: crypto.randomUUID(),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="roast-page">
      <section className="readout">
        <div className="readout__bt">
          {stream.lastTick ? `${stream.lastTick.btC.toFixed(1)}°C` : "—"}
        </div>
        <div className="readout__meta">
          <span className={`status status--${stream.deviceStatus}`}>
            {stream.deviceStatus}
          </span>
          {elapsedSec !== null && (
            <span className="readout__elapsed">{formatElapsed(elapsedSec)}</span>
          )}
        </div>
      </section>

      <section className="controls">
        {!active ? (
          <>
            <input
              className="controls__name"
              type="text"
              placeholder="Roast name (e.g. Ethiopia Yirgacheffe — 2026-04-25)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy !== null}
            />
            <button
              className="btn btn--charge"
              onClick={handleCharge}
              disabled={busy !== null}
            >
              CHARGE
            </button>
          </>
        ) : (
          <>
            <div className="controls__active-name">{active.name}</div>
            <div className="controls__events">
              {MID_ROAST_EVENTS.map((ev) => (
                <button
                  key={ev}
                  className={`btn btn--${ev.toLowerCase()}`}
                  onClick={() => handleEvent(ev)}
                  disabled={busy !== null || recordedEvents.has(ev)}
                >
                  {ev.replace("_", " ")}
                </button>
              ))}
              <button
                className="btn btn--drop"
                onClick={handleDrop}
                disabled={busy !== null}
              >
                DROP
              </button>
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
      </section>

      <section className="chart-section">
        <Chart points={chartPoints} markers={chartMarkers} />
      </section>
    </div>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
