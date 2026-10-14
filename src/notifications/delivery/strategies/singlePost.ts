import type { MessageCreateOptions } from "discord.js";
import * as Effect from "effect/Effect";

import { settledCall } from "../../../runtime/effect.ts";

/** Business confirmation must succeed before the durable delivery is acknowledged. */
export interface SinglePostDefinition<Receipt> {
  readonly strategy: "singlePost";
  readonly nonce: string;
  readonly confirmBusiness: (messageId: string) => Effect.Effect<Receipt, unknown>;
  readonly confirmDelivery: (messageId: string, receipt: Receipt) => Effect.Effect<void, unknown>;
}

export interface SinglePostInput<Receipt> {
  readonly body: MessageCreateOptions;
  readonly channel: { send(body: MessageCreateOptions): PromiseLike<{ readonly id: string }> };
  readonly definition: SinglePostDefinition<Receipt>;
}

/**
 * Check stop before send; after acceptance, confirm business then durable delivery exactly
 * in that order. A replacement must preserve nonce use and ownership through settlement.
 */
export type SinglePostStrategy = <Receipt>(
  input: SinglePostInput<Receipt>,
  execution: { readonly isStopping: () => boolean }
) => Effect.Effect<void, unknown>;

/** Once send starts, retain ownership through business confirmation and durable acknowledgement. */
export const deliverSinglePost: SinglePostStrategy = Effect.fnUntraced(function* <Receipt>(
  { body, channel, definition }: SinglePostInput<Receipt>,
  execution: { readonly isStopping: () => boolean }
): Effect.fn.Return<void, unknown> {
  const sent = yield* settledCall(() => execution.isStopping() ? Promise.resolve(undefined) :
    channel.send({ ...body, nonce: definition.nonce, enforceNonce: true }));
  if (!sent) { return; }
  const receipt = yield* definition.confirmBusiness(sent.id);
  yield* definition.confirmDelivery(sent.id, receipt);
}, Effect.uninterruptible);
