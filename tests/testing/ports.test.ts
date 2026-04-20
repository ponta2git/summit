import { describe, expect, it } from "vitest";

import {
  createFakeDiscordPort,
  createFakeResponsesPort,
  createFakeSessionsPort,
  makeSession,
  withFixedNow
} from "./index.js";

describe("tests/testing helpers", () => {
  it("records sessions port calls and applies CAS transition", async () => {
    const sessions = createFakeSessionsPort([
      makeSession({ id: "s1", status: "ASKING" })
    ]);

    const transitioned = await sessions.transitionStatus(
      {},
      { id: "s1", from: "ASKING", to: "DECIDED" }
    );

    expect(transitioned?.status).toBe("DECIDED");
    expect(sessions.calls.map((call) => call.name)).toEqual(["transitionStatus"]);
  });

  it("upserts responses by (sessionId, memberId)", async () => {
    const responses = createFakeResponsesPort();
    await responses.upsertResponse({}, {
      id: "r1",
      sessionId: "s1",
      memberId: "m1",
      choice: "T2200",
      answeredAt: new Date("2026-04-24T12:00:00.000Z")
    });
    const updated = await responses.upsertResponse({}, {
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

  it("supports deterministic time and Discord side-effect assertions", async () => {
    const discord = createFakeDiscordPort({ messageIds: ["m-1"] });

    await withFixedNow("2026-04-24T12:31:00.000Z", async ({ now }) => {
      const sent = await discord.sendMessage({
        channelId: "ch-1",
        payload: { now: now().toISOString() }
      });
      expect(sent).toEqual({ messageId: "m-1" });
    });

    expect(discord.calls.sendMessage).toHaveLength(1);
    expect(discord.calls.sendMessage[0]?.payload).toEqual({
      now: "2026-04-24T12:31:00.000Z"
    });
  });
});
