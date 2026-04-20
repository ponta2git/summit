import { vi } from "vitest";

export interface FixedNowContext {
  now: () => Date;
}

export const useFixedNow = (iso: string): FixedNowContext => {
  const fixed = new Date(iso);
  vi.useFakeTimers();
  vi.setSystemTime(fixed);
  return {
    now: () => new Date(fixed)
  };
};

export const restoreNow = (): void => {
  vi.useRealTimers();
};

export const withFixedNow = async <T>(
  iso: string,
  fn: (context: FixedNowContext) => Promise<T> | T
): Promise<T> => {
  const context = useFixedNow(iso);
  try {
    return await fn(context);
  } finally {
    restoreNow();
  }
};
