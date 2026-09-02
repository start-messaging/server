import { Injectable } from '@nestjs/common';

/**
 * In-memory progress of the enrichment drain, shared between the worker
 * (writes) and the pipeline endpoint (reads).
 *
 * In-memory is correct here, not a shortcut: this deployment runs exactly
 * one process — the EC2 box runs the API and its worker together — so the
 * endpoint reading a field the worker just wrote is same-process state, and
 * `running` doubles as the guard that keeps a second drain from starting
 * while one is going. If the worker ever moves to its own process, this
 * moves to Redis with it.
 */
@Injectable()
export class EnrichRunState {
  running = false;
  startedAt: Date | null = null;
  /** Leads processed so far by the drain currently running. */
  processed = 0;
  lastRun: {
    startedAt: Date;
    finishedAt: Date;
    processed: number;
    /** 'drained' = ran out of eligible leads; other values name the stop. */
    stoppedBecause: 'drained' | 'disabled' | 'max-per-run';
  } | null = null;

  start(): void {
    this.running = true;
    this.startedAt = new Date();
    this.processed = 0;
  }

  finish(stoppedBecause: 'drained' | 'disabled' | 'max-per-run'): void {
    if (this.startedAt) {
      this.lastRun = {
        startedAt: this.startedAt,
        finishedAt: new Date(),
        processed: this.processed,
        stoppedBecause,
      };
    }
    this.running = false;
    this.startedAt = null;
    this.processed = 0;
  }
}
