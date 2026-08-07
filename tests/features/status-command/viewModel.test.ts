import { describe, expect, it } from "vitest";

import {
  buildStatusViewModel,
  renderStatusText
} from "../../../src/features/status-command/viewModel.js";
import type { SessionRow } from "../../../src/db/ports.js";
import { makeOutboxEntry, makeSession, makeResponse } from "../../testing/fixtures.js";

const NOW = new Date("2026-04-25T12:30:00.000Z"); // 21:30 JST (Asia/Tokyo)

describe("buildStatusViewModel", () => {
  it("regression: returns valid view model even with 0 non-terminal sessions", () => {
    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [],
      responsesBySessionId: new Map(),
      heldEventBySessionId: new Map()
    });

    expect(vm.sessions).toHaveLength(0);
    expect(vm.totalWarnings).toBe(0);
    expect(vm.currentWeekKey).toMatch(/^\d{4}-W\d{2}$/);
    expect(vm.nextEventAt).toBeNull();
  });

  it("includes session details for an ASKING session", () => {
    const session = makeSession({
      id: "session-abc123",
      status: "ASKING",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-25",
      deadlineAt: new Date("2026-04-25T12:30:00.000Z"),
      askMessageId: "msg-1"
    });
    const response = makeResponse({ sessionId: session.id });

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session],
      responsesBySessionId: new Map([[session.id, [response]]]),
      heldEventBySessionId: new Map()
    });

    expect(vm.sessions).toHaveLength(1);
    const s = vm.sessions[0];
    expect(s).toBeDefined();
    expect(s!.status).toBe("ASKING");
    expect(s!.weekKey).toBe("2026-W17");
    expect(s!.postponeCount).toBe(0);
    expect(s!.responseCount).toBe(1);
    expect(s!.memberCountExpected).toBe(4);
    expect(s!.sessionId).toBe("session-");
    expect(s!.heldEventExists).toBeNull();
  });

  it("marks DECIDED session heldEventExists as false when no HeldEvent", () => {
    const session = makeSession({ status: "DECIDED" } as Partial<SessionRow>);

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session],
      responsesBySessionId: new Map([[session.id, []]]),
      heldEventBySessionId: new Map()
    });

    expect(vm.sessions[0]!.heldEventExists).toBe(false);
  });

  it("marks DECIDED session heldEventExists as true when HeldEvent present", () => {
    const session = makeSession({ status: "DECIDED" } as Partial<SessionRow>);
    const heldEvent = {
      id: "held-1",
      sessionId: session.id,
      heldDateIso: "2026-04-25",
      startAt: NOW,
      createdAt: NOW
    };

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session],
      responsesBySessionId: new Map([[session.id, []]]),
      heldEventBySessionId: new Map([[session.id, heldEvent]])
    });

    expect(vm.sessions[0]!.heldEventExists).toBe(true);
  });

  it("computes nextEventAt from the earliest unsent reminder or deadline", () => {
    const future1 = new Date(NOW.getTime() + 60 * 60 * 1000);
    const session1 = makeSession({ id: "s1", deadlineAt: future1, status: "ASKING", askMessageId: "x" });
    const session2 = makeSession({
      id: "s2",
      status: "DECIDED",
      deadlineAt: new Date(NOW.getTime() - 1),
      reminderAt: new Date(NOW.getTime() + 30 * 60 * 1000),
      reminderSentAt: null
    });
    const alreadySent = makeSession({
      id: "s3",
      status: "DECIDED",
      deadlineAt: new Date(NOW.getTime() - 1),
      reminderAt: new Date(NOW.getTime() + 10 * 60 * 1000),
      reminderSentAt: NOW
    });

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session1, session2, alreadySent],
      responsesBySessionId: new Map([["s1", []], ["s2", []], ["s3", []]]),
      heldEventBySessionId: new Map()
    });

    // invariant: 未送信 reminder と deadline のうち最も近い JST 時刻を返す。
    expect(vm.nextEventAt).toBe("2026-04-25 22:00");
  });

  it("includes stranded outbox warning in the view model and rendered text", () => {
    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [],
      responsesBySessionId: new Map(),
      heldEventBySessionId: new Map(),
      strandedOutboxEntries: [
        makeOutboxEntry({
          id: "outbox-old",
          dedupeKey: "settle-old",
          createdAt: new Date("2026-04-25T11:00:00.000Z")
        }),
        makeOutboxEntry({
          id: "outbox-new",
          dedupeKey: "settle-new",
          createdAt: new Date("2026-04-25T12:00:00.000Z")
        })
      ]
    });

    expect(vm.strandedOutboxCount).toBe(2);
    expect(vm.strandedOutboxWarning).toStrictEqual({
      kind: "outbox_stranded",
      message:
        '2 outbox row(s) stranded (FAILED or high attempt_count); oldest dedupeKey="settle-old"'
    });
    expect(renderStatusText(vm)).toContain(
      '⚠ 2 outbox row(s) stranded (FAILED or high attempt_count); oldest dedupeKey="settle-old"'
    );
    expect(vm.totalWarnings).toBe(1);
  });

  it("generates a warning for ASKING session with past deadline and null messageId", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T12:00:00.000Z"),
      askMessageId: null
    });

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session],
      responsesBySessionId: new Map([[session.id, []]]),
      heldEventBySessionId: new Map()
    });

    expect(vm.totalWarnings).toBe(2);
  });
});

describe("renderStatusText", () => {
  it("renders 'なし' when no sessions exist", () => {
    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [],
      responsesBySessionId: new Map(),
      heldEventBySessionId: new Map()
    });
    const text = renderStatusText(vm);
    expect(text).toContain("非終端セッション: なし");
    expect(text).toContain("```");
  });

  it("renders session info for ASKING session", () => {
    const session = makeSession({ status: "ASKING", askMessageId: "msg-1" });

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session],
      responsesBySessionId: new Map([[session.id, []]]),
      heldEventBySessionId: new Map()
    });

    const text = renderStatusText(vm);
    expect(text).toContain("[ASKING]");
    expect(text).toContain("回答: 0/4");
  });

  it("includes warning marker in rendered text", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T12:00:00.000Z"),
      askMessageId: null
    });

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session],
      responsesBySessionId: new Map([[session.id, []]]),
      heldEventBySessionId: new Map()
    });

    const text = renderStatusText(vm);
    expect(text).toContain("⚠");
  });
});
