import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, type RoastDetail } from "../api.ts";
import { Chart, type ChartPoint, type ChartMarker } from "../components/Chart.tsx";

export function RoastDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RoastDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .getRoast(id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return <div className="error">Missing roast id.</div>;
  if (error) return <div className="error">Failed to load roast: {error}</div>;
  if (detail === null) return <div className="muted">Loading…</div>;

  const points: ChartPoint[] = detail.readings.map((r) => ({
    tSec: r.tMs / 1000,
    btC: r.btC,
  }));
  const markers: ChartMarker[] = detail.events.map((e) => ({
    tSec: (e.ts - detail.roast.chargeTs) / 1000,
    event: e.event,
  }));

  return (
    <div className="roast-detail">
      <header className="roast-detail__header">
        <h2>{detail.roast.name}</h2>
        <div className="roast-detail__meta">
          {new Date(detail.roast.chargeTs).toLocaleString()}
          {detail.roast.dropTs !== null
            ? ` · ${formatDuration(detail.roast.chargeTs, detail.roast.dropTs)}`
            : " · in progress"}
        </div>
        <Link to="/roasts" className="roast-detail__back">← Back to history</Link>
      </header>
      <Chart points={points} markers={markers} />
      <ul className="roast-detail__events">
        {detail.events.map((e) => (
          <li key={e.id}>
            <span className="event-name">{e.event.replace("_", " ")}</span>
            <span className="event-time">
              {formatRelativeMs(e.ts - detail.roast.chargeTs)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDuration(chargeTs: number, dropTs: number): string {
  const sec = Math.round((dropTs - chargeTs) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatRelativeMs(ms: number): string {
  const sec = Math.round(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = Math.abs(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
