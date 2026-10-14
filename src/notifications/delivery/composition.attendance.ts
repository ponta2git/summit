import type { Client } from "discord.js";
import type { Logger } from "pino";
import type * as Effect from "effect/Effect";
import type { AppContext } from "../../appContext.ts";
import type { OutboxEntry } from "../../db/ports.ts";
import type { AppError } from "../../errors/index.ts";
import { deliverOutboxEntry, type AttendanceDeliveryAdapters } from "./attendanceDelivery.ts";
import { runAttendanceBatch } from "./attendanceBatch.ts";
import { createAttendanceRuntime, type AttendanceDeliveryRuntime } from "./attendanceRuntime.ts";
import type { DeliveryTask } from "./contracts.ts";
import { prepareAttendanceNotification } from "./definitions/attendance.ts";
import { claimAttendance, readAttendanceDispatchAt } from "./sources/attendance.ts";
import { deliverSinglePost } from "./strategies/singlePost.ts";

/** Bind definitions and a single-post strategy without starting rendering or external I/O. */
const createAttendanceTaskFactory = (deps: {
  readonly client: Client;
  readonly context: AppContext;
  readonly prepareNotification?: AttendanceDeliveryAdapters["prepareNotification"];
  readonly strategy?: AttendanceDeliveryAdapters["strategy"];
}): ((entry: OutboxEntry) => DeliveryTask) => {
  const adapters: AttendanceDeliveryAdapters = {
    prepareNotification: deps.prepareNotification ?? prepareAttendanceNotification,
    strategy: deps.strategy ?? deliverSinglePost
  };
  return entry => ({ id: entry.id, payloadBytes: 0,
    run: execution => deliverOutboxEntry(deps.client, deps.context, entry, execution, adapters) });
};

/** Production wiring for a standalone attendance batch, also used by the runtime. */
export const runOutboxWorkerTick = (
  client: Client,
  context: AppContext,
  isStopping: () => boolean = () => false,
  adapters: Partial<AttendanceDeliveryAdapters> = {}
): Effect.Effect<{ readonly claimed: number }, AppError> => runAttendanceBatch({
  claim: budget => claimAttendance(context, budget),
  prepareTask: createAttendanceTaskFactory({ client, context, ...adapters })
}, isStopping);

/** The scheduler supplies the shared next-dispatch hint; this factory wires the remaining dependencies. */
export const createAttendanceDeliveryRuntime = (deps: {
  readonly client: Client;
  readonly context: AppContext;
  readonly logger: Pick<Logger, "debug" | "error" | "info" | "warn">;
  readonly onWake: (reason: string) => void;
} & Partial<AttendanceDeliveryAdapters>): AttendanceDeliveryRuntime => {
  const { client, context, logger, onWake, ...adapters } = deps;
  return createAttendanceRuntime({
    clock: context.clock, logger, onWake,
    runBatch: isStopping => runOutboxWorkerTick(client, context, isStopping, adapters),
    nextDispatchAt: now => readAttendanceDispatchAt(context, now)
  });
};
