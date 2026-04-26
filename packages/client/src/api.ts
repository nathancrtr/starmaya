import type {
  RoastEvent,
  RoastEventRecord,
  RoastRecord,
  ReadingRecord,
} from "@starmaya/shared";

export interface RoastDetail {
  roast: RoastRecord;
  readings: ReadingRecord[];
  events: RoastEventRecord[];
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listRoasts(): Promise<{ roasts: RoastRecord[] }> {
    return request("/api/roasts");
  },

  getRoast(id: string): Promise<RoastDetail> {
    return request(`/api/roasts/${encodeURIComponent(id)}`);
  },

  /** CHARGE: create a new roast. */
  startRoast(input: {
    name: string;
    chargeTs: number;
    clientId: string;
  }): Promise<{ roast: RoastRecord }> {
    return request("/api/roasts", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  /** Generic event marker (DRY_END, FC_START, FC_END). */
  recordEvent(input: {
    roastId: string;
    event: RoastEvent;
    ts: number;
    clientId: string;
  }): Promise<{ event: RoastEventRecord }> {
    return request(`/api/roasts/${encodeURIComponent(input.roastId)}/events`, {
      method: "POST",
      body: JSON.stringify({
        event: input.event,
        ts: input.ts,
        clientId: input.clientId,
      }),
    });
  },

  /** DROP: end a roast. Optionally also rename it. */
  endRoast(input: {
    roastId: string;
    dropTs: number;
    clientId: string;
    name?: string;
  }): Promise<{ roast: RoastRecord }> {
    return request(`/api/roasts/${encodeURIComponent(input.roastId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        dropTs: input.dropTs,
        clientId: input.clientId,
        ...(input.name !== undefined ? { name: input.name } : {}),
      }),
    });
  },

  /** Rename without ending. */
  renameRoast(input: { roastId: string; name: string }): Promise<{ roast: RoastRecord }> {
    return request(`/api/roasts/${encodeURIComponent(input.roastId)}`, {
      method: "PATCH",
      body: JSON.stringify({ name: input.name }),
    });
  },
};
