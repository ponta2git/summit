import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import { envSchema } from "../../src/env.js";

const validEnvInput = {
  DISCORD_TOKEN: "dummy-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_CHANNEL_ID: "223456789012345678",
  MEMBER_USER_IDS:
    "323456789012345678,423456789012345678,523456789012345678,623456789012345678",
  DATABASE_URL: "postgres://summit:summit@localhost:5433/summit",
  TZ: "Asia/Tokyo",
  POSTPONE_DEADLINE: "24:00"
} as const;

describe("envSchema", () => {
  it("accepts blank HEALTHCHECK_PING_URL and transforms it to undefined", () => {
    const result = envSchema.safeParse({
      ...validEnvInput,
      HEALTHCHECK_PING_URL: ""
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.HEALTHCHECK_PING_URL).toBeUndefined();
  });

  it("accepts missing HEALTHCHECK_PING_URL as undefined", () => {
    const result = envSchema.safeParse(validEnvInput);

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.HEALTHCHECK_PING_URL).toBeUndefined();
  });

  it("accepts valid HEALTHCHECK_PING_URL URL", () => {
    const result = envSchema.safeParse({
      ...validEnvInput,
      HEALTHCHECK_PING_URL: "https://hc-ping.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.HEALTHCHECK_PING_URL).toBe(
      "https://hc-ping.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    );
  });

  it("accepts valid required fields and preserves the 4-member contract", () => {
    const parsed = envSchema.parse(validEnvInput);

    expect(parsed.MEMBER_USER_IDS).toHaveLength(4);
    expect(parsed.MEMBER_USER_IDS).toEqual([
      "323456789012345678",
      "423456789012345678",
      "523456789012345678",
      "623456789012345678"
    ]);
  });

  it("rejects invalid inputs", () => {
    const cases = [
      {
        name: "empty DISCORD_TOKEN",
        input: { ...validEnvInput, DISCORD_TOKEN: "" }
      },
      {
        name: "DISCORD_GUILD_ID is 16 digits",
        input: { ...validEnvInput, DISCORD_GUILD_ID: "1234567890123456" }
      },
      {
        name: "DISCORD_GUILD_ID is 21 digits",
        input: { ...validEnvInput, DISCORD_GUILD_ID: "123456789012345678901" }
      },
      {
        name: "DISCORD_GUILD_ID includes letters",
        input: { ...validEnvInput, DISCORD_GUILD_ID: "1234567890abc45678" }
      },
      {
        name: "MEMBER_USER_IDS has 3 entries",
        input: {
          ...validEnvInput,
          MEMBER_USER_IDS: "323456789012345678,423456789012345678,523456789012345678"
        }
      },
      {
        name: "MEMBER_USER_IDS has 5 entries",
        input: {
          ...validEnvInput,
          MEMBER_USER_IDS:
            "323456789012345678,423456789012345678,523456789012345678,623456789012345678,723456789012345678"
        }
      },
      {
        name: "MEMBER_USER_IDS contains an empty entry",
        input: {
          ...validEnvInput,
          MEMBER_USER_IDS:
            "323456789012345678,423456789012345678,,623456789012345678"
        }
      },
      {
        name: "TZ is not Asia/Tokyo",
        input: { ...validEnvInput, TZ: "UTC" }
      },
      {
        name: "POSTPONE_DEADLINE is 25:00",
        input: { ...validEnvInput, POSTPONE_DEADLINE: "25:00" }
      },
      {
        name: "POSTPONE_DEADLINE is 23:59",
        input: { ...validEnvInput, POSTPONE_DEADLINE: "23:59" }
      },
      {
        name: "DATABASE_URL is not URL",
        input: { ...validEnvInput, DATABASE_URL: "not-a-url" }
      },
      {
        name: "HEALTHCHECK_PING_URL is invalid URL",
        input: { ...validEnvInput, HEALTHCHECK_PING_URL: "ht!tp://invalid-url" }
      }
    ] as const;

    for (const testCase of cases) {
      const result = envSchema.safeParse(testCase.input);
      expect(result.success, testCase.name).toBe(false);
    }
  });

  it("provides expected inferred types", () => {
    const parsed = envSchema.parse(validEnvInput);

    expectTypeOf(parsed.TZ).toEqualTypeOf<"Asia/Tokyo">();
    expectTypeOf(parsed.MEMBER_USER_IDS).toEqualTypeOf<string[]>();
    expect(parsed.MEMBER_USER_IDS.length).toBe(4);
  });

  it("does not expose DIRECT_URL in env type", () => {
    type Env = z.infer<typeof envSchema>;
    type HasDirectUrl = "DIRECT_URL" extends keyof Env ? true : false;
    const hasDirectUrl: HasDirectUrl = false;

    expect(hasDirectUrl).toBe(false);
  });
});
