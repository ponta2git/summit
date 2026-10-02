import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashJsonbText } from "../../src/db/repositories/notifications.hash.ts";
import { RESULT_NOTIFICATION_MAX_JSONB_BYTES } from "../../src/notifications/config.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("lossless notification hash", () => {
  it.each([
    ['{"a": 100.000, "b": -2.5000, "c": 0.000, "d": 1.01}', '{"a": 100, "b": -2.5, "c": 0, "d": 1.01}'],
    ['[9223372036854775807.000, 0.00000000000000000001, -99.0100]', '[9223372036854775807, 0.00000000000000000001, -99.01]'],
    ['{"1.000": "-2.500", "q": "\\\"1.000\\\"", "n": 2.5000}', '{"1.000": "-2.500", "q": "\\\"1.000\\\"", "n": 2.5}'],
    ['{"slash": "\\\\", "line": "\\n12.00", "n": 4.000}', '{"slash": "\\\\", "line": "\\n12.00", "n": 4}']
  ])("normalizes number scale without changing quoted text or integer precision", (input, expected) => {
    expect(hashJsonbText(input)).toBe(digest(expected));
  });

  it("preserves a near-limit Unicode memo with escaped quotes and number-like text", () => {
    const memo = JSON.stringify("界" + 'x\\"0.000'.repeat(Math.floor((RESULT_NOTIFICATION_MAX_JSONB_BYTES - 8_192) / 10)));
    expect(hashJsonbText(`{"memo": ${memo}, "n": 1.000}`)).toBe(digest(`{"memo": ${memo}, "n": 1}`));
  });
});
