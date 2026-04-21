import type { Client, Message, MessagePayload, TextChannel } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../src/db/rows.js";
import { REMINDER_CLAIM_STALENESS_MS } from "../../src/config.js";
import {
  DISCORD_UNKNOWN_MESSAGE_CODE,
  isUnknownMessageError,
  probeDeletedMessagesAtStartup,
  reconcileMissingAsk,
  reconcileMissingAskMessage,
  reconcileStaleReminderClaims,
  reconcileStrandedCancelled,
  runReconciler
} from "../../src/scheduler/reconciler.js";
import { updateAskMessage } from "../../src/features/ask-session/messageEditor.js";
import { __resetSendStateForTest } from "../../src/features/ask-session/send.js";
import { createTestAppContext } from "../testing/index.js";
import { buildSessionRow } from "./factories/session.js";

// why: reconciler は Discord side-effect を伴うため getTextChannel を fake 実装で差し替える。
//   AppContext / ports 側は createTestAppContext の fake を使い、ADR-0018 準拠で vi.mock を
//   repository modules には追加しない。
const sentMessages: Array<{ channelId: string; payload: unknown }> = [];
const fetchedMessageIds: string[] = [];
const editCalls: Array<{ messageId: string; payload: unknown }> = [];
let nextSentMessageId = 1;
let fetchImpl: (messageId: string) => Promise<Message> = async (messageId) => {
  throw Object.assign(new Error(`default stub did not provide fetch for ${messageId}`), {
    code: 500
  });
};
let sendImpl: (payload: unknown) => Promise<Message> = async (payload) => {
  const id = `sent-${String(nextSentMessageId++)}`;
  sentMessages.push({ channelId: "fake-channel", payload });
  return { id } as unknown as Message;
};

vi.mock("../../src/discord/shared/channels.js", () => ({
  getTextChannel: vi.fn(async (_client: Client, channelId: string) => {
    const channel = {
      id: channelId,
      send: vi.fn(async (payload: string | MessagePayload) => {
        const msg = await sendImpl(payload);
        return msg;
      }),
      messages: {
        fetch: vi.fn(async (id: string) => {
          fetchedMessageIds.push(id);
          return fetchImpl(id);
        })
      }
    };
    return channel as unknown as TextChannel;
  })
}));

const makeMessage = (id: string): Message => {
  const edit = vi.fn(async (payload: unknown) => {
    editCalls.push({ messageId: id, payload });
    return {} as Message;
  });
  return { id, edit } as unknown as Message;
};

const client = {} as unknown as Client;

const makeSendableClient = (): Client => {
  // why: sendAskMessage は getTextChannel を経由せず client.channels.fetch を直接呼ぶため、
  //   getTextChannel mock だけでは不足する。reconcileMissingAsk 経路の検証用に個別 fake を用意する。
  const channel = {
    type: 0,
    isSendable: () => true,
    send: async (payload: unknown) => {
      const id = `sent-${String(nextSentMessageId++)}`;
      sentMessages.push({ channelId: "fake-channel", payload });
      return { id } as unknown as Message;
    }
  };
  return {
    channels: {
      fetch: async () => channel
    }
  } as unknown as Client;
};

beforeEach(() => {
  sentMessages.length = 0;
  fetchedMessageIds.length = 0;
  editCalls.length = 0;
  nextSentMessageId = 1;
  fetchImpl = async (messageId) => {
    throw Object.assign(new Error(`no fetch stub for ${messageId}`), { code: 500 });
  };
  sendImpl = async (payload) => {
    const id = `sent-${String(nextSentMessageId++)}`;
    sentMessages.push({ channelId: "fake-channel", payload });
    return { id } as unknown as Message;
  };
  __resetSendStateForTest();
});

describe("isUnknownMessageError", () => {
  it("matches Discord code 10008", () => {
    expect(isUnknownMessageError({ code: DISCORD_UNKNOWN_MESSAGE_CODE })).toBe(true);
    expect(isUnknownMessageError({ code: 10008 })).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isUnknownMessageError(new Error("boom"))).toBe(false);
    expect(isUnknownMessageError({ code: 50001 })).toBe(false);
    expect(isUnknownMessageError(null)).toBe(false);
    expect(isUnknownMessageError(undefined)).toBe(false);
  });
});

