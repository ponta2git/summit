import * as Effect from "effect/Effect";
import { InvariantViolationError } from "../../errors/index.ts";
import type { DeliveryExecution } from "./capacity.ts";

/**
 * One claimed delivery owned by a runtime. Creating a task starts no asynchronous I/O.
 * Factories preserve the claimed identity and accounted payload bytes. run settles
 * only after its delivery and heartbeat cleanup; capacity is released by
 * the runtime, never by the task. SDK requests may outlive a bounded send wait.
 */
export interface DeliveryTask<E = unknown> {
  readonly id: string;
  readonly payloadBytes: number;
  readonly run: (execution: DeliveryExecution) => Effect.Effect<void, E>;
}

/** A bad factory is an isolated defect owned and settled like any other claimed item. */
export const prepareDeliveryTask = <E>(
  identity: Pick<DeliveryTask, "id" | "payloadBytes">,
  prepare: () => DeliveryTask<E>
): DeliveryTask<E> => {
  const { id, payloadBytes } = identity;
  try {
    const task = prepare();
    if (task.id !== id || task.payloadBytes !== payloadBytes) {
      throw new InvariantViolationError("Delivery task changed its claimed identity or payload budget.");
    }
    return task;
  } catch (error: unknown) {
    return { id, payloadBytes, run: () => Effect.die(error) };
  }
};
