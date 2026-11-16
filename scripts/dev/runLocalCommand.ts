/** Await cleanup even after failure, retaining both failures for the reporting boundary. */
export const runLocalCommand = async (
  run: () => Promise<void>,
  cleanup: () => Promise<void>,
  reportFailure: (error: unknown) => void
): Promise<void> => {
  const failures: unknown[] = [];
  try { await run(); } catch (error) { failures.push(error); }
  try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length === 0) { return; }
  // invariant: 診断自体の失敗でも終了状態とcleanupの完了を失わない。
  process.exitCode = 1;
  // why: 共通serializerはAggregateError.errorsを出さないため、各失敗の分類を個別に残す。
  for (const failure of failures) {
    try { reportFailure(failure); }
    catch { /* why: 診断の失敗で次の診断を捨てず、新しい未処理rejectも作らない。 */ }
  }
};
