import type { SessionStatus } from "../../src/db/ports.js";

export type FakeClock = { readonly now: () => Date };
export const DEFAULT_CLOCK: FakeClock = { now: () => new Date("2026-04-24T12:00:00.000Z") };

export const MESSAGE_RECOVERY_STATUSES: readonly SessionStatus[] = [
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
  target.push({ name, args: structuredClone(args) });
};
