import { CapacityError } from "../verify/notificationCapacity.contract.ts";

type InterruptSignal = "SIGINT" | "SIGTERM";
interface SignalSource {
  on(signal: InterruptSignal, listener: () => void): unknown;
  off(signal: InterruptSignal, listener: () => void): unknown;
}

/** Await the owned work's finally blocks rather than racing cancellation with
 * them. The first interrupt wins; later signals cannot start cleanup twice. */
export const withPerformanceCancellation = async <T>(
  run: (signal: AbortSignal) => Promise<T>, signals: SignalSource = process
): Promise<T> => {
  const controller = new AbortController();
  const interrupt = (name: InterruptSignal) => (): void => {
    if (!controller.signal.aborted) {
      controller.abort(new CapacityError("setup_or_measurement", name === "SIGINT" ? "interrupted_sigint" : "interrupted_sigterm"));
    }
  };
  const onInterrupt = interrupt("SIGINT");
  const onTerminate = interrupt("SIGTERM");
  signals.on("SIGINT", onInterrupt); signals.on("SIGTERM", onTerminate);
  try {
    const value = await run(controller.signal);
    controller.signal.throwIfAborted();
    return value;
  } finally {
    signals.off("SIGINT", onInterrupt); signals.off("SIGTERM", onTerminate);
  }
};
