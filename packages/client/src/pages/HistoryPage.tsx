import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RoastRecord } from "@starmaya/shared";
import { api } from "../api.ts";

export function HistoryPage() {
  const [roasts, setRoasts] = useState<RoastRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listRoasts()
      .then((res) => {
        if (!cancelled) setRoasts(res.roasts);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <div className="error">Failed to load roasts: {error}</div>;
  if (roasts === null) return <div className="muted">Loading…</div>;
  if (roasts.length === 0) {
    return <div className="muted">No roasts yet. Hit CHARGE on the live page to start one.</div>;
  }

  return (
    <div className="history">
      <ul className="history__list">
        {roasts.map((r) => (
          <li key={r.id} className="history__item">
            <Link to={`/roasts/${r.id}`} className="history__link">
              <span className="history__name">{r.name}</span>
              <span className="history__meta">
                {formatDate(r.chargeTs)} · {formatDuration(r)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString();
}

function formatDuration(r: RoastRecord): string {
  if (r.dropTs === null) return "in progress";
  const sec = Math.round((r.dropTs - r.chargeTs) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
