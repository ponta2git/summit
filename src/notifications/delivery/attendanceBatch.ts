import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import type { Client } from "discord.js";
import type { AppContext } from "../../appContext.ts";
import { AppError, InvariantViolationError } from "../../errors/index.ts";
import { errorFromCause } from "../../runtime/cause.ts";
import { createDeliveryCapacity, type DeliveryCapacity } from "./capacity.ts";
import { deliveryLanes } from "./lanes.ts";
import { deliverOutboxEntry } from "./attendanceDelivery.ts";
import { claimAttendance } from "./sources/attendance.ts";

/** Finish claim/start before awaiting deliveries so the coordinator retains only fibers and count. */
const startAttendanceBatch = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  capacity: DeliveryCapacity,
  isStopping: () => boolean
) {
  const batch = yield* claimAttendance(ctx, capacity.snapshot());
  const claimed = batch.length;
  const fibers = yield* Effect.forEach(batch, entry => capacity.start(entry.id, 0,
    execution => deliverOutboxEntry(client, ctx, entry, { ...execution, isStopping: () => isStopping() || execution.isStopping() })));
  return { claimed, fibers };
});

/**
 * Claim a batch of PENDING outbox entries and deliver each.
 *
 * @remarks
 * idempotent: 各 entry の Exit を集計して隔離。全体例外は呼び出し側 (`runEffectTickSafely`) が閉じ込める。
 */
export const runOutboxWorkerTick = Effect.fnUntraced(function* (
  client: Client,
  ctx: AppContext,
  isStopping: () => boolean = () => false
): Effect.fn.Return<{ readonly claimed: number }, unknown> {
  if (isStopping()) { return { claimed: 0 }; }
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => createDeliveryCapacity({ laneId: "attendance", ...deliveryLanes.attendance })),
    capacity => Effect.gen(function* () {
      const { claimed, fibers } = yield* startAttendanceBatch(client, ctx, capacity, isStopping);
      // race: Fail / Die を含め全配送と heartbeat の settlement を待ち、入力順で失敗を選ぶ。
      const results = yield* Effect.forEach(fibers, fiber => Fiber.await(fiber), { concurrency: "unbounded" });
      const interrupted = results.find(exit => Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause));
      if (interrupted && Exit.isFailure(interrupted)) { return yield* Effect.failCause(interrupted.cause); }
      const failed = results.find(Exit.isFailure);
      if (failed) {
        return yield* Effect.fail(new InvariantViolationError("Failed to finalize outbox delivery.", {
          cause: errorFromCause(failed.cause)
        }));
      }
      return { claimed };
    }),
    capacity => capacity.close()
  );
}, Effect.catchCause(cause => {
  if (Cause.hasInterrupts(cause)) {
    return Effect.failCause(Cause.map(cause, error => error instanceof AppError ? error :
      new InvariantViolationError("Failed to finalize outbox delivery batch.", { cause: error })));
  }
  const error = errorFromCause(cause);
  return Effect.fail(error instanceof AppError ? error :
    new InvariantViolationError("Failed to finalize outbox delivery batch.", { cause: error }));
}));
