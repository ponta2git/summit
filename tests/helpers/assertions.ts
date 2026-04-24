import { expect } from "vitest";

type ParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: unknown };

type MockLike = {
  readonly mock: {
    readonly calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

export const expectParseSuccess = <T>(result: ParseResult<T>): T => {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error("Expected parse to succeed.");
  }
  return result.data;
};

export const expectParseFailure = (result: ParseResult<unknown>, label?: string): void => {
  expect(result.success, label).toBe(false);
};

export const expectKind = <
  T extends { readonly kind: string },
  K extends T["kind"]
>(
  value: T,
  kind: K
): Extract<T, { readonly kind: K }> => {
  expect(value.kind).toBe(kind);
  if (value.kind !== kind) {
    throw new Error(`Expected kind ${kind}, got ${value.kind}.`);
  }
  return value as Extract<T, { readonly kind: K }>;
};

export const callArg = <T>(mock: MockLike, callIndex = 0, argIndex = 0): T => {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call #${callIndex + 1} to exist.`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected mock call #${callIndex + 1} arg #${argIndex + 1} to exist.`);
  }
  return call[argIndex] as T;
};

export const callArgs = <T extends readonly unknown[]>(
  mock: MockLike,
  callIndex = 0
): T => {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call #${callIndex + 1} to exist.`);
  }
  return call as unknown as T;
};
