import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WRITE_ADAPTERS_ARG = "--write-adapters";
const AGENTS_MAX_BYTES = 4 * 1_024;
const GENERATED_HEADER =
  "<!-- Generated from AGENTS.md by `pnpm docs:sync-agent`. Do not edit directly. -->\n\n";

const REQUIRED_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  "requirements/base.md",
  "docs/README.md",
  "docs/architecture.md",
  "docs/discord-rule.md",
  "docs/db-rule.md",
  "docs/time-rule.md",
  "docs/test-rule.md",
  "docs/dev-rule.md",
  "docs/operations/README.md"
] as const;

const CANONICAL_DESIGN_DOCS = [
  "docs/architecture.md",
  "docs/discord-rule.md",
  "docs/db-rule.md",
  "docs/time-rule.md",
  "docs/test-rule.md",
  "docs/dev-rule.md"
] as const;

const RETIRED_PATHS = [
  ["docs", "adr"].join("/"),
  [".github", "instructions"].join("/"),
  ["requirements", "base.md.original.bak"].join("/")
] as const;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".serena",
  "coverage",
  "dist",
  "node_modules"
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".sh",
  ".toml",
  ".ts",
  ".yaml",
  ".yml"
]);

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const decisionRecordTerm = ["A", "D", "R"].join("");
const retiredDecisionDirectory = ["docs", "adr"].join("/");
const retiredInstructionDirectory = [".github", "instructions"].join("/");
const LEGACY_MARKERS: ReadonlyArray<{
  readonly label: string;
  readonly pattern: RegExp;
}> = [
  {
    label: "numbered decision-record identifier",
    pattern: new RegExp(`${decisionRecordTerm}-[0-9]{4}`, "u")
  },
  {
    label: "retired decision-record term",
    pattern: new RegExp(`\\b${decisionRecordTerm}\\b`, "u")
  },
  {
    label: "retired decision-record directory",
    pattern: new RegExp(escapeRegExp(retiredDecisionDirectory), "u")
  },
  {
    label: "retired scoped-instruction directory",
    pattern: new RegExp(escapeRegExp(retiredInstructionDirectory), "u")
  },
  {
    label: "retired scoped-instruction filename",
    pattern: /\.instructions\.md/u
  }
];

const failures: string[] = [];

const displayPath = (absolutePath: string): string =>
  relative(ROOT, absolutePath).split(sep).join("/");

const recordFailure = (message: string): void => {
  failures.push(message);
};

