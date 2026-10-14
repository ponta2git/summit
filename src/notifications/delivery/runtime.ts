/** External event boundary; stop prevents new work, drain waits for owned operations. */
export interface DeliveryRuntime {
  wake(reason: string): void;
  stop(): void;
  drain(): Promise<void>;
}
