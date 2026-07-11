/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Local sleep detection via setTimeout gap analysis. */

export type SleepListener = (sleptMs: number) => void;

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_THRESHOLD_MULTIPLE = 3;

/** Detects local sleep by checking gaps between timer fires. */
export class SleepDetector {
  private timer: NodeJS.Timeout | undefined;
  private lastFire = 0;
  private readonly listeners = new Set<SleepListener>();

  constructor(
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly thresholdMultiple: number = DEFAULT_THRESHOLD_MULTIPLE,
  ) {}

  start(): void {
    if (this.timer) return;
    this.lastFire = Date.now();
    this.scheduleNext();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.listeners.clear();
  }

  onSleep(listener: SleepListener): void {
    this.listeners.add(listener);
  }

  /** Gap (ms) since last timer fire. Used by focus handlers to confirm sleep. */
  currentGap(): number {
    return this.lastFire > 0 ? Date.now() - this.lastFire : 0;
  }

  /** True if the current gap exceeds the sleep threshold. */
  isSleepingByGap(): boolean {
    if (this.lastFire === 0) return false;
    return this.currentGap() > this.intervalMs * this.thresholdMultiple;
  }

  private scheduleNext(): void {
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  private tick(): void {
    const now = Date.now();
    const gap = now - this.lastFire;
    this.lastFire = now;

    if (gap > this.intervalMs * this.thresholdMultiple) {
      const sleptMs = gap - this.intervalMs;
      for (const listener of this.listeners) {
        try {
          listener(sleptMs);
        } catch {
          // ignore
        }
      }
    }

    this.scheduleNext();
  }
}
