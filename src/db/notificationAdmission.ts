import type { Logger } from "pino";
import {
  NOTIFICATION_DB_FAMILY_LIMIT, NOTIFICATION_DB_GLOBAL_LIMIT, NOTIFICATION_DB_MAX_PRODUCERS,
  NOTIFICATION_DB_QUEUE_WAIT_MS, NOTIFICATION_PENDING_WARN_AFTER_MS,
  NOTIFICATION_PENDING_WARNING_INTERVAL_MS, NOTIFICATION_SATURATED_WARN_AFTER_MS
} from "../config.ts";
import { NotificationAdmissionInvariantError, NotificationNotStartedError } from "../errors/index.ts";

export type NotificationFamily = "attendance" | "result";
export type NotificationOperation = "http" | "claim" | "begin" | "renew" | "finalize" | "maintenance";
export interface NotificationAdmissionRequest {
  readonly family: NotificationFamily;
  readonly operation: NotificationOperation;
  /** One in-flight command per internal producer; HTTP requests have their own bounded slots. */
  readonly key: string | symbol;
  /** Read the latest confirmed lease, including renewals completed while this command waits. */
  readonly remainingMs?: () => number;
}
interface Waiting {
  readonly request: NotificationAdmissionRequest;
  readonly queuedAt: number;
  readonly start: () => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}
interface Running {
  readonly request: NotificationAdmissionRequest;
  readonly startedAt: number;
  readonly settled: Promise<void>;
}
export interface NotificationAdmissionSnapshot {
  readonly running: number;
  readonly waiting: number;
  readonly result: number;
  readonly attendance: number;
  readonly renewing: number;
  readonly oldestAgeMs: number;
}
export interface NotificationAdmission {
  run<T>(request: NotificationAdmissionRequest, work: () => Promise<T>): Promise<T>;
  assertCanStart(request: NotificationAdmissionRequest): void;
  stop(): void;
  drain(): Promise<void>;
  snapshot(): NotificationAdmissionSnapshot;
}

const critical = (request: NotificationAdmissionRequest): boolean => request.operation === "renew" || request.operation === "finalize";

