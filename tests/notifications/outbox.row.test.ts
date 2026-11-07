import { describe, expect, it } from "vitest";
import { parseOutboxRow, type AttendanceNotificationRow } from "../../src/db/repositories/outbox.types.ts";
import { makeOutboxEntry } from "../testing/fixtures.ts";

const storedRow = (): AttendanceNotificationRow => ({ ...makeOutboxEntry(), weekKey: null });

describe("attendance delivery row boundary", () => {
  it.each([
    { sessionId: "session-1", weekKey: null, expected: { sessionId: "session-1" } },
    { sessionId: null, weekKey: "2026-W17", expected: { sessionId: null, weekKey: "2026-W17" } }
  ])("preserves the $sessionId / $weekKey owner and delivery state", ({ expected, ...owner }) => {
    expect(parseOutboxRow({ ...storedRow(), ...owner })).toStrictEqual({ ...makeOutboxEntry(), ...expected });
  });

  it.each([
    { sessionId: null, weekKey: null },
    { sessionId: "session-1", weekKey: "2026-W17" },
    { kind: "unknown" },
    { status: "unknown" },
    { payload: { kind: "send_message" } }
  ])("rejects invalid persisted metadata %# without throwing", invalid => {
    expect(parseOutboxRow({ ...storedRow(), ...invalid })).toBeUndefined();
  });

  it("propagates unexpected decoder defects instead of labelling them invalid persisted data", () => {
    const defect = new TypeError("broken row adapter");
    const row = { ...storedRow(), get lastError(): string | null { throw defect; } };
    expect(() => parseOutboxRow(row)).toThrow(defect);
  });
});
