import { ChannelType, type Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as SessionRepos from "../../src/db/repositories/sessions.js";
import type * as MemberRepos from "../../src/db/repositories/members.js";
import type * as ResponseRepos from "../../src/db/repositories/responses.js";
import type { DbLike, SessionRow } from "../../src/db/types.js";

import { buildSessionRow } from "./factories/session.js";

vi.mock("../../src/db/repositories/sessions.js", async () => {
  const actual = await vi.importActual<typeof SessionRepos>(
    "../../src/db/repositories/sessions.js"
  );
  return {
    ...actual,
    findSessionById: vi.fn(),
    transitionStatus: vi.fn(),
    updatePostponeMessageId: vi.fn()
  };
});

vi.mock("../../src/db/repositories/members.js", async () => {
  const actual = await vi.importActual<typeof MemberRepos>(
    "../../src/db/repositories/members.js"
  );
  return {
    ...actual,
    listMembers: vi.fn(async () => [])
  };
});

vi.mock("../../src/db/repositories/responses.js", async () => {
  const actual = await vi.importActual<typeof ResponseRepos>(
    "../../src/db/repositories/responses.js"
  );
  return {
    ...actual,
    listResponses: vi.fn(async () => [])
  };
});

const repos = await import("../../src/db/repositories/sessions.js");
const { settleAskingSession } = await import("../../src/discord/settle.js");

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-1", askMessageId: "ask-msg-1", ...overrides });

const stubChannel = () => {
  const sentMessages: { id: string }[] = [];
  const messageEdit = vi.fn();
  const channel = {
    type: ChannelType.GuildText,
    isSendable: () => true,
    send: vi.fn(async (_payload: unknown) => {
      const msg = { id: `posted-${sentMessages.length + 1}` };
      sentMessages.push(msg);
      return msg;
    }),
    messages: {
      fetch: vi.fn(async () => ({ edit: messageEdit }))
    }
  };
  return { channel, sentMessages, messageEdit };
};

const stubClient = (channel: unknown): Client =>
  ({
    channels: {
      fetch: vi.fn(async () => channel)
    }
  }) as unknown as Client;

const db = {} as unknown as DbLike;

describe("settleAskingSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("transitions ASKING → CANCELLED → POSTPONE_VOTING and posts both messages", async () => {
    const session = sessionRow();
    const cancelled = sessionRow({ status: "CANCELLED", cancelReason: "absent" });
    vi.mocked(repos.findSessionById).mockResolvedValue(session);
    vi.mocked(repos.transitionStatus)
      .mockResolvedValueOnce(cancelled)
      .mockResolvedValueOnce(sessionRow({ status: "POSTPONE_VOTING" }));

    const { channel, sentMessages } = stubChannel();
    await settleAskingSession(stubClient(channel), db, session.id, "absent");

    expect(repos.transitionStatus).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = vi.mocked(repos.transitionStatus).mock.calls;
    expect(firstCall?.[1]).toMatchObject({
      from: "ASKING",
      to: "CANCELLED",
      cancelReason: "absent"
    });
    expect(secondCall?.[1]).toMatchObject({
      from: "CANCELLED",
      to: "POSTPONE_VOTING"
    });
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(sentMessages).toHaveLength(2);
    expect(repos.updatePostponeMessageId).toHaveBeenCalledWith(db, session.id, "posted-2");
  });

  it("is idempotent when another path has already cancelled (race)", async () => {
    const session = sessionRow();
    vi.mocked(repos.findSessionById).mockResolvedValue(session);
    vi.mocked(repos.transitionStatus).mockResolvedValueOnce(undefined);

    const { channel } = stubChannel();
    await settleAskingSession(stubClient(channel), db, session.id, "deadline_unanswered");

    expect(repos.transitionStatus).toHaveBeenCalledTimes(1);
    expect(channel.send).not.toHaveBeenCalled();
    expect(repos.updatePostponeMessageId).not.toHaveBeenCalled();
  });

  it("skips when session status is already non-ASKING", async () => {
    vi.mocked(repos.findSessionById).mockResolvedValue(
      sessionRow({ status: "CANCELLED", cancelReason: "absent" })
    );

    const { channel } = stubChannel();
    await settleAskingSession(stubClient(channel), db, "session-1", "absent");

    expect(repos.transitionStatus).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("uses different cancel copy for absent vs deadline_unanswered", async () => {
    const session = sessionRow();
    vi.mocked(repos.findSessionById).mockResolvedValue(session);
    vi.mocked(repos.transitionStatus)
      .mockResolvedValueOnce(sessionRow({ status: "CANCELLED", cancelReason: "deadline_unanswered" }))
      .mockResolvedValueOnce(sessionRow({ status: "POSTPONE_VOTING" }));

    const { channel } = stubChannel();
    await settleAskingSession(stubClient(channel), db, session.id, "deadline_unanswered");

    const firstSend = vi.mocked(channel.send).mock.calls[0]?.[0] as { content: string };
    expect(firstSend.content).toContain("21:30 までに未回答");
  });
});
