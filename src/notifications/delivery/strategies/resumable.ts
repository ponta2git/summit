import * as Effect from "effect/Effect";

interface ResumableDelivery<Part, E> {
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

/** Resume missing parts in order and hand off ownership only after a completed part. */
export const deliverResumable = <Part, E>(delivery: ResumableDelivery<Part, E>): Effect.Effect<void, E> =>
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
