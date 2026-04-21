import { describe, expect, it } from "vitest";

import { subMs } from "../../src/time/index.js";

describe("subMs", () => {
  it("subtracts milliseconds without mutating the input Date", () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    const before = subMs(now, 5 * 60 * 1000);
    expect(before.toISOString()).toBe("2026-04-24T13:55:00.000Z");
    // invariant: 入力 Date を破壊しない
    expect(now.toISOString()).toBe("2026-04-24T14:00:00.000Z");
  });

  it("supports zero and negative offsets (returns a new Date)", () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    expect(subMs(now, 0).getTime()).toBe(now.getTime());
    expect(subMs(now, -1000).toISOString()).toBe("2026-04-24T14:00:01.000Z");
  });
});
