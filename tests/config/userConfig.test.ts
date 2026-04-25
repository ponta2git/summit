import { describe, expect, it } from "vitest";

import {
  buildAppConfig,
  loadUserConfigInput,
  parseUserConfigInput,
  userConfigSchema
} from "../../src/userConfig.js";
import { expectParseFailure } from "../helpers/assertions.js";

const validConfigInput = {
  discord: {
    guildId: "123456789012345678",
    channelId: "223456789012345678"
  },
  members: [
    { userId: "323456789012345678", displayName: "いーゆー" },
    { userId: "423456789012345678", displayName: "おーたか" },
    { userId: "523456789012345678", displayName: "あかねまみ" },
    { userId: "623456789012345678", displayName: "ぽんた" }
  ],
  schedule: {
    askTime: "08:00",
    answerDeadline: "21:30",
    postponeDeadline: "24:00",
    reminderLeadMinutes: 15
  },
  slots: {
    T2200: "22:00",
    T2230: "22:30",
    T2300: "23:00",
    T2330: "23:30"
  },
  dev: {
    suppressMentions: false
  }
} as const;

const validationYaml = `
discord:
  guildId: "123456789012345678"
  channelId: "223456789012345678"
members:
  - userId: "323456789012345678"
    displayName: "いーゆー"
  - userId: "423456789012345678"
    displayName: "おーたか"
  - userId: "523456789012345678"
    displayName: "あかねまみ"
  - userId: "623456789012345678"
    displayName: "ぽんた"
schedule:
  askTime: "08:00"
  answerDeadline: "21:30"
  postponeDeadline: "24:00"
  reminderLeadMinutes: 15
slots:
  T2200: "22:00"
  T2230: "22:30"
  T2300: "23:00"
  T2330: "23:30"
dev:
  suppressMentions: true
`;

const productionYaml = validationYaml
  .replace('guildId: "123456789012345678"', 'guildId: "111111111111111111"')
  .replace("suppressMentions: true", "suppressMentions: false");

describe("userConfigSchema", () => {
  it("accepts the documented configuration shape", () => {
    const parsed = parseUserConfigInput(validConfigInput);

    expect(parsed.discord.guildId).toBe("123456789012345678");
    expect(parsed.members).toHaveLength(4);
    expect(parsed.schedule.postponeDeadline).toBe("24:00");
  });

  it("defaults dev.suppressMentions to false", () => {
    const parsed = parseUserConfigInput({
      ...validConfigInput,
      dev: {}
    });

    expect(parsed.dev.suppressMentions).toBe(false);
  });

  it("loads injected SUMMIT_CONFIG_YAML content", () => {
    const input = loadUserConfigInput({
      configYaml: productionYaml
    });
    const appConfig = buildAppConfig(parseUserConfigInput(input));

    expect(appConfig.discord.guildId).toBe("111111111111111111");
    expect(appConfig.dev.suppressMentions).toBe(false);
  });

  it("loads package-script injected local YAML content", () => {
    const input = loadUserConfigInput({
      configYaml: validationYaml
    });
    const appConfig = buildAppConfig(parseUserConfigInput(input));

    expect(appConfig.discord.guildId).toBe("123456789012345678");
    expect(appConfig.dev.suppressMentions).toBe(true);
  });

  it("rejects invalid user-facing settings", () => {
    const cases = [
      {
        name: "guild id is not a snowflake",
        input: {
          ...validConfigInput,
          discord: { ...validConfigInput.discord, guildId: "not-a-snowflake" }
        }
      },
      {
        name: "members has 3 entries",
        input: {
          ...validConfigInput,
          members: validConfigInput.members.slice(0, 3)
        }
      },
      {
        name: "askTime is not HH:MM",
        input: {
          ...validConfigInput,
          schedule: { ...validConfigInput.schedule, askTime: "8:00" }
        }
      },
      {
        name: "postponeDeadline is not the supported boundary literal",
        input: {
          ...validConfigInput,
          schedule: { ...validConfigInput.schedule, postponeDeadline: "23:59" }
        }
      },
      {
        name: "slot literal drifts from DB/custom_id compatibility",
        input: {
          ...validConfigInput,
          slots: { ...validConfigInput.slots, T2200: "21:30" }
        }
      }
    ] as const;

    for (const testCase of cases) {
      expectParseFailure(userConfigSchema.safeParse(testCase.input), testCase.name);
    }
  });
});
