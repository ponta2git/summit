import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type * as AskRenderModule from "../../src/features/ask-session/render.js";
import type * as AskViewModelModule from "../../src/features/ask-session/viewModel.js";
import type * as PostponeRenderModule from "../../src/features/postpone-voting/render.js";
import type * as PostponeViewModelModule from "../../src/features/postpone-voting/viewModel.js";
import type * as UserConfigModule from "../../src/userConfig.js";

let askRender: typeof AskRenderModule;
let askViewModel: typeof AskViewModelModule;
let postponeRender: typeof PostponeRenderModule;
let postponeViewModel: typeof PostponeViewModelModule;
let userConfigModule: typeof UserConfigModule;

const suppressMentionsConfigYaml = readFileSync("summit.config.example.yml", "utf8")
  .replace("suppressMentions: false", "suppressMentions: true");

beforeAll(async () => {
  vi.stubEnv("SUMMIT_CONFIG_YAML", suppressMentionsConfigYaml);
  vi.resetModules();
  userConfigModule = await import("../../src/userConfig.js");
  askRender = await import("../../src/features/ask-session/render.js");
  askViewModel = await import("../../src/features/ask-session/viewModel.js");
  postponeRender = await import("../../src/features/postpone-voting/render.js");
  postponeViewModel = await import("../../src/features/postpone-voting/viewModel.js");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("dev.suppressMentions=true", () => {
  it("propagates suppression through every message view model without leading blank lines", () => {
    expect(userConfigModule.appConfig.dev.suppressMentions).toBe(true);
    const session = {
      id: "session-suppress",
      candidateDateIso: "2026-04-24",
      status: "ASKING" as const,
      decidedStartAt: null
    };
    const askVm = askViewModel.buildAskMessageViewModel(session, [], []);
    const postponeVm = postponeViewModel.buildPostponeMessageViewModel(session);
    const settleVm = askViewModel.buildSettleNoticeViewModel("absent");

    const rendered = [
      askRender.renderAskBody(askVm).content,
      postponeRender.renderPostponeBody(postponeVm).content,
      askViewModel.renderSettleNotice(settleVm).content
    ];
    expect({
      suppressFlags: [
        askVm.suppressMentions,
        postponeVm.suppressMentions,
        settleVm.suppressMentions
      ],
      starts: rendered.map((content) => content?.slice(0, 2)),
      containsMention: rendered.map((content) => content?.includes("<@"))
    }).toStrictEqual({
      suppressFlags: [true, true, true],
      starts: ["🎲", "🔁", "🛑"],
      containsMention: [false, false, false]
    });
  });
});
