import { describe, expect, it } from "vitest";

import {
  createFakePorts,
  createFakeResponsesPort,
  createFakeSessionsPort,
  makeSession,
  withFixedNow
} from "./index.js";

describe("tests/testing helpers", () => {
  it("records sessions port calls and applies CAS transition", async () => {
    const sessions = createFakeSessionsPort([makeSession({ id: "s1", status: "ASKING" })]);

    const transitioned = await sessions.decideAsking({
      id: "s1",
      now: new Date("2026-04-24T12:30:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });

    expect(transitioned?.status).toBe("DECIDED");
    expect(sessions.calls.map((call) => call.name)).toEqual(["decideAsking"]);
  });

  it("refuses to transition on CAS loss", async () => {
    const sessions = createFakeSessionsPort([makeSession({ id: "s1", status: "DECIDED" })]);
    const result = await sessions.decideAsking({
      id: "s1",
      now: new Date("2026-04-24T12:30:00.000Z"),
      decidedStartAt: new Date("2026-04-24T14:00:00.000Z"),
      reminderAt: new Date("2026-04-24T13:45:00.000Z")
    });
    expect(result).toBeUndefined();
  });

  it("upserts responses by (sessionId, memberId)", async () => {
    const responses = createFakeResponsesPort();
    await responses.upsertResponse({
      id: "r1",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2200",
      answeredAt: new Date("2026-04-24T12:00:00.000Z")
    });
    const updated = await responses.upsertResponse({
      id: "r2",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2330",
      answeredAt: new Date("2026-04-24T12:05:00.000Z")
    });

    expect(updated.id).toBe("r1");
    expect(updated.choice).toBe("T2330");
    expect(responses.listAllResponses()).toHaveLength(1);
  });

  it("composes a fake AppPorts bundle with shared deterministic time", async () => {
    const ports = createFakePorts({
      sessions: [makeSession({ id: "s1", status: "ASKING" })]
    });

    await withFixedNow("2026-04-24T12:31:00.000Z", async () => {
      const due = await ports.sessions.findDueAskingSessions(
        new Date("2026-04-24T12:31:00.000Z")
      );
      expect(due).toHaveLength(1);
    });
  });
});
