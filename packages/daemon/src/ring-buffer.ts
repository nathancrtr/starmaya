/**
 * Fixed-size circular buffer. When full, each push overwrites the oldest entry.
 * Used by the daemon to retain the most recent N readings so a reconnecting
 * web server can replay them and avoid a gap in the live chart.
 */
export class RingBuffer<T> {
  private readonly buf: (T | undefined)[];
  private writeIdx = 0;
  private filled = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[this.writeIdx] = item;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Returns buffered entries in oldest-first order. */
  snapshot(): T[] {
    const out: T[] = new Array(this.filled);
    if (this.filled < this.capacity) {
      for (let i = 0; i < this.filled; i++) out[i] = this.buf[i] as T;
    } else {
      // When full, writeIdx points to the slot about to be overwritten next —
      // i.e. the oldest entry. Walk forward from there, wrapping at the end.
      for (let i = 0; i < this.capacity; i++) {
        const idx = (this.writeIdx + i) % this.capacity;
        out[i] = this.buf[idx] as T;
      }
    }
    return out;
  }

  get length(): number {
    return this.filled;
  }
}
