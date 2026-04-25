import type { ServerResponse } from "node:http";

/**
 * Wraps a Node ServerResponse for Server-Sent Events. Sets the appropriate
 * headers, exposes `send(eventName, data)` for typed writes, and provides
 * a heartbeat to detect half-open connections.
 *
 * Usage:
 *   const sse = new SseConnection(reply.raw);
 *   sse.send("reading", { ts, btC, etC });
 *   ...
 *   request.raw.on("close", () => sse.close());
 */
export class SseConnection {
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly res: ServerResponse) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // disable buffering in proxies
    res.flushHeaders();

    // Heartbeat: every 15s, send an SSE comment line. Comments are ignored by
    // EventSource but keep the TCP connection alive and let us detect dead
    // clients via write errors.
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      this.writeRaw(": heartbeat\n\n");
    }, 15000);
  }

  /**
   * Send a typed SSE event. The `data` is JSON-serialized. The event name
   * lets EventSource route to a specific listener (`source.addEventListener("reading", ...)`).
   */
  send(eventName: string, data: unknown): void {
    if (this.closed) return;
    const payload = JSON.stringify(data);
    this.writeRaw(`event: ${eventName}\ndata: ${payload}\n\n`);
  }

  /** Close the connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    try {
      this.res.end();
    } catch {
      /* response already closed */
    }
  }

  private writeRaw(text: string): void {
    if (this.closed) return;
    if (!this.res.writable) {
      this.close();
      return;
    }
    try {
      this.res.write(text);
    } catch {
      this.close();
    }
  }
}
