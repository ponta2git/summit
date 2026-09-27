/** Stop every owner even when an earlier synchronous cleanup fails. */
export const stopResources = (operations: readonly (() => void)[]): void => {
  const failures: unknown[] = [];
  for (const operation of operations) {
    try { operation(); }
    catch (error: unknown) { failures.push(error); }
  }
  if (failures.length > 0) { throw failures[0]; }
};

/** Start every drain and retain ownership until all actual operations settle. */
export const drainResources = async (
  operations: readonly (() => void | PromiseLike<void>)[]
): Promise<void> => {
  // invariant: callback の同期 throw も rejected Promise にし、後続 owner の drain を省略しない。
  const results = await Promise.allSettled(operations.map(async operation => operation()));
  const failure = results.find(result => result.status === "rejected");
  if (failure) { throw failure.reason; }
};
