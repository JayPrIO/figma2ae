/**
 * Serial job queue with bounded depth and per-job timeout.
 * After Effects executes scripts on a single thread, so builds must never overlap.
 */

export class QueueFullError extends Error {
  constructor(readonly limit: number) {
    super(`build queue is full (${limit} pending)`);
  }
}

export class JobTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`build timed out after ${timeoutMs} ms`);
  }
}

interface Entry<T> {
  run: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export class SerialQueue<T> {
  private readonly pending: Entry<T>[] = [];
  private head = 0;
  private running = false;

  constructor(
    private readonly maxPending: number,
    private readonly timeoutMs: number,
    private readonly onDepthChange?: (depth: number) => void,
  ) {}

  /** Jobs waiting (excluding the running one). */
  get waiting(): number {
    return this.pending.length - this.head;
  }

  get depth(): number {
    return this.waiting + (this.running ? 1 : 0);
  }

  /**
   * Enqueues a job. Returns its 1-based queue position and a promise for its result.
   * Throws QueueFullError synchronously when saturated (backpressure, fail fast).
   */
  push(run: () => Promise<T>): { position: number; result: Promise<T> } {
    if (this.waiting >= this.maxPending) throw new QueueFullError(this.maxPending);
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending.push({ run, resolve, reject });
    const position = this.depth;
    this.onDepthChange?.(this.depth);
    void this.drain();
    return { position, result };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.head < this.pending.length) {
        const job = this.pending[this.head];
        this.pending[this.head++] = undefined as unknown as Entry<T>;
        // compact occasionally: amortised O(1) dequeue without Array#shift's O(n)
        if (this.head > 64 && this.head * 2 > this.pending.length) {
          this.pending.splice(0, this.head);
          this.head = 0;
        }
        this.onDepthChange?.(this.depth);
        let timer: NodeJS.Timeout | undefined;
        try {
          const v = await Promise.race([
            job.run(),
            new Promise<never>((_, rej) => {
              timer = setTimeout(() => rej(new JobTimeoutError(this.timeoutMs)), this.timeoutMs);
            }),
          ]);
          job.resolve(v);
        } catch (e) {
          job.reject(e);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      this.running = false;
      this.onDepthChange?.(this.depth);
    }
  }
}
