import * as Effect from "effect/Effect";
import type { AppContext } from "../../appContext.ts";
import type { AppError } from "../../errors/index.ts";

interface MessageLock {
  readonly semaphore: Effect.Semaphore;
  users: number;
}

const queues = new WeakMap<AppContext, Map<string, MessageLock>>();

/** 同じmessageの再読込とeditを直列化し、別Sessionの更新は待たせない。 */
export const serializeMessageUpdate = <T>(
  context: AppContext,
  key: string,
  update: () => Effect.Effect<T, AppError>
): Effect.Effect<T, AppError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      let queue = queues.get(context);
      if (!queue) { queue = new Map(); queues.set(context, queue); }
      let lock = queue.get(key);
      if (!lock) {
        lock = { semaphore: Effect.unsafeMakeSemaphore(1), users: 0 };
        queue.set(key, lock);
      }
      lock.users += 1;
      return { queue, lock };
    }),
    // race: readも排他区間で開始する。待機中の中断でも登録はfinalizerで解放する。
    ({ lock }) => lock.semaphore.withPermits(1)(Effect.suspend(update)),
    ({ queue, lock }) => Effect.sync(() => {
      lock.users -= 1;
      if (lock.users === 0) { queue.delete(key); }
      if (queue.size === 0) { queues.delete(context); }
    })
  );
