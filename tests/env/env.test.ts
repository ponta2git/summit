import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";

import { envSchema } from "../../src/envSchema.ts";

const validEnvInput = {
  DISCORD_TOKEN: "dummy-token",
  DATABASE_URL: "postgres://summit:summit@localhost:5433/summit",
  TZ: "Asia/Tokyo",
  SUMMIT_CONFIG_YAML: "discord: {}"
} as const;

describe("envSchema", () => {
  it("accepts valid required fields and preserves the injected config YAML", () => {
    const parsed = envSchema.parse(validEnvInput);

    expect(parsed.SUMMIT_CONFIG_YAML).toBe("discord: {}");
  });

  it("rejects invalid inputs", () => {
    const cases = [
      {
        name: "empty DISCORD_TOKEN",
        input: { ...validEnvInput, DISCORD_TOKEN: "" }
      },
      {
        name: "TZ is not Asia/Tokyo",
        input: { ...validEnvInput, TZ: "UTC" }
      },
      {
        name: "DATABASE_URL is not URL",
        input: { ...validEnvInput, DATABASE_URL: "not-a-url" }
      },
    ] as const;

    for (const testCase of cases) {
      const result = envSchema.safeParse(testCase.input);
      expect(result.success).toBe(false);
    }
  });

  it("provides expected inferred types", () => {
    const parsed = envSchema.parse(validEnvInput);

    expectTypeOf(parsed.TZ).toEqualTypeOf<"Asia/Tokyo">();
    expectTypeOf(parsed.SUMMIT_CONFIG_YAML).toEqualTypeOf<string>();
  });

  it("requires complete notification configuration, separate credentials and a private bind", () => {
    const notifications = { ...validEnvInput, RESULT_NOTIFICATION_TOKEN: "p".repeat(32),
      RESULT_NOTIFICATION_OPERATIONS_TOKEN: "o".repeat(32), RESULT_NOTIFICATION_WEB_ORIGIN: "https://example.test" };
    expect(envSchema.safeParse(notifications).success).toBe(true);
    const invalid = [
      { ...validEnvInput, RESULT_NOTIFICATION_TOKEN: "p".repeat(32) },
      { ...notifications, RESULT_NOTIFICATION_OPERATIONS_TOKEN: notifications.RESULT_NOTIFICATION_TOKEN },
      { ...notifications, RESULT_NOTIFICATION_TOKEN: "short" },
      { ...notifications, RESULT_NOTIFICATION_BIND_HOST: "0.0.0.0" },
      { ...notifications, RESULT_NOTIFICATION_BIND_HOST: "::" },
      { ...notifications, RESULT_NOTIFICATION_WEB_ORIGIN: "https://example.test/path" },
      { ...notifications, RESULT_NOTIFICATION_PORT: "0" }
    ];
    for (const input of invalid) { expect(envSchema.safeParse(input).success).toBe(false); }
  });

  it("does not expose DIRECT_URL in env type", () => {
    type Env = z.infer<typeof envSchema>;
    type HasDirectUrl = "DIRECT_URL" extends keyof Env ? true : false;
    const hasDirectUrl: HasDirectUrl = false;

    expect(hasDirectUrl).toBe(false);
  });
});
