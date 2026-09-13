import { ResultAsync } from "neverthrow";
import type { AppContext } from "../../appContext.ts";
import { AppError, InvariantViolationError } from "../../errors/index.ts";

const queues = new WeakMap<AppContext, Map<string, Promise<void>>>();

/** 同じmessageの再読込とeditを直列化し、別Sessionの更新は待たせない。 */
export const serializeMessageUpdate = <T>(
  context: AppContext,
  key: string,
  update: () => ResultAsync<T, AppError>
): ResultAsync<T, AppError> => {
  let queue = queues.get(context);
  if (!queue) { queue = new Map(); queues.set(context, queue); }
  const ownedQueue = queue;
  // race: readもqueue内で開始する。editだけを並べても古いsnapshotの上書きは防げない。
  const result = ResultAsync.fromPromise(
    (ownedQueue.get(key) ?? Promise.resolve()).then(() => update()),
    cause => cause instanceof AppError ? cause : new InvariantViolationError("Message update crashed.", { cause })
  ).andThen(value => value);
  const settled = result.match(() => undefined, () => undefined);
  ownedQueue.set(key, settled);
  void settled.then(() => {
    if (ownedQueue.get(key) === settled) { ownedQueue.delete(key); }
    return undefined;
  });
  return result;
};
