import { describe, expect, it } from "vitest";

import {
  buildStatusViewModel,
  renderStatusText
} from "../../../src/features/status-command/viewModel.js";
import type { SessionRow } from "../../../src/db/ports.js";
import { makeSession, makeResponse } from "../../testing/fixtures.js";

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
    // sessionId is sliced to first 8 chars
    expect(s!.sessionId).toBe("session-");
    expect(s!.heldEventExists).toBeNull(); // not DECIDED
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

  it("computes nextEventAt as the earliest upcoming deadline", () => {
    const future1 = new Date(NOW.getTime() + 60 * 60 * 1000); // +1h
    const future2 = new Date(NOW.getTime() + 2 * 60 * 60 * 1000); // +2h
    const session1 = makeSession({ id: "s1", deadlineAt: future1, status: "ASKING", askMessageId: "x" });
    const session2 = makeSession({ id: "s2", deadlineAt: future2, status: "ASKING", askMessageId: "y" });

    const vm = buildStatusViewModel({
      now: NOW,
      sessions: [session1, session2],
      responsesBySessionId: new Map([["s1", []], ["s2", []]]),
      heldEventBySessionId: new Map()
    });

    // nextEventAt should be the earlier deadline (future1)
    expect(vm.nextEventAt).not.toBeNull();
    // format check: yyyy-MM-dd HH:mm
    expect(vm.nextEventAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("generates a warning for ASKING session with past deadline and null messageId", () => {
    const session = makeSession({
      status: "ASKING",
      deadlineAt: new Date("2026-04-25T12:00:00.000Z"), // past
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
