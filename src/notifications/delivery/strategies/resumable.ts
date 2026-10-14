import * as Effect from "effect/Effect";

/** Stable ordered parts and sorted, unique delivered numbers from the persisted plan. */
export interface ResumableDelivery<Part, E> {
  readonly parts: () => Iterable<Part>;
  readonly partCount: number;
  readonly deliveredPartNos: readonly number[];
  readonly shouldStop: () => boolean;
  readonly begin: (partNo: number) => Effect.Effect<boolean, E>;
  readonly send: (partNo: number, part: Part) => Effect.Effect<string, E>;
  readonly complete: (partNo: number, messageId: string) => Effect.Effect<boolean, E>;
  readonly consumeYieldRequest: () => boolean;
  readonly yield: (partNo: number) => Effect.Effect<boolean, E>;
}

/**
 * Skip persisted parts, stop before a new send, and attempt complete for each accepted
 * message even after stop. begin/complete false ends ownership; yield only after complete.
 * Preserve typed failures and defects. I/O adapters own actual settlement and send timeouts.
 */
export interface ResumableStrategy {
  <Part, E>(delivery: ResumableDelivery<Part, E>): Effect.Effect<void, E>;
}

/** Resume missing parts in order and hand off ownership only after a completed part. */
export const deliverResumable: ResumableStrategy = <Part, E>(delivery: ResumableDelivery<Part, E>): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    let nextPartNo = 0;
    let deliveredIndex = 0;
    for (const part of delivery.parts()) {
      const partNo = nextPartNo++;
      if (delivery.deliveredPartNos[deliveredIndex] === partNo) { deliveredIndex += 1; continue; }
      if (delivery.shouldStop()) { return; }
      if (!(yield* delivery.begin(partNo))) { return; }
      if (delivery.shouldStop()) { return; }
      const messageId = yield* delivery.send(partNo, part);
      // invariant: 送信開始後の停止・lease lostでも、既知のmessage IDの確定を必ず試みる。
      if (!(yield* delivery.complete(partNo, messageId))) { return; }
      if (nextPartNo < delivery.partCount && !delivery.shouldStop() && delivery.consumeYieldRequest()
        && (yield* delivery.yield(partNo))) { return; }
    }
  });
