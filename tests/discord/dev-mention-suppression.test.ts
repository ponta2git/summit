// regression: DEV_SUPPRESS_MENTIONS=true で render / send 経路から `<@id>` が完全に消えることを担保する。
//   filter(Boolean) の空行消失や settle.ts の先頭改行残存など、実装時の地雷の回帰防止を兼ねる。
// @see docs/adr/0011-dev-mention-suppression.md
import { ChannelType, type Client } from "discord.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type * as SessionRepos from "../../src/db/repositories/sessions.js";
import type * as MemberRepos from "../../src/db/repositories/members.js";
import type * as ResponseRepos from "../../src/db/repositories/responses.js";
import type { DbLike, SessionRow } from "../../src/db/types.js";

import type * as AskRenderModule from "../../src/discord/ask/render.js";
import type * as PostponeModule from "../../src/discord/postponeMessage.js";
import type * as SettleModule from "../../src/discord/settle.js";
import type * as ViewModelsModule from "../../src/discord/viewModels.js";
import type * as EnvModule from "../../src/env.js";

import { buildSessionRow } from "./factories/session.js";

type RenderAsk = typeof AskRenderModule;
type RenderPostpone = typeof PostponeModule;
type Settle = typeof SettleModule;
type ViewModels = typeof ViewModelsModule;
type Env = typeof EnvModule;

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

let askRender: RenderAsk;
let postponeRender: RenderPostpone;
let settle: Settle;
let viewModels: ViewModels;
let envModule: Env;
let repos: typeof SessionRepos;

// why: 対象モジュール (render / postponeMessage / settle / viewModels / env / repos) は全て env を
//   モジュール読込時定数として参照するため、DEV_SUPPRESS_MENTIONS=true 下で
//   再 import する必要がある。cold load が支配的コスト (~1.5s) なので `beforeAll` で
//   1 度だけ償却する。`beforeEach` 化すると 4 倍に増える。
// invariant: 以下のテストは全て DEV_SUPPRESS_MENTIONS=true を前提にした regression。
//   env-independent な assertion は含めない (env=false 側は client.test.ts / render.test.ts でカバー)。
beforeAll(async () => {
  vi.stubEnv("DEV_SUPPRESS_MENTIONS", "true");
  vi.resetModules();
  envModule = await import("../../src/env.js");
  askRender = await import("../../src/discord/ask/render.js");
  postponeRender = await import("../../src/discord/postponeMessage.js");
  settle = await import("../../src/discord/settle.js");
  viewModels = await import("../../src/discord/viewModels.js");
  repos = await import("../../src/db/repositories/sessions.js");
});

// race: beforeAll で import した repos のモック履歴がテスト間で共有されるのを防ぐ。
//   将来のテスト追加時に順序結合バグを招かないためのガード。
afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow =>
  buildSessionRow({ id: "session-suppress", askMessageId: "ask-msg-1", ...overrides });

describe("DEV_SUPPRESS_MENTIONS=true", () => {
  // why: 以下 4 件はどれも env=true を前提にした振る舞いを検証する。env parse 自体の
  //   invariant (defaults / "true"/"false"/"1"/"0"/"yes"/"no" / invalid) は
  //   tests/env/env.test.ts で網羅済みのためここでは重複させない。
  //   beforeAll の setup が誤ると下 4 件が同時に失敗するため、故障検知の側面でも冗長。
  it("renderAskBody content contains no <@ mentions", () => {
    // invariant: envModule は stub 後に import 済みであること (setup 故障検知)。
    expect(envModule.env.DEV_SUPPRESS_MENTIONS).toBe(true);
    const vm = viewModels.buildAskMessageViewModel(sessionRow(), [], []);
    const rendered = askRender.renderAskBody(vm);
    expect(rendered.content).not.toContain("<@");
    expect(rendered.content).toContain("開催候補日");
    // regression: 本文の空行レイアウトが維持されていること（filter(Boolean) 地雷の回避）
    expect(rendered.content).toMatch(/今週の桃鉄1年勝負の出欠確認です\n\n開催候補日/);
  });

  it("renderInitialAskBody content contains no <@ mentions", () => {
    const vm = viewModels.buildInitialAskMessageViewModel(
      "session-id",
      new Date("2026-04-24T00:00:00+09:00"),
      []
    );
    const rendered = askRender.renderAskBody(vm);
    expect(rendered.content).not.toContain("<@");
  });

  it("renderPostponeBody content contains no <@ mentions and no leading blank", () => {
    const vm = viewModels.buildPostponeMessageViewModel(sessionRow());
    const rendered = postponeRender.renderPostponeBody(vm);
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
