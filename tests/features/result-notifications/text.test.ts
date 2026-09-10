import { describe, expect, it } from "vitest";
import { splitNotificationText } from "../../../src/features/result-notifications/text.ts";

describe("notification text boundaries", () => {
  it.each([
    ["", []],
    ["a".repeat(1_900), ["a".repeat(1_900)]],
    ["head\n" + "a".repeat(3_801), ["head\n", "a".repeat(1_900), "a".repeat(1_900), "a"]],
    ["a".repeat(1_899) + "\nnext", ["a".repeat(1_899) + "\n", "next"]],
    ["a".repeat(1_900) + "\nnext", ["a".repeat(1_900), "\nnext"]],
    ["a".repeat(1_899) + "😀next", ["a".repeat(1_899), "😀next"]],
    ["a".repeat(1_899) + "\\*next", ["a".repeat(1_899), "\\*next"]],
    ["a".repeat(1_898) + "\\\\next", ["a".repeat(1_898) + "\\\\", "next"]]
  ] as const)("keeps version 1 chunks stable (case %#)", (text, expected) => {
    expect(splitNotificationText(text)).toStrictEqual(expected);
  });
});
