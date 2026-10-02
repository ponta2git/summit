import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const script = fileURLToPath(new URL("../../scripts/verify/forbidden-patterns.sh", import.meta.url));
const rgPath = spawnSync("/usr/bin/which", ["rg"], { encoding: "utf8" }).stdout.trim();
const searchPath = `${dirname(rgPath)}:/usr/bin:/bin`;
const fixture = (name: string, text: string): string => {
  const root = mkdtempSync(join(tmpdir(), "summit-patterns-"));
  roots.push(root);
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), text);
  return root;
};
const verify = (cwd: string, path = searchPath): ReturnType<typeof spawnSync> =>
  spawnSync("/bin/bash", [script], { cwd, env: { PATH: path, CI: "true" }, encoding: "utf8", timeout: 10_000 });

afterEach(() => { for (const root of roots.splice(0)) { rmSync(root, { recursive: true, force: true }); } });

describe("forbidden pattern verification", () => {
  it.each(["ts", "js"])("rejects cross-feature side effects using .%s imports", extension => {
    const root = fixture("src/features/a/button.ts", `import { update } from "../b/messageEditor.${extension}";\n`);
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no-cross-feature-side-effect-import");
  });

  it("allows pure cross-feature builders and ignores generated code", () => {
    const root = fixture("src/features/a/render.ts", 'import { view } from "../b/viewModel.ts";\n');
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/render.js"), 'import { update } from "../b/messageEditor.js";\n');
    expect(verify(root).status).toBe(0);
  });

  it("reports locations without exposing credentials even when another rule matches the same line", () => {
    const token = ["A".repeat(24), "B".repeat(6), "C".repeat(28)].join(".");
    const root = fixture("src/unsafe.ts", `const value = sql.raw("${token}");\n`);
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("[no-sql-raw] ./src/unsafe.ts:1: forbidden pattern detected");
    expect(result.stdout).toContain("[no-secret-shape] ./src/unsafe.ts:1: forbidden pattern detected");
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });

  it("fails closed when the search tool fails instead of reporting a clean repository", () => {
    const root = fixture("bin/rg", "#!/bin/sh\nexit 2\n");
    chmodSync(join(root, "bin/rg"), 0o755);
    const result = verify(root, `${join(root, "bin")}:${searchPath}`);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("verification is incomplete");
    expect(result.stdout).not.toContain("no matches");
  });
});
