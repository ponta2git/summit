import { AsyncLocalStorage } from "node:async_hooks";

// why: fake の集約 write は直列化し、失敗時に全 store を戻す。
// DB の lock / MVCC は模倣せず、実際の競合は integration で検証する。
export const createFakeTransaction = (checkpoint: () => () => void) => {
  const active = new AsyncLocalStorage<boolean>();
  let tail = Promise.resolve();
  return <Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) =>
    (...args: Args): Promise<Result> => {
      if (active.getStore()) { return operation(...args); }
      const run = tail.then(() => active.run(true, async () => {
        const rollback = checkpoint();
        try { return await operation(...args); }
        catch (error) { rollback(); throw error; }
      }));
      tail = run.then(() => undefined, () => undefined);
      return run;
    };
};

export const checkpointMap = <Key, Value>(map: Map<Key, Value>): (() => void) => {
  const snapshot = structuredClone(map);
  return () => {
    map.clear();
    for (const [key, value] of snapshot) { map.set(key, value); }
  };
};
