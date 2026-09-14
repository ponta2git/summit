import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { slashCommands } from "../../../src/commands/definitions.ts";
import { buildFeatureRegistry } from "../../../src/discord/registry/index.ts";
import { featureModules } from "../../../src/discord/registry/modules.ts";

const expected = [
  { name: "ask", description: "今週の出欠確認を投稿します。", type: 1, options: [] },
  { name: "cancel_week", description: "今週の出欠確認をお休みにします。", type: 1, options: [] },
  { name: "status", description: "今週の状況を自分だけに表示します。", type: 1, options: [] }
];

describe("standalone command definitions", () => {
  it("preserves the guild registration payload and matches every runtime command", () => {
    expect(JSON.parse(JSON.stringify(slashCommands))).toStrictEqual(expected);
    expect(buildFeatureRegistry(featureModules).slashBuilders.map(builder => builder.toJSON()))
      .toStrictEqual(slashCommands);
  });

  it("exports definitions in a fresh process without any Bot environment", () => {
    const entry = new URL("../../../src/commands/definitions.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const { slashCommands } = await import(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify(slashCommands));`
    ], { env: {}, encoding: "utf8", timeout: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toStrictEqual(expected);
  });
});
