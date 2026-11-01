import type { Logger } from "pino";
import { InvariantViolationError } from "../../errors/index.ts";
import {
  NOTIFICATION_PENDING_WARN_AFTER_MS, NOTIFICATION_PENDING_WARNING_INTERVAL_MS, NOTIFICATION_SATURATED_WARN_AFTER_MS,
  RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES, RESULT_NOTIFICATION_CONCURRENCY
} from "../../config.ts";

export interface ResultIoOwner {
  readonly id: string;
  readonly payloadBytes: number;
}
type Operation = "channel" | "send";
interface PendingIo extends ResultIoOwner {
  readonly operation: Operation;
  readonly partNo: number | null;
  readonly startedAt: number;
  readonly settled: Promise<void>;
  readonly release: () => void;
  waiting: boolean;
}

export interface ResultIoLedger {
  run<T>(owner: ResultIoOwner, operation: Operation, partNo: number | null, call: () => PromiseLike<T>): Promise<T>;
  /** End only the application wait, leaving the actual SDK operation owned. */
  detach(id: string): void;
  reservations(): readonly ResultIoOwner[];
  stop(): void;
  drain(): Promise<void>;
  snapshot(): { readonly pending: number; readonly payloadBytes: number; readonly oldestAgeMs: number };
}

/** Own at most one SDK operation per delivery, including calls that outlive its timeout. */
export const createResultIoLedger = (options: {
  readonly logger: Pick<Logger, "info" | "warn">;
  readonly onSettled?: () => void;
  readonly monotonicNow?: () => number;
}): ResultIoLedger => {
  const now = options.monotonicNow ?? (() => performance.now());
  const pending = new Map<string, PendingIo>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fullSince: number | undefined;
  const observe = (report: () => void): void => {
    // invariant: diagnostics must never prevent release, wake, or the original SDK settlement.
    try { report(); } catch { /* Ownership is independent of the logging destination. */ }
  };
  const snapshot = (): ReturnType<ResultIoLedger["snapshot"]> => {
    const current = now();
    let payloadBytes = 0;
    let oldestAgeMs = 0;
    for (const entry of pending.values()) {
      payloadBytes += entry.payloadBytes;
      oldestAgeMs = Math.max(oldestAgeMs, current - entry.startedAt);
    }
    return { pending: pending.size, payloadBytes, oldestAgeMs };
  };
  const updateFull = (): void => {
    const state = snapshot();
    const full = state.pending >= RESULT_NOTIFICATION_CONCURRENCY || state.payloadBytes >= RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES;
    fullSince = full ? (fullSince ?? now()) : undefined;
  };
  const monitor = (): void => {
    timer = undefined;
    const state = snapshot();
    if (state.pending === 0) { return; }
    if (state.oldestAgeMs >= NOTIFICATION_PENDING_WARN_AFTER_MS) {
      observe(() => options.logger.warn({ event: "result_notification.io_pending", ...state,
        saturatedForMs: fullSince === undefined ? 0 : now() - fullSince,
        investigate: fullSince !== undefined && now() - fullSince >= NOTIFICATION_SATURATED_WARN_AFTER_MS }));
    }
    timer = setTimeout(monitor, NOTIFICATION_PENDING_WARNING_INTERVAL_MS);
    timer.unref();
  };
  const settle = (entry: PendingIo, success: boolean): void => {
    pending.delete(entry.id);
    updateFull();
    if (pending.size === 0) { clearTimeout(timer); timer = undefined; }
    entry.release();
    if (!entry.waiting) {
      observe(() => options.logger.info({ event: success ? "result_notification.io_late_success" : "result_notification.io_late_failure",
        notificationId: entry.id, operation: entry.operation, partNo: entry.partNo, elapsedMs: now() - entry.startedAt }));
      observe(() => options.onSettled?.());
    }
  };
  return {
    snapshot,
    reservations: () => [...pending.values()].map(({ id, payloadBytes }) => ({ id, payloadBytes })),
    detach: id => { const entry = pending.get(id); if (entry) { entry.waiting = false; } },
    stop: () => { stopped = true; },
    drain: async () => { await Promise.all([...pending.values()].map(entry => entry.settled)); },
    run: <T>(owner: ResultIoOwner, operation: Operation, partNo: number | null, call: () => PromiseLike<T>): Promise<T> => {
      const state = snapshot();
      if (stopped || pending.has(owner.id) || pending.size >= RESULT_NOTIFICATION_CONCURRENCY
        || owner.payloadBytes < 0 || !Number.isSafeInteger(owner.payloadBytes)
        || (pending.size > 0 && state.payloadBytes + owner.payloadBytes > RESULT_NOTIFICATION_CLAIM_BUDGET_BYTES)) {
        throw new InvariantViolationError("Invalid result I/O reservation.");
      }
      let release!: () => void;
      const settled = new Promise<void>(resolve => { release = resolve; });
      const entry: PendingIo = { id: owner.id, payloadBytes: owner.payloadBytes, operation, partNo,
        startedAt: now(), settled, release, waiting: true };
      pending.set(owner.id, entry);
      updateFull();
      if (!timer) { timer = setTimeout(monitor, NOTIFICATION_PENDING_WARN_AFTER_MS); timer.unref(); }
      let work: Promise<T>;
      try { work = Promise.resolve(call()); }
      catch (error: unknown) { work = Promise.reject(error); }
      return work.then(value => { settle(entry, true); return value; }, error => { settle(entry, false); throw error; });
    }
  };
};
