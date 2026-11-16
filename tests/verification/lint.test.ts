import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const executable = join(root, "node_modules/oxlint/bin/oxlint");

const lint = (source: string): { readonly status: number | null; readonly output: string } => {
  // why: use the real tsconfig and installed dependencies; an isolated inferred
  // project could pass while imports silently become unknown/error types.
  const directory = mkdtempSync(join(root, "scripts/.lint-probe-"));
  try {
    const path = join(directory, "probe.ts");
    writeFileSync(path, source);
    const result = spawnSync(process.execPath, [executable, path, "--format", "json", "--deny-warnings"], {
      cwd: root, encoding: "utf8", timeout: 20_000
    });
    if (result.error) { throw result.error; }
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe("type-aware lint gate", () => {
  it("rejects detached external promises even behind void, and async void callbacks", () => {
    const result = lint(`
import * as Effect from "effect/Effect";
import type { Client } from "discord.js";
import type { ResultNotificationKind } from "@momo/db";
declare const client: Client;
declare const kind: ResultNotificationKind;
void Effect.runPromise(Effect.void);
client.login("test-placeholder");
declare const consume: (callback: () => void) => void;
consume(async () => { await Promise.resolve(); });
await kind;
`);
    expect(result.status).toBe(1);
    expect(result.output.match(/typescript\(no-floating-promises\)/g)).toHaveLength(2);
    expect(result.output).toContain("typescript(no-misused-promises)");
    expect(result.output).toContain("typescript(await-thenable)");
  });

  it("accepts owned failures and this-free port callbacks with resolved database types", () => {
    const result = lint(`
import * as Effect from "effect/Effect";
import type { OutboxPort } from "../../src/db/ports.ts";
declare const port: OutboxPort;
declare const now: Date;
void Effect.runPromise(Effect.void).catch(() => undefined);
void port.getMetrics(now).then(metrics => metrics.pending).catch(() => undefined);
const read = port.getMetrics;
void read(now).catch(() => undefined);
`);
    expect(result.status).toBe(0);
  });

  it("rejects missing union branches even when a void handler has a default", () => {
    const result = lint(`
import type { ResultNotificationKind } from "@momo/db";
export const handle = (kind: ResultNotificationKind): void => {
  switch (kind) {
    case "ocr_completed": return;
    default: return;
  }
};
`);
    expect(result.status).toBe(1);
    expect(result.output).toContain("typescript(switch-exhaustiveness-check)");
  });
});
