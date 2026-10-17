import { SHUTDOWN_DRAIN_TIMEOUT_MS } from "../config.ts";

type MaintenanceDrainStage = "admission" | "all";
interface MaintenanceDrainRequest {
  readonly cutoverId: string;
  readonly stopEpoch: number;
  readonly stage: MaintenanceDrainStage;
}
type WriterStatus = "active" | "draining" | "drained" | "timed_out" | "failed";
interface WriterState {
  readonly name: string;
  readonly stage: MaintenanceDrainStage;
  status: WriterStatus;
  failure?: "stop_failed" | "drain_failed" | "drain_timeout";
}
interface DrainWriter {
  readonly name: string;
  readonly stage: MaintenanceDrainStage;
  stop(): void;
  drain(): void | PromiseLike<void>;
}
interface MaintenanceDrainSnapshot {
  readonly consumer: "summit";
  readonly scope: "process";
  readonly cutoverId: string | null;
  readonly stopEpoch: number | null;
  readonly stage: MaintenanceDrainStage | null;
  readonly phase: "running" | "draining" | "drained" | "timed_out" | "failed";
  readonly writers: readonly Readonly<WriterState>[];
}
export interface MaintenanceDrain {
  readonly admissionOpen: boolean;
  readonly receiptsOpen: boolean;
  snapshot(): MaintenanceDrainSnapshot;
  request(input: MaintenanceDrainRequest): "accepted" | "conflict";
}

/** One process owns one cutover. Stop gates never reopen, even after late I/O completion. */
export const createMaintenanceDrain = (
  writers: readonly DrainWriter[], timeoutMs = SHUTDOWN_DRAIN_TIMEOUT_MS
): MaintenanceDrain => {
  let request: MaintenanceDrainRequest | undefined;
  const states: WriterState[] = writers.map(({ name, stage }) => ({ name, stage, status: "active" }));
  const snapshot = (): MaintenanceDrainSnapshot => {
    const selected = states.filter(state => request?.stage === "all" || state.stage === "admission");
    const phase = !request ? "running" : selected.some(state => state.status === "failed") ? "failed"
      : selected.some(state => state.status === "timed_out") ? "timed_out"
      : selected.some(state => state.status !== "drained") ? "draining" : "drained";
    return { consumer: "summit", scope: "process", cutoverId: request?.cutoverId ?? null,
      stopEpoch: request?.stopEpoch ?? null, stage: request?.stage ?? null, phase,
      writers: states.map(state => ({ ...state })) };
  };
  return {
    get admissionOpen() { return request === undefined; },
    get receiptsOpen() { return request?.stage !== "all"; },
    snapshot,
    request: input => {
      if (request && (input.cutoverId !== request.cutoverId || input.stopEpoch !== request.stopEpoch
        || (request.stage === "all" && input.stage === "admission"))) { return "conflict"; }
      request = { ...input };
      // invariant: close every admission gate synchronously before starting any drain.
      const starting = writers.flatMap((writer, index) => {
        const state = states[index];
        if (!state || state.status !== "active" || (input.stage === "admission" && writer.stage === "all")) { return []; }
        state.status = "draining";
        try { writer.stop(); }
        catch { state.status = "failed"; state.failure = "stop_failed"; }
        return [{ writer, state }];
      });
      for (const { writer, state } of starting) {
        const deadline = setTimeout(() => {
          if (state.status === "draining") { state.status = "timed_out"; state.failure = "drain_timeout"; }
        }, timeoutMs);
        // The deadline bounds observation only. Retain actual I/O ownership through settlement.
        void Promise.resolve().then(() => writer.drain()).then(() => {
          if (state.status === "draining") { state.status = "drained"; }
          return undefined;
        }, () => {
          if (state.status === "draining") { state.status = "failed"; state.failure = "drain_failed"; }
        }).finally(() => { clearTimeout(deadline); });
      }
      return "accepted";
    }
  };
};
