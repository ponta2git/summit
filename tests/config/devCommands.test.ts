import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const manifest: { scripts: Record<string, string> } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("development command argument forwarding", () => {
  it.each([
    { name: "commands:sync", args: "--check", expected: ["src/commands/sync.ts", "--check"] },
    { name: "db:reset", args: "--all", expected: ["scripts/dev/reset.ts", "--all"] },
    { name: "dev:scenario", args: "shorten 5", expected: ["scripts/dev/scenario.ts", "shorten", "5"] }
  ])("forwards arguments through $name shell wrappers", ({ name, args, expected }) => {
    const directory = mkdtempSync(join(tmpdir(), "summit-command-"));
    try {
      const bin = join(directory, "bin"); mkdirSync(bin);
      // why: 外部dotenv/nodeだけをstubし、packageの実shell wrapperによる引数配送を観測する。
      writeFileSync(join(bin, "dotenv"), '#!/bin/sh\nwhile [ "$#" -gt 0 ] && [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n', { mode: 0o755 });
      writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      writeFileSync(join(directory, "summit.config.yml"), "test: fixture\n");
      const result = spawnSync("/bin/sh", ["-c", `${manifest.scripts[name]} ${args}`], {
        cwd: directory, env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: "utf8", timeout: 5000
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toStrictEqual(expected);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
