import { describe, expect, it } from "vitest";

import {
  computeReminderAt,
  shouldSkipReminder
} from "../../../src/features/reminder/time.js";

describe("shouldSkipReminder", () => {
  const reminderAt = new Date("2026-04-24T12:45:00.000Z");

  it.each([
    {
      label: "more than ten minutes remain",
      now: new Date("2026-04-24T12:30:00.000Z"),
      expected: false
    },
    {
      label: "exactly ten minutes remain",
      now: new Date("2026-04-24T12:35:00.000Z"),
      expected: false
    },
    {
      label: "less than ten minutes remain",
      now: new Date("2026-04-24T12:36:00.000Z"),
      expected: true
    },
    {
      label: "the reminder time has passed",
      now: new Date("2026-04-24T13:00:00.000Z"),
      expected: true
    }
  ])("returns $expected when $label", ({ now, expected }) => {
    expect(shouldSkipReminder(now, reminderAt)).toBe(expected);
  });
});

describe("computeReminderAt", () => {
  it("returns the start time minus fifteen minutes", () => {
    expect(computeReminderAt(new Date("2026-04-24T13:00:00.000Z"))).toStrictEqual(
      new Date("2026-04-24T12:45:00.000Z")
    );
  });
});
