import type { AppContext } from "../../../appContext.ts";
import { fromDatabaseCall } from "../../../errors/effect.ts";
import type * as Effect from "effect/Effect";
import type { DatabaseError } from "../../../errors/index.ts";
import type { OutboxEntry } from "../../../db/ports.ts";
import { OUTBOX_CLAIM_DURATION_MS } from "../../../config.ts";
import type { DeliveryBudget } from "../capacity.ts";

/** The attendance source owns the durable next-attempt query used by both scheduling paths. */
export const readAttendanceDispatchAt = (ctx: AppContext): Effect.Effect<Date | null, DatabaseError> =>
  fromDatabaseCall(() => ctx.ports.outbox.getNextDispatchAt(), "Failed to read next outbox dispatch time.");

export const claimAttendance = (ctx: AppContext, budget: DeliveryBudget): Effect.Effect<readonly OutboxEntry[], DatabaseError> =>
  fromDatabaseCall(() => ctx.ports.outbox.claimNextBatch({ limit: budget.slots, now: ctx.clock.now(),
    claimDurationMs: OUTBOX_CLAIM_DURATION_MS }), "Failed to claim outbox batch.");
