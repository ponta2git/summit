import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";
import { databaseUrl, dropOwnedDatabase, newDatabasePrefix, requireLocalTestUrl } from "../../tests/integration/databaseLifecycle.ts";
import { seedCapacitySources } from "../verify/notificationCapacity.fixtures.ts";
import { CapacityError } from "../verify/notificationCapacity.contract.ts";
import { performanceStage } from "./notificationPerformance.diagnostics.ts";

export const performanceRoot = new URL("../../", import.meta.url);
const execute = promisify(execFile);
const command = async (program: string, args: readonly string[], cwd = fileURLToPath(performanceRoot)): Promise<string> =>
  (await execute(program, [...args], { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout.trim();

export const createPerformanceOutput = async (directory: string): Promise<void> => {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  // Never reuse an old artifact directory, including a symlink to one.
  await mkdir(directory, { mode: 0o700 });
};

export const writePerformanceArtifact = async (directory: string, filename: string, value: unknown): Promise<void> => {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(filename)) { throw new CapacityError("setup_or_measurement", "artifact_name"); }
  await performanceStage("persist", () => writeFile(join(directory, filename), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }));
};

export const performanceProvenance = async (image: string) => {
  const [imageId, imagePlatform, sourceCommit, sourceStatus, schemaCommit, lockfile, manifest, dockerInfo] = await Promise.all([
    command("docker", ["image", "inspect", "--format", "{{.Id}}", image]),
    command("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image]),
    command("git", ["rev-parse", "HEAD"]), command("git", ["status", "--porcelain=v1"]),
    command("git", ["rev-parse", "HEAD"], fileURLToPath(new URL("../momo-db/", performanceRoot))),
    readFile(new URL("pnpm-lock.yaml", performanceRoot)), readFile(new URL("package.json", performanceRoot), "utf8"),
    command("docker", ["info", "--format", "{{json .}}"])
  ]);
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || !/^[a-f0-9]{40,64}$/.test(sourceCommit)
    || !/^[a-f0-9]{40,64}$/.test(schemaCommit)) { throw new CapacityError("setup_or_measurement", "provenance"); }
  const engine = z.object({ ServerVersion: z.string(), OperatingSystem: z.string(), Architecture: z.string(),
    NCPU: z.number().positive(), MemTotal: z.number().positive(), CgroupVersion: z.string(), KernelVersion: z.string() }).parse(JSON.parse(dockerInfo));
  const packageInfo = z.object({ version: z.string(), dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(manifest));
  return { image: { requested: image, id: imageId, platform: imagePlatform }, sourceCommit,
    workingTreeDirty: sourceStatus.length > 0, schemaCommit,
    lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
    hostRuntime: { node: process.version, platform: process.platform, arch: process.arch },
    docker: engine, package: packageInfo };
};

const connect = (url: string) => postgres(url, { max: 1, prepare: false, connect_timeout: 5,
  onnotice: () => undefined, connection: { statement_timeout: 30_000, lock_timeout: 5_000 } });

/** Every run owns a fresh database. No reset, TRUNCATE or source mutation is
 * issued against the operator's supplied administration database. */
export const withPerformanceDatabase = async <T>(adminUrl: string, run: (context: {
  readonly url: string; readonly client: postgres.Sql; readonly version: string;
}) => Promise<T>, options: { readonly signal?: AbortSignal } = {}): Promise<T> => {
  options.signal?.throwIfAborted();
  const checked = requireLocalTestUrl(adminUrl).href;
  const prefix = newDatabasePrefix();
  const name = `${prefix}_performance`;
  const admin = connect(checked);
  const url = databaseUrl(checked, name);
  let client: postgres.Sql | undefined;
  let failure: unknown;
  let result: { value: T } | undefined;
  let cleanupFailed = false;
  try {
    options.signal?.throwIfAborted();
    await performanceStage("database_create", async () => admin`CREATE DATABASE ${admin(name)}`);
    options.signal?.throwIfAborted();
    client = connect(url);
    const owned = client;
    await performanceStage("database_migrate", () => migrate(drizzle(owned), { migrationsFolder: fileURLToPath(new URL("../momo-db/drizzle/", performanceRoot)) }));
    options.signal?.throwIfAborted();
    await performanceStage("database_seed", () => seedCapacitySources(owned));
    options.signal?.throwIfAborted();
    const [server] = await client<{ version: string }[]>`SELECT version() AS version`;
    if (!server) { throw new CapacityError("setup_or_measurement", "database_version"); }
    options.signal?.throwIfAborted();
    result = { value: await run({ url, client, version: server.version }) };
    options.signal?.throwIfAborted();
  } catch (error) { failure = error; }
  finally {
    await client?.end({ timeout: 5 }).catch(() => { cleanupFailed = true; });
    await dropOwnedDatabase(admin, name, prefix).catch(() => { cleanupFailed = true; });
    await admin.end({ timeout: 5 }).catch(() => { cleanupFailed = true; });
  }
  if (cleanupFailed) { throw new CapacityError("setup_or_measurement", "database_cleanup"); }
  if (failure !== undefined) { throw failure; }
  if (!result) { throw new CapacityError("setup_or_measurement", "database_run"); }
  return result.value;
};
