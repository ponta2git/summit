// regression: DEV_SUPPRESS_MENTIONS=true で render / send 経路から `<@id>` が完全に消えることを担保する。
//   filter(Boolean) の空行消失や settle.ts の先頭改行残存など、実装時の地雷の回帰防止を兼ねる。
// @see docs/adr/0011-dev-mention-suppression.md
import { ChannelType, type Client } from "discord.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as SessionRepos from "../../src/db/repositories/sessions.js";
import type { DbLike, SessionRow } from "../../src/db/repositories/sessions.js";

import type * as AskRenderModule from "../../src/discord/ask/render.js";
import type * as PostponeModule from "../../src/discord/postponeMessage.js";
import type * as SettleModule from "../../src/discord/settle.js";
import type * as EnvModule from "../../src/env.js";

type RenderAsk = typeof AskRenderModule;
type RenderPostpone = typeof PostponeModule;
type Settle = typeof SettleModule;
type Env = typeof EnvModule;

vi.mock("../../src/db/repositories/sessions.js", async () => {
  const actual = await vi.importActual<typeof SessionRepos>(
    "../../src/db/repositories/sessions.js"
  );
  return {
    ...actual,
    findSessionById: vi.fn(),
    transitionStatus: vi.fn(),
    setPostponeMessageId: vi.fn(),
    listResponses: vi.fn(async () => []),
    listMembers: vi.fn(async () => [])
  };
});

let askRender: RenderAsk;
let postponeRender: RenderPostpone;
let settle: Settle;
let envModule: Env;
let repos: typeof SessionRepos;

beforeAll(async () => {
  vi.stubEnv("DEV_SUPPRESS_MENTIONS", "true");
  vi.resetModules();
  envModule = await import("../../src/env.js");
  askRender = await import("../../src/discord/ask/render.js");
  postponeRender = await import("../../src/discord/postponeMessage.js");
  settle = await import("../../src/discord/settle.js");
  repos = await import("../../src/db/repositories/sessions.js");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: "session-suppress",
  weekKey: "2026-W17",
  postponeCount: 0,
  candidateDate: "2026-04-24",
  status: "ASKING",
  channelId: "223456789012345678",
  askMessageId: "ask-msg-1",
  postponeMessageId: null,
  deadlineAt: new Date("2026-04-24T12:30:00.000Z"),
  decidedStartAt: null,
  cancelReason: null,
  reminderAt: null,
  reminderSentAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides
});

describe("DEV_SUPPRESS_MENTIONS=true", () => {
  it("env parses the flag as true", () => {
    expect(envModule.env.DEV_SUPPRESS_MENTIONS).toBe(true);
  });

  it("renderAskBody content contains no <@ mentions", () => {
    const rendered = askRender.renderAskBody(sessionRow(), [], new Map());
    expect(rendered.content).not.toContain("<@");
    expect(rendered.content).toContain("開催候補日");
    // regression: 本文の空行レイアウトが維持されていること（filter(Boolean) 地雷の回避）
    expect(rendered.content).toMatch(/今週の桃鉄1年勝負の出欠確認です\n\n開催候補日/);
  });

  it("renderInitialAskBody content contains no <@ mentions", () => {
    const rendered = askRender.renderInitialAskBody("session-id", new Date("2026-04-24T00:00:00+09:00"));
    expect(rendered.content).not.toContain("<@");
  });

  it("renderPostponeBody content contains no <@ mentions and no leading blank", () => {
    const rendered = postponeRender.renderPostponeBody(sessionRow());
    expect(rendered.content).not.toContain("<@");
    expect(rendered.content?.startsWith("\n")).toBe(false);
    expect(rendered.content).toMatch(/^🔁/);
  });

  it("settleAskingSession cancel send has no <@ mentions, no leading newline, and no per-message allowedMentions", async () => {
    const session = sessionRow();
    vi.mocked(repos.findSessionById).mockResolvedValue(session);
    vi.mocked(repos.transitionStatus)
      .mockResolvedValueOnce(sessionRow({ status: "CANCELLED", cancelReason: "absent" }))
      .mockResolvedValueOnce(sessionRow({ status: "POSTPONE_VOTING" }));

    const sendMock = vi.fn(async (_payload: unknown) => ({ id: "posted-x" }));
    const channel = {
      type: ChannelType.GuildText,
      isSendable: () => true,
      send: sendMock,
      messages: { fetch: vi.fn(async () => ({ edit: vi.fn() })) }
    };
    const client = {
      channels: { fetch: vi.fn(async () => channel) }
    } as unknown as Client;

    await settle.settleAskingSession(client, {} as DbLike, session.id, "absent");

    const firstPayload = sendMock.mock.calls[0]?.[0] as unknown as {
      content: string;
      allowedMentions?: unknown;
    };
    expect(firstPayload.content).not.toContain("<@");
    expect(firstPayload.content.startsWith("\n")).toBe(false);
    expect(firstPayload.content).toMatch(/^🛑/);
    // invariant: per-message allowedMentions を指定しない。Client-default (parse:[]) に委ねる。
    expect(firstPayload.allowedMentions).toBeUndefined();
  });
});