/** Bound actual unsettled transactions, before any connection acquisition, across both families. */
export const createNotificationAdmission = (options: {
  readonly logger: Pick<Logger, "warn">;
  readonly monotonicNow?: () => number;
}): NotificationAdmission => {
  const now = options.monotonicNow ?? (() => performance.now());
  const waiting: Waiting[] = [];
  const running = new Set<Running>();
  const keys = new Set<string | symbol>();
  const counts = { result: 0, attendance: 0 };
  let stopped = false;
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  let fullSince: number | undefined;
  let urgentOwed = false;
  const snapshot = (): NotificationAdmissionSnapshot => ({ running: running.size, waiting: waiting.length,
    ...counts, renewing: [...running].filter(job => job.request.operation === "renew").length,
    oldestAgeMs: Math.max(0, ...[...running].map(job => now() - job.startedAt)) });
  const updateMonitor = (): void => {
    fullSince = running.size === NOTIFICATION_DB_GLOBAL_LIMIT ? (fullSince ?? now()) : undefined;
    if (running.size === 0) { clearTimeout(monitorTimer); monitorTimer = undefined; }
    else if (!monitorTimer) {
      monitorTimer = setTimeout(monitor, NOTIFICATION_PENDING_WARN_AFTER_MS); monitorTimer.unref();
    }
  };
  const monitor = (): void => {
    monitorTimer = undefined;
    const state = snapshot();
    if (state.running === 0) { return; }
    if (state.oldestAgeMs >= NOTIFICATION_PENDING_WARN_AFTER_MS) {
      try {
        options.logger.warn({ event: "notification.database_pending", ...state,
          saturatedForMs: fullSince === undefined ? 0 : now() - fullSince,
          investigate: fullSince !== undefined && now() - fullSince >= NOTIFICATION_SATURATED_WARN_AFTER_MS });
      } catch { /* Diagnostics cannot release or strand actual database ownership. */ }
    }
    monitorTimer = setTimeout(monitor, NOTIFICATION_PENDING_WARNING_INTERVAL_MS); monitorTimer.unref();
  };
  const assertCanStart = (request: NotificationAdmissionRequest): void => {
    if (stopped && !critical(request)) { throw new NotificationNotStartedError("stopped"); }
    if ((request.operation === "begin" || request.operation === "renew") && (request.remainingMs?.() ?? Infinity) <= 0) {
      throw new NotificationNotStartedError("expired");
    }
  };
  const remove = (job: Waiting): void => {
    const index = waiting.indexOf(job);
    if (index !== -1) { waiting.splice(index, 1); }
    clearTimeout(job.timer);
  };
  const reject = (job: Waiting, error: unknown): void => {
    remove(job); keys.delete(job.request.key); job.reject(error);
  };
  const pump = (): void => {
    for (const job of [...waiting]) {
      try { assertCanStart(job.request); } catch (error: unknown) { reject(job, error); }
    }
    while (running.size < NOTIFICATION_DB_GLOBAL_LIMIT) {
      const eligible = waiting.filter(job => counts[job.request.family] < NOTIFICATION_DB_FAMILY_LIMIT);
      const ordinary = eligible.find(job => !critical(job.request));
      const urgent = eligible.filter(job => critical(job.request)).sort((a, b) =>
        (a.request.remainingMs?.() ?? Infinity) - (b.request.remainingMs?.() ?? Infinity))[0];
      const aged = ordinary !== undefined && now() - ordinary.queuedAt >= NOTIFICATION_DB_QUEUE_WAIT_MS;
      // An aged ordinary job gets one grant, not an uninterrupted drain of the ordinary queue.
      const next = aged && !(urgentOwed && urgent) ? ordinary : urgent ?? ordinary;
      if (!next) { break; }
      urgentOwed = next === ordinary && aged;
      remove(next); next.start();
    }
  };
  return {
    snapshot, assertCanStart,
    stop: () => { stopped = true; pump(); },
    // Caller stops producers first. Renew/finalize can still be accepted by their owning delivery.
    drain: async () => {
      while (running.size > 0 || waiting.length > 0) {
        await Promise.all([...running].map(job => job.settled));
      }
    },
    run: <T>(request: NotificationAdmissionRequest, work: () => Promise<T>): Promise<T> => new Promise<T>((resolve, rejectWork) => {
      try {
        assertCanStart(request);
        if (keys.has(request.key) || keys.size >= NOTIFICATION_DB_MAX_PRODUCERS) {
          throw new NotificationAdmissionInvariantError("Notification database producer bound exceeded.");
        }
      } catch (error: unknown) { rejectWork(error); return; }
      keys.add(request.key);
      const job: Waiting = {
        request, queuedAt: now(), reject: rejectWork,
        start: () => {
          let release!: () => void;
          const active: Running = { request, startedAt: now(), settled: new Promise<void>(done => { release = done; }) };
          counts[request.family] += 1; running.add(active); updateMonitor();
          // A caller's response timeout never settles this Promise or releases either permit.
          const settle = (): void => {
            running.delete(active); counts[request.family] -= 1; keys.delete(request.key);
            release(); updateMonitor(); pump();
          };
          void Promise.resolve().then(() => { assertCanStart(request); return work(); }).then(
            value => { settle(); resolve(value); return undefined; }, error => { settle(); rejectWork(error); return undefined; }
          );
        }
      };
      waiting.push(job);
      if (request.operation === "http") {
        job.timer = setTimeout(() => { reject(job, new NotificationNotStartedError("queue_timeout")); pump(); }, NOTIFICATION_DB_QUEUE_WAIT_MS);
      } else if (request.remainingMs && (request.operation === "begin" || request.operation === "renew")) {
        const watchDeadline = (): void => {
          const left = request.remainingMs?.() ?? Infinity;
          if (left <= 0) { reject(job, new NotificationNotStartedError("expired")); pump(); }
          else if (Number.isFinite(left)) { job.timer = setTimeout(watchDeadline, Math.max(1, Math.min(left, 2_147_483_647))); }
        };
        watchDeadline();
      }
      pump();
    })
  };
};
