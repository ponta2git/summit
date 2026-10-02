import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
const designDocs = ["architecture", "discord-rule", "db-rule", "time-rule", "test-rule", "dev-rule"];
// why: 個人の Git 設定や認証環境を使わず、使い捨て checkout だけを操作する。
const childEnv = { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };

const writeFixture = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
};

const runGit = (root: string, args: string[]): void => {
  const result = spawnSync("git", args, { cwd: root, env: childEnv, encoding: "utf8" });
  expect(result.status).toBe(0);
};

const createRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "summit-docs-"));
  directories.push(root);
  writeFixture(root, "package.json", '{"type":"module"}\n');
  writeFixture(root, "AGENTS.md", "# Fixture instructions\n");
  writeFixture(root, "CLAUDE.md", "@AGENTS.md\n");
  writeFixture(root, ".github/copilot-instructions.md", "stale adapter\n");
  writeFixture(root, "requirements/base.md", "# Requirements\n");
  writeFixture(root, "docs/operations/README.md", "# Operations\n");
  for (const name of designDocs) {
    writeFixture(root, `docs/${name}.md`, `# ${name}\n`);
  }
  writeFixture(root, "docs/README.md", [
    "# Documents", "## 2. 文書の責務", "| ファイル | 責務 |", "|---|---|",
    ...designDocs.map((name) => `| \`docs/${name}.md\` | contract |`),
    "## 3. 正本の判定", ""
  ].join("\n"));
  mkdirSync(join(root, "scripts/verify"), { recursive: true });
  copyFileSync(new URL("../../scripts/verify/docs.ts", import.meta.url), join(root, "scripts/verify/docs.ts"));
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["add", "."]);
  return root;
};

const verify = (root: string, ...args: string[]): ReturnType<typeof spawnSync> =>
  spawnSync(process.execPath, [join(root, "scripts/verify/docs.ts"), ...args], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
    timeout: 10_000
  });

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("documentation verification read boundary", () => {
  it("syncs adapters without reading untracked local settings and detects tracked violations", () => {
    const root = createRepository();
    const retiredMarker = ["A", "D", "R", "-0001"].join("");
    writeFixture(root, "private-settings.yml", `fixture: ${retiredMarker}\n`);
    const result = verify(root, "--write-adapters");
    expect(result.status).toBe(0);
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(join(root, ".github/copilot-instructions.md"), "utf8")).toBe(
      "<!-- Generated from AGENTS.md by `pnpm docs:sync-agent`. Do not edit directly. -->\n\n# Fixture instructions\n"
    );

    runGit(root, ["add", "private-settings.yml"]);
    expect(verify(root).status).toBe(1);
  });

  it("validates explicitly included new documents, including paths with spaces and anchors", () => {
    const root = createRepository();
    writeFixture(root, "docs/new guide.md", "[contract](architecture.md#missing)\n");
    expect(verify(root, "--write-adapters").status).toBe(0);
    expect(verify(root, "--include", "docs/new guide.md").status).toBe(1);
    writeFixture(root, "docs/new guide.md", "[contract](architecture.md#architecture)\n");
    writeFixture(root, "docs/second.md", "[broken](absent.md)\n");
    expect(verify(root, "--include", "docs/new guide.md", "--include", "docs/second.md").status).toBe(1);
    writeFixture(root, "docs/second.md", "[contract](architecture.md)\n");
    expect(verify(root, "--include", "docs/new guide.md", "--include", "docs/second.md").status).toBe(0);
  });

  it("reads working tree changes and permits deletion of non-required tracked files", () => {
    const root = createRepository();
    writeFixture(root, "docs/temporary.md", "# Temporary\n");
    runGit(root, ["add", "docs/temporary.md"]);
    rmSync(join(root, "docs/temporary.md"));
    expect(verify(root, "--write-adapters").status).toBe(0);
    writeFixture(root, "docs/architecture.md", "[missing](absent.md)\n");
    expect(verify(root).status).toBe(1);
  });

  it.each([
    ["--unknown"], ["--include"], ["--include", "absent.md"],
    ["--include", "docs"], ["--include", "../outside.md"]
  ])("rejects invalid selection before writing adapters: %j", (...args) => {
    const root = createRepository();
    expect(verify(root, "--write-adapters", ...args).status).toBe(1);
    expect(readFileSync(join(root, ".github/copilot-instructions.md"), "utf8")).toBe("stale adapter\n");
  });

  it("rejects symlinks instead of reading their content", () => {
    const root = createRepository();
    symlinkSync("AGENTS.md", join(root, "linked.md"));
    expect(verify(root, "--write-adapters", "--include", "linked.md").status).toBe(1);
    expect(readFileSync(join(root, ".github/copilot-instructions.md"), "utf8")).toBe("stale adapter\n");
  });

  it("fails without Git inventory instead of falling back to a directory scan", () => {
    const root = createRepository();
    rmSync(join(root, ".git"), { recursive: true, force: true });
    const result = verify(root, "--write-adapters");
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain("could not collect verification files");
    expect(readFileSync(join(root, ".github/copilot-instructions.md"), "utf8")).toBe("stale adapter\n");
  });
});
