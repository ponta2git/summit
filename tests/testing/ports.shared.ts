import type { SessionStatus } from "../../src/db/ports.js";

export type FakeClock = { readonly now: () => Date };
export const DEFAULT_CLOCK: FakeClock = { now: () => new Date() };

export const NON_TERMINAL_STATUSES: readonly SessionStatus[] = [
  "ASKING",
  "POSTPONE_VOTING",
  "POSTPONED",
  "DECIDED",
  "CANCELLED"
];

export type AnyCall = { readonly name: string; readonly args: unknown };

export const recordCall = (
  target: AnyCall[],
  name: string,
  args: unknown
): void => {
  target.push({ name, args });
};