const pathExists = async (absolutePath: string): Promise<boolean> => {
  try {
    await stat(absolutePath);
    return true;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const listFiles = async (absoluteDirectory: string): Promise<readonly string[]> => {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolutePath = resolve(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
};

const expectedClaudeAdapter = (): string => "@AGENTS.md\n";

const expectedCopilotAdapter = (agentsContent: string): string =>
  `${GENERATED_HEADER}${agentsContent}`;

const writeAdapters = async (agentsContent: string): Promise<void> => {
  await Promise.all([
    writeFile(resolve(ROOT, "CLAUDE.md"), expectedClaudeAdapter(), "utf8"),
    writeFile(
      resolve(ROOT, ".github/copilot-instructions.md"),
      expectedCopilotAdapter(agentsContent),
      "utf8"
    )
  ]);
  process.stdout.write("Updated CLAUDE.md and .github/copilot-instructions.md from AGENTS.md.\n");
};

const verifyRequiredPaths = async (): Promise<void> => {
  for (const projectPath of REQUIRED_PATHS) {
    if (!await pathExists(resolve(ROOT, projectPath))) {
      recordFailure(`required path is missing: ${projectPath}`);
    }
  }
};

const verifyRetiredPaths = async (): Promise<void> => {
  for (const projectPath of RETIRED_PATHS) {
    if (await pathExists(resolve(ROOT, projectPath))) {
      recordFailure(`retired path still exists: ${projectPath}`);
    }
  }
};

const verifyAdapters = async (agentsContent: string): Promise<void> => {
  const agentsBytes = Buffer.byteLength(agentsContent, "utf8");
  if (agentsBytes > AGENTS_MAX_BYTES) {
    recordFailure(
      `AGENTS.md is ${agentsBytes} bytes; keep the entrypoint at or below ${AGENTS_MAX_BYTES} bytes`
    );
  }

  const claudePath = resolve(ROOT, "CLAUDE.md");
  if (await pathExists(claudePath)) {
    const claudeContent = await readFile(claudePath, "utf8");
    if (claudeContent !== expectedClaudeAdapter()) {
      recordFailure("CLAUDE.md must be the exact @AGENTS.md import; run `pnpm docs:sync-agent`");
    }
  }

  const copilotPath = resolve(ROOT, ".github/copilot-instructions.md");
  if (await pathExists(copilotPath)) {
    const copilotContent = await readFile(copilotPath, "utf8");
    if (copilotContent !== expectedCopilotAdapter(agentsContent)) {
      recordFailure(
        ".github/copilot-instructions.md is out of sync with AGENTS.md; run `pnpm docs:sync-agent`"
      );
    }
  }
};

const verifyTaxonomyRows = async (): Promise<void> => {
  const indexPath = resolve(ROOT, "docs/README.md");
  if (!await pathExists(indexPath)) {
    return;
  }
  const indexContent = await readFile(indexPath, "utf8");
  const responsibilitySection = indexContent
    .split("## 3. 正本の判定", 1)[0]
    ?.split("## 2. 文書の責務", 2)[1];

  if (!responsibilitySection) {
    recordFailure("docs/README.md must contain the `## 2. 文書の責務` section");
    return;
  }

  for (const projectPath of CANONICAL_DESIGN_DOCS) {
    const expectedPrefix = `| \`${projectPath}\` |`;
    const count = responsibilitySection
      .split("\n")
      .filter((line) => line.startsWith(expectedPrefix))
      .length;
    if (count !== 1) {
      recordFailure(
        `docs/README.md responsibility table must own ${projectPath} exactly once; found ${count}`
      );
    }
  }
};

const verifyNoBackupArtifacts = async (allFiles: readonly string[]): Promise<void> => {
  for (const absolutePath of allFiles) {
    const projectPath = displayPath(absolutePath);
    if (
      (projectPath.startsWith("docs/") || projectPath.startsWith("requirements/")) &&
      /\.(?:bak|original|tmp)$/u.test(projectPath)
    ) {
      recordFailure(`backup or temporary artifact is not allowed in documentation: ${projectPath}`);
    }
  }
};

const lineNumberAt = (content: string, index: number): number =>
  content.slice(0, index).split("\n").length;

const verifyNoLegacyMarkers = async (allFiles: readonly string[]): Promise<void> => {
  for (const absolutePath of allFiles) {
    if (!TEXT_EXTENSIONS.has(extname(absolutePath))) {
      continue;
    }
    const content = await readFile(absolutePath, "utf8");
    for (const marker of LEGACY_MARKERS) {
      const match = marker.pattern.exec(content);
      if (match?.index !== undefined) {
        recordFailure(
          `${displayPath(absolutePath)}:${lineNumberAt(content, match.index)} contains ${marker.label}`
        );
      }
    }
  }
};

const githubHeadingSlug = (heading: string): string =>
  heading
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/<[^>]*>/gu, "")
    .replaceAll(/[`*_~]/gu, "")
    .replaceAll(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .trim()
    .replaceAll(/\s+/gu, "-")
    .replaceAll(/-+/gu, "-");

const markdownAnchors = (content: string): ReadonlySet<string> => {
  const anchors = new Set<string>();
  const slugCounts = new Map<string, number>();

  for (const line of content.split("\n")) {
    const match = /^(?:#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    const heading = match?.[1];
    if (!heading) {
      continue;
    }
    const baseSlug = githubHeadingSlug(heading);
    const count = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, count + 1);
    anchors.add(count === 0 ? baseSlug : `${baseSlug}-${count}`);
  }

  return anchors;
};

const decodeLinkPart = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
};

const verifyMarkdownLinks = async (allFiles: readonly string[]): Promise<void> => {
  const markdownFiles = allFiles.filter((absolutePath) => extname(absolutePath) === ".md");

  for (const sourcePath of markdownFiles) {
    const content = await readFile(sourcePath, "utf8");
    const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;

    for (const match of content.matchAll(linkPattern)) {
      const rawDestination = match[1]?.trim().replace(/^<|>$/gu, "");
      if (!rawDestination || /^[a-z][a-z0-9+.-]*:/iu.test(rawDestination)) {
        continue;
      }

      const hashIndex = rawDestination.indexOf("#");
      const rawPathWithQuery = hashIndex >= 0
        ? rawDestination.slice(0, hashIndex)
        : rawDestination;
      const rawFragment = hashIndex >= 0 ? rawDestination.slice(hashIndex + 1) : "";
      const rawPath = rawPathWithQuery.split("?", 1)[0] ?? "";
      const decodedPath = decodeLinkPart(rawPath);
      const decodedFragment = decodeLinkPart(rawFragment);
      const sourceLine = lineNumberAt(content, match.index ?? 0);

      if (decodedPath === undefined || decodedFragment === undefined) {
        recordFailure(`${displayPath(sourcePath)}:${sourceLine} has invalid URL encoding`);
        continue;
      }

      const targetPath = decodedPath.length === 0
        ? sourcePath
        : resolve(dirname(sourcePath), decodedPath);
      if (!await pathExists(targetPath)) {
        recordFailure(
          `${displayPath(sourcePath)}:${sourceLine} links to missing path: ${decodedPath}`
        );
        continue;
      }

      if (decodedFragment.length === 0) {
        continue;
      }
      const targetStat = await stat(targetPath);
      if (!targetStat.isFile() || extname(targetPath) !== ".md") {
        recordFailure(
          `${displayPath(sourcePath)}:${sourceLine} uses an anchor on a non-Markdown target`
        );
        continue;
      }
      const targetContent = await readFile(targetPath, "utf8");
      if (!markdownAnchors(targetContent).has(decodedFragment.toLowerCase())) {
        recordFailure(
          `${displayPath(sourcePath)}:${sourceLine} links to missing anchor #${decodedFragment}`
        );
      }
    }
  }
};

const reportResult = (): void => {
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`❌ ${failure}\n`);
    }
    process.stderr.write(`docs verification failed with ${failures.length} error(s).\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write("✅ docs: topology, adapters, legacy markers, and local links are valid\n");
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const writeRequested = args.length === 1 && args[0] === WRITE_ADAPTERS_ARG;
  if (args.length > 0 && !writeRequested) {
    recordFailure(`unknown arguments: ${args.join(" ")}`);
  }

  const agentsPath = resolve(ROOT, "AGENTS.md");
  if (!await pathExists(agentsPath)) {
    recordFailure("required path is missing: AGENTS.md");
    reportResult();
    return;
  }

  const agentsContent = await readFile(agentsPath, "utf8");
  if (writeRequested) {
    await writeAdapters(agentsContent);
  }

  await verifyRequiredPaths();
  await verifyRetiredPaths();
  await verifyAdapters(agentsContent);
  await verifyTaxonomyRows();

  const allFiles = await listFiles(ROOT);
  await verifyNoBackupArtifacts(allFiles);
  await verifyNoLegacyMarkers(allFiles);
  await verifyMarkdownLinks(allFiles);

  reportResult();
};

await main();
