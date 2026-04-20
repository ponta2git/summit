import { ChannelType, type Client } from "discord.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SessionRow } from "../../src/db/types.js";
import type * as AskRenderModule from "../../src/features/ask-session/render.js";
import type * as PostponeModule from "../../src/features/postpone-voting/render.js";
import type * as SettleModule from "../../src/features/ask-session/settle.js";
import type * as AskViewModelModule from "../../src/features/ask-session/viewModel.js";
import type * as PostponeViewModelModule from "../../src/features/postpone-voting/viewModel.js";
import type * as EnvModule from "../../src/env.js";
import type * as TestingModule from "../testing/index.js";

import { buildSessionRow } from "./factories/session.js";

type RenderAsk = typeof AskRenderModule;
type RenderPostpone = typeof PostponeModule;
type Settle = typeof SettleModule;
type AskViewModel = typeof AskViewModelModule;
type PostponeViewModel = typeof PostponeViewModelModule;
type Env = typeof EnvModule;
type Testing = typeof TestingModule;

let askRender: RenderAsk;
let postponeRender: RenderPostpone;
let settle: Settle;
let askViewModel: AskViewModel;
let postponeViewModel: PostponeViewModel;
let envModule: Env;
let testing: Testing;

// why: 対象モジュール (render / postpone/render / settle / ask-viewModel / postpone-viewModel / env) は全て env を
//   モジュール読込時定数として参照するため、DEV_SUPPRESS_MENTIONS=true 下で
//   再 import する必要がある。cold load が支配的コスト (~1.5s) なので `beforeAll` で
//   1 度だけ償却する。`beforeEach` 化すると 4 倍に増える。
// invariant: 以下のテストは全て DEV_SUPPRESS_MENTIONS=true を前提にした regression。
//   env-independent な assertion は含めない (env=false 側は client.test.ts / render.test.ts でカバー)。
beforeAll(async () => {
  vi.stubEnv("DEV_SUPPRESS_MENTIONS", "true");
  vi.resetModules();
  envModule = await import("../../src/env.js");
  askRender = await import("../../src/features/ask-session/render.js");
  postponeRender = await import("../../src/features/postpone-voting/render.js");
  settle = await import("../../src/features/ask-session/settle.js");
  askViewModel = await import("../../src/features/ask-session/viewModel.js");
  postponeViewModel = await import("../../src/features/postpone-voting/viewModel.js");
  testing = await import("../testing/index.js");
});

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
  it("renderAskBody content contains no <@ mentions", () => {
    expect(envModule.env.DEV_SUPPRESS_MENTIONS).toBe(true);
    const vm = askViewModel.buildAskMessageViewModel(sessionRow(), [], []);
    const rendered = askRender.renderAskBody(vm);
    expect(rendered.content).not.toContain("<@");
    expect(rendered.content).toContain("開催候補日");
    // regression: 本文の空行レイアウトが維持されていること（filter(Boolean) 地雷の回避）
    expect(rendered.content).toMatch(/今週の桃鉄1年勝負の出欠確認です\n\n開催候補日/);
  });

  it("renderInitialAskBody content contains no <@ mentions", () => {
    const vm = askViewModel.buildInitialAskMessageViewModel(
      "session-id",
      new Date("2026-04-24T00:00:00+09:00"),
      []
    );
    const rendered = askRender.renderAskBody(vm);
    expect(rendered.content).not.toContain("<@");
  });

  it("renderPostponeBody content contains no <@ mentions and no leading blank", () => {
    const vm = postponeViewModel.buildPostponeMessageViewModel(sessionRow());
    const rendered = postponeRender.renderPostponeBody(vm);
    expect(rendered.content).not.toContain("<@");
    expect(rendered.content?.startsWith("\n")).toBe(false);
    expect(rendered.content).toMatch(/^🔁/);
  });

  it("settleAskingSession cancel send has no <@ mentions, no leading newline, and no per-message allowedMentions", async () => {
    const session = sessionRow();
    const ctx = testing.createTestAppContext({ seed: { sessions: [session] } });

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

    await settle.settleAskingSession(client, ctx, session.id, "absent");

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
