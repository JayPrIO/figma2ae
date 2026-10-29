/**
 * Minimal Prometheus-compatible metrics. Counters/gauges are plain numbers; histograms use
 * fixed buckets (O(buckets) observe, O(1) memory) with interpolated quantile estimates.
 * Single-threaded Node: no locking required.
 */

export class Counter {
  private v = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  inc(by = 1): void {
    this.v += by;
  }
  get value(): number {
    return this.v;
  }
  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} counter\n${this.name} ${this.v}\n`;
  }
}

export class Gauge {
  private v = 0;
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  set(v: number): void {
    this.v = v;
  }
  inc(by = 1): void {
    this.v += by;
  }
  dec(by = 1): void {
    this.v -= by;
  }
  get value(): number {
    return this.v;
  }
  render(): string {
    return `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} gauge\n${this.name} ${this.v}\n`;
  }
}

/** Default latency buckets in milliseconds (1 ms … 5 min). */
export const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000];

export class Histogram {
  private readonly counts: Float64Array;
  private sum = 0;
  private n = 0;
  private maxSeen = 0;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = LATENCY_BUCKETS_MS,
  ) {
    this.counts = new Float64Array(buckets.length + 1); // +Inf bucket last
  }

  observe(v: number): void {
    const b = this.buckets;
    // linear scan beats binary search for ≤ 16 buckets (branch-predictable, cache-resident)
    let i = 0;
    while (i < b.length && v > b[i]) i++;
    this.counts[i]++;
    this.sum += v;
    this.n++;
    if (v > this.maxSeen) this.maxSeen = v;
  }

  get count(): number {
    return this.n;
  }

  /** Quantile estimate by linear interpolation within the containing bucket. */
  quantile(q: number): number {
    if (this.n === 0) return 0;
    const target = q * this.n;
    let cum = 0;
    for (let i = 0; i < this.counts.length; i++) {
      const c = this.counts[i];
      if (cum + c >= target && c > 0) {
        const lo = i === 0 ? 0 : this.buckets[i - 1];
        const hi = i < this.buckets.length ? this.buckets[i] : this.maxSeen;
        return lo + ((hi - lo) * (target - cum)) / c;
      }
      cum += c;
    }
    return this.maxSeen;
  }

  snapshot(): { count: number; mean: number; p50: number; p95: number; p99: number; max: number } {
    return {
      count: this.n,
      mean: this.n ? this.sum / this.n : 0,
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      max: this.maxSeen,
    };
  }

  render(): string {
    let out = `# HELP ${this.name} ${this.help}\n# TYPE ${this.name} histogram\n`;
    let cum = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cum += this.counts[i];
      out += `${this.name}_bucket{le="${this.buckets[i]}"} ${cum}\n`;
    }
    cum += this.counts[this.buckets.length];
    out += `${this.name}_bucket{le="+Inf"} ${cum}\n${this.name}_sum ${this.sum}\n${this.name}_count ${this.n}\n`;
    return out;
  }
}

export class BridgeMetrics {
  readonly connectionsTotal = new Counter('f2ae_connections_total', 'WebSocket connections accepted');
  readonly connectionsRejected = new Counter('f2ae_connections_rejected_total', 'Upgrades rejected (origin/limits)');
  readonly connectionsActive = new Gauge('f2ae_connections_active', 'Open WebSocket connections');
  readonly syncsStarted = new Counter('f2ae_syncs_started_total', 'sync.begin received');
  readonly syncsSucceeded = new Counter('f2ae_syncs_succeeded_total', 'Builds completed successfully');
  readonly syncsFailed = new Counter('f2ae_syncs_failed_total', 'Syncs that failed (validation, host, timeout)');
  readonly protocolErrors = new Counter('f2ae_protocol_errors_total', 'Malformed or out-of-order client frames');
  readonly bytesIn = new Counter('f2ae_bytes_in_total', 'Bytes received from clients');
  readonly assetsReceived = new Counter('f2ae_assets_received_total', 'Asset frames stored');
  readonly assetsDeduped = new Counter('f2ae_assets_deduped_total', 'Assets skipped because they were already cached');
  readonly queueDepth = new Gauge('f2ae_build_queue_depth', 'Builds waiting or running');
  readonly receiveLatency = new Histogram('f2ae_sync_receive_ms', 'sync.begin → sync.commit latency (ms)');
  readonly buildLatency = new Histogram('f2ae_build_ms', 'Host build duration (ms)');
  readonly endToEndLatency = new Histogram('f2ae_sync_e2e_ms', 'sync.begin → sync.result latency (ms)');

  private all(): { render(): string }[] {
    return [
      this.connectionsTotal,
      this.connectionsRejected,
      this.connectionsActive,
      this.syncsStarted,
      this.syncsSucceeded,
      this.syncsFailed,
      this.protocolErrors,
      this.bytesIn,
      this.assetsReceived,
      this.assetsDeduped,
      this.queueDepth,
      this.receiveLatency,
      this.buildLatency,
      this.endToEndLatency,
    ];
  }

  renderPrometheus(): string {
    return this.all()
      .map((m) => m.render())
      .join('');
  }

  summary(): Record<string, unknown> {
    return {
      connections: { total: this.connectionsTotal.value, active: this.connectionsActive.value },
      syncs: { started: this.syncsStarted.value, ok: this.syncsSucceeded.value, failed: this.syncsFailed.value },
      assets: { received: this.assetsReceived.value, deduped: this.assetsDeduped.value },
      queueDepth: this.queueDepth.value,
      latencyMs: {
        receive: this.receiveLatency.snapshot(),
        build: this.buildLatency.snapshot(),
        endToEnd: this.endToEndLatency.snapshot(),
      },
    };
  }
}