describe("reconcileStrandedCancelled", () => {
  it("promotes a Friday CANCELLED before the postpone deadline to POSTPONE_VOTING", async () => {
    // jst: 金曜 21:45 JST = 2026-04-24T12:45:00Z。候補日 2026-04-24 の順延期限は 04-25T00:00 JST。
    const session: SessionRow = buildSessionRow({
      id: "c-friday",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED",
      askMessageId: "ask-1",
      cancelReason: "deadline_unanswered"
    });
    const now = new Date("2026-04-24T12:45:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    const promoted = await reconcileStrandedCancelled(client, ctx);

    expect(promoted).toBe(1);
    const after = await ctx.ports.sessions.findSessionById("c-friday");
    expect(after?.status).toBe("POSTPONE_VOTING");
    expect(after?.postponeMessageId).toBeTruthy();
  });

  it("promotes a Friday CANCELLED past the postpone deadline to COMPLETED", async () => {
    // jst: 土曜 02:00 JST = 2026-04-25T17:00:00Z (UTC).
    const session: SessionRow = buildSessionRow({
      id: "c-late",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED"
    });
    const now = new Date("2026-04-25T17:00:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    const promoted = await reconcileStrandedCancelled(client, ctx);

    expect(promoted).toBe(1);
    const after = await ctx.ports.sessions.findSessionById("c-late");
    expect(after?.status).toBe("COMPLETED");
  });

  it("promotes a Saturday CANCELLED to COMPLETED regardless of time", async () => {
    const session: SessionRow = buildSessionRow({
      id: "c-sat",
      weekKey: "2026-W17",
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "CANCELLED",
      cancelReason: "saturday_cancelled"
    });
    const now = new Date("2026-04-25T12:30:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    const promoted = await reconcileStrandedCancelled(client, ctx);

    expect(promoted).toBe(1);
    const after = await ctx.ports.sessions.findSessionById("c-sat");
    expect(after?.status).toBe("COMPLETED");
  });

  it("does nothing when no CANCELLED sessions exist", async () => {
    const session: SessionRow = buildSessionRow({ id: "a1", status: "ASKING" });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    const promoted = await reconcileStrandedCancelled(client, ctx);

    expect(promoted).toBe(0);
  });
});

describe("reconcileMissingAsk", () => {
  it("creates a Friday ASKING session when none exists after 08:00 JST", async () => {
    // jst: 2026-04-24 (Fri) 10:00 JST = 2026-04-24T01:00:00Z
    const now = new Date("2026-04-24T01:00:00.000Z");
    const ctx = createTestAppContext({ now });
    const sendableClient = makeSendableClient();

    const created = await reconcileMissingAsk(sendableClient, ctx);

    expect(created).toBe(1);
    const sessions = ctx.ports.sessions.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("ASKING");
    expect(sessions[0]?.postponeCount).toBe(0);
  });

  it("does nothing on Friday before 08:00 JST", async () => {
    // jst: 2026-04-24 (Fri) 07:30 JST = 2026-04-23T22:30:00Z
    const now = new Date("2026-04-23T22:30:00.000Z");
    const ctx = createTestAppContext({ now });

    const created = await reconcileMissingAsk(client, ctx);

    expect(created).toBe(0);
    expect(ctx.ports.sessions.listSessions()).toHaveLength(0);
  });

  it("does nothing on non-Friday days", async () => {
    // jst: 2026-04-23 (Thu) 12:00 JST = 2026-04-23T03:00:00Z
    const now = new Date("2026-04-23T03:00:00.000Z");
    const ctx = createTestAppContext({ now });

    const created = await reconcileMissingAsk(client, ctx);

    expect(created).toBe(0);
  });

  it("does not duplicate when a Friday session already exists", async () => {
    const existing: SessionRow = buildSessionRow({
      id: "existing",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "ASKING",
      askMessageId: "m-1"
    });
    const now = new Date("2026-04-24T01:00:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [existing] } });

    const created = await reconcileMissingAsk(client, ctx);

    expect(created).toBe(0);
    expect(ctx.ports.sessions.listSessions()).toHaveLength(1);
  });
});

describe("reconcileMissingAskMessage", () => {
  it("re-sends for ASKING session with null askMessageId and persists new id", async () => {
    const session: SessionRow = buildSessionRow({
      id: "a-null",
      status: "ASKING",
      askMessageId: null
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    const resent = await reconcileMissingAskMessage(client, ctx);

    expect(resent).toBe(1);
    const after = await ctx.ports.sessions.findSessionById("a-null");
    expect(after?.askMessageId).toBe("sent-1");
    expect(sentMessages).toHaveLength(1);
  });

  it("re-sends for POSTPONE_VOTING session with null askMessageId", async () => {
    const session: SessionRow = buildSessionRow({
      id: "pv-null",
      status: "POSTPONE_VOTING",
      askMessageId: null,
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    const resent = await reconcileMissingAskMessage(client, ctx);

    expect(resent).toBe(1);
    const after = await ctx.ports.sessions.findSessionById("pv-null");
    expect(after?.askMessageId).toBe("sent-1");
  });

  it("skips sessions that already have askMessageId", async () => {
    const session: SessionRow = buildSessionRow({
      id: "a-ok",
      status: "ASKING",
      askMessageId: "existing-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    const resent = await reconcileMissingAskMessage(client, ctx);

    expect(resent).toBe(0);
    expect(sentMessages).toHaveLength(0);
  });
});

describe("reconcileStaleReminderClaims", () => {
  it("reverts claims older than the staleness window", async () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    const staleAt = new Date(now.getTime() - REMINDER_CLAIM_STALENESS_MS - 1000);
    const session: SessionRow = buildSessionRow({
      id: "stale",
      status: "DECIDED",
      reminderAt: new Date(now.getTime() - 60_000),
      reminderSentAt: staleAt
    });
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    const reclaimed = await reconcileStaleReminderClaims(ctx);

    expect(reclaimed).toBe(1);
    const after = await ctx.ports.sessions.findSessionById("stale");
    expect(after?.reminderSentAt).toBeNull();
  });

  it("does not revert fresh claims", async () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    const freshAt = new Date(now.getTime() - 30_000);
    const session: SessionRow = buildSessionRow({
      id: "fresh",
      status: "DECIDED",
      reminderAt: new Date(now.getTime() - 60_000),
      reminderSentAt: freshAt
    });
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });

    const reclaimed = await reconcileStaleReminderClaims(ctx);

    expect(reclaimed).toBe(0);
    const after = await ctx.ports.sessions.findSessionById("fresh");
    expect(after?.reminderSentAt).toEqual(freshAt);
  });
});

describe("runReconciler tick scope", () => {
  it("only touches stale reminder claims in tick scope", async () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    const staleAt = new Date(now.getTime() - REMINDER_CLAIM_STALENESS_MS - 1000);
    const cancelled: SessionRow = buildSessionRow({
      id: "c-sat",
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "CANCELLED"
    });
    const reminderSession: SessionRow = buildSessionRow({
      id: "stale",
      status: "DECIDED",
      reminderAt: new Date(now.getTime() - 60_000),
      reminderSentAt: staleAt
    });
    const ctx = createTestAppContext({
      now,
      seed: { sessions: [cancelled, reminderSession] }
    });

    const report = await runReconciler(client, ctx, { scope: "tick" });

    expect(report.staleClaimReclaimed).toBe(1);
    expect(report.cancelledPromoted).toBe(0);
    expect(report.askCreated).toBe(0);
    expect(report.messageResent).toBe(0);
    const cancelledAfter = await ctx.ports.sessions.findSessionById("c-sat");
    expect(cancelledAfter?.status).toBe("CANCELLED");
  });
});

describe("updateAskMessage 10008 recovery", () => {
  it("recreates the ask message when Discord returns Unknown Message (10008)", async () => {
    const session: SessionRow = buildSessionRow({
      id: "s-10008",
      status: "ASKING",
      askMessageId: "old-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    fetchImpl = async () => {
      throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    };

    await updateAskMessage(client, ctx, session);

    const after = await ctx.ports.sessions.findSessionById("s-10008");
    expect(after?.askMessageId).toBe("sent-1");
    expect(sentMessages).toHaveLength(1);
    expect(editCalls).toHaveLength(0);
  });

  it("falls through to warn log for non-10008 errors without recreating", async () => {
    const session: SessionRow = buildSessionRow({
      id: "s-other",
      status: "ASKING",
      askMessageId: "old-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    fetchImpl = async () => {
      throw Object.assign(new Error("Missing Access"), { code: 50001 });
    };

    await updateAskMessage(client, ctx, session);

    const after = await ctx.ports.sessions.findSessionById("s-other");
    expect(after?.askMessageId).toBe("old-id");
    expect(sentMessages).toHaveLength(0);
  });

  it("edits the existing message on the happy path without recreating", async () => {
    const session: SessionRow = buildSessionRow({
      id: "s-ok",
      status: "ASKING",
      askMessageId: "keep-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    fetchImpl = async (id) => makeMessage(id);

    await updateAskMessage(client, ctx, session);

    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.messageId).toBe("keep-id");
    expect(sentMessages).toHaveLength(0);
    const after = await ctx.ports.sessions.findSessionById("s-ok");
    expect(after?.askMessageId).toBe("keep-id");
  });
});

const extractContent = (payload: unknown): string | undefined => {
  if (payload && typeof payload === "object" && "content" in payload) {
    const content = (payload as { content?: unknown }).content;
    return typeof content === "string" ? content : undefined;
  }
  return undefined;
};

describe("promoteStranded cancelled UI cleanup", () => {
  it("Friday before postpone deadline: disables ASK buttons and sends settle notice before postpone vote message", async () => {
    // jst: 金曜 21:45 JST = 2026-04-24T12:45:00Z。順延期限前。
    const session: SessionRow = buildSessionRow({
      id: "c-fri-ui",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED",
      askMessageId: "ask-fri",
      cancelReason: "deadline_unanswered"
    });
    const now = new Date("2026-04-24T12:45:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });
    // state: updateAskMessage は ask-fri を fetch → edit で disabled 再描画する happy path を模擬。
    fetchImpl = async (id) => makeMessage(id);

    const promoted = await reconcileStrandedCancelled(client, ctx);

    expect(promoted).toBe(1);
    // invariant: 通常経路 settleAskingSession と同じく、ASK メッセージを先に無効化する。
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.messageId).toBe("ask-fri");
    // invariant: settle 通知を送ってから順延投票メッセージを送る。
    expect(sentMessages.length).toBeGreaterThanOrEqual(2);
    const settleContent = extractContent(sentMessages[0]?.payload);
    expect(settleContent).toContain("21:30 までに未回答者");
    const after = await ctx.ports.sessions.findSessionById("c-fri-ui");
    expect(after?.status).toBe("POSTPONE_VOTING");
    expect(after?.postponeMessageId).toBeTruthy();
  });

  it("Saturday path: disables ASK buttons and sends settle notice before COMPLETED", async () => {
    const session: SessionRow = buildSessionRow({
      id: "c-sat-ui",
      weekKey: "2026-W17",
      postponeCount: 1,
      candidateDateIso: "2026-04-25",
      status: "CANCELLED",
      askMessageId: "ask-sat",
      cancelReason: "saturday_cancelled"
    });
    const now = new Date("2026-04-25T12:30:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });
    fetchImpl = async (id) => makeMessage(id);

    const promoted = await reconcileStrandedCancelled(client, ctx);

    expect(promoted).toBe(1);
    expect(editCalls).toHaveLength(1);
    expect(editCalls[0]?.messageId).toBe("ask-sat");
    expect(sentMessages).toHaveLength(1);
    const settleContent = extractContent(sentMessages[0]?.payload);
    expect(settleContent).toContain("土曜回も成立しなかった");
    const after = await ctx.ports.sessions.findSessionById("c-sat-ui");
    expect(after?.status).toBe("COMPLETED");
  });

  it("Friday past postpone deadline: sends settle notice before COMPLETED", async () => {
    const session: SessionRow = buildSessionRow({
      id: "c-late-ui",
      weekKey: "2026-W17",
      postponeCount: 0,
      candidateDateIso: "2026-04-24",
      status: "CANCELLED",
      askMessageId: "ask-late",
      cancelReason: "absent"
    });
    // jst: 土曜 02:00 JST = 順延期限 (土 00:00 JST) 後。
    const now = new Date("2026-04-25T17:00:00.000Z");
    const ctx = createTestAppContext({ now, seed: { sessions: [session] } });
    fetchImpl = async (id) => makeMessage(id);

    const promoted = await reconcileStrandedCancelled(client, ctx);

    expect(promoted).toBe(1);
    expect(sentMessages).toHaveLength(1);
    const settleContent = extractContent(sentMessages[0]?.payload);
    expect(settleContent).toContain("欠席が出たため");
    const after = await ctx.ports.sessions.findSessionById("c-late-ui");
    expect(after?.status).toBe("COMPLETED");
  });
});

describe("probeDeletedMessagesAtStartup", () => {
  it("recreates an ASKING ask message when fetch throws Unknown Message (10008)", async () => {
    const session: SessionRow = buildSessionRow({
      id: "probe-ask-gone",
      status: "ASKING",
      askMessageId: "gone-ask-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    fetchImpl = async () => {
      throw Object.assign(new Error("Unknown Message"), { code: 10008 });
    };

    const recreated = await probeDeletedMessagesAtStartup(client, ctx);

    expect(recreated).toBe(1);
    expect(fetchedMessageIds).toContain("gone-ask-id");
    expect(sentMessages).toHaveLength(1);
    const after = await ctx.ports.sessions.findSessionById("probe-ask-gone");
    expect(after?.askMessageId).toBe("sent-1");
  });

  it("recreates a POSTPONE_VOTING postpone message on 10008 and updates postponeMessageId", async () => {
    const session: SessionRow = buildSessionRow({
      id: "probe-postpone-gone",
      status: "POSTPONE_VOTING",
      askMessageId: "ask-ok",
      postponeMessageId: "gone-postpone-id",
      deadlineAt: new Date("2026-04-25T15:00:00.000Z")
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    fetchImpl = async (id) => {
      if (id === "gone-postpone-id") {
        throw Object.assign(new Error("Unknown Message"), { code: 10008 });
      }
      return makeMessage(id);
    };

    const recreated = await probeDeletedMessagesAtStartup(client, ctx);

    expect(recreated).toBe(1);
    expect(fetchedMessageIds).toEqual(
      expect.arrayContaining(["ask-ok", "gone-postpone-id"])
    );
    const after = await ctx.ports.sessions.findSessionById("probe-postpone-gone");
    expect(after?.postponeMessageId).toBe("sent-1");
    // invariant: ASK 側は fetch 成功したため ID は差し替わらない。
    expect(after?.askMessageId).toBe("ask-ok");
  });

  it("is a no-op when fetched messages exist", async () => {
    const session: SessionRow = buildSessionRow({
      id: "probe-fresh",
      status: "ASKING",
      askMessageId: "fresh-ask-id"
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });
    fetchImpl = async (id) => makeMessage(id);

    const recreated = await probeDeletedMessagesAtStartup(client, ctx);

    expect(recreated).toBe(0);
    expect(sentMessages).toHaveLength(0);
    const after = await ctx.ports.sessions.findSessionById("probe-fresh");
    expect(after?.askMessageId).toBe("fresh-ask-id");
  });

  it("skips sessions with null askMessageId (no probe)", async () => {
    const session: SessionRow = buildSessionRow({
      id: "probe-null",
      status: "ASKING",
      askMessageId: null
    });
    const ctx = createTestAppContext({ seed: { sessions: [session] } });

    const recreated = await probeDeletedMessagesAtStartup(client, ctx);

    expect(recreated).toBe(0);
    expect(fetchedMessageIds).toHaveLength(0);
  });
});
