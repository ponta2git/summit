import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../src/db/schema.ts";
import { logger } from "../../src/logger.ts";
import { requireRecorderDatabase } from "./resultNotificationRecorder.config.ts";

const database = requireRecorderDatabase(process.env["TEST_DATABASE_URL"]);
const directory = process.env["MOM24_RUN_DIR"];
const token = process.env["RESULT_NOTIFICATION_TOKEN"];
const operationsToken = process.env["RESULT_NOTIFICATION_OPERATIONS_TOKEN"];
const webOrigin = process.env["RESULT_NOTIFICATION_WEB_ORIGIN"];
if (!directory || !token || !operationsToken || !webOrigin) {
  throw new Error("Recorder requires an owned run directory and explicit notification test configuration.");
}
Object.assign(process.env, {
  NODE_ENV: "test", TZ: "Asia/Tokyo", DISCORD_TOKEN: "record-only-no-login", DATABASE_URL: database.href,
  SUMMIT_CONFIG_YAML: await readFile(new URL("../../summit.config.example.yml", import.meta.url), "utf8")
});
// why: runtime の config import より先に、公開fixtureだけを注入する。
const { createResultNotificationRecorder } = await import("./resultNotificationRecorder.runtime.ts");
const root = resolve(directory);
await mkdir(root, { recursive: true });
const readyPath = join(root, "summit-ready.json");
const messagesPath = join(root, "summit-messages.jsonl");
// invariant: 再実行で前回の送信を成功証拠にしない。実行ごとの専用directoryを使う。
await writeFile(messagesPath, "", { flag: "wx", mode: 0o600 });
const client = postgres(database.href, { prepare: false, max: 4, onnotice: () => undefined });
const runtime = createResultNotificationRecorder({
  db: drizzle(client, { schema, casing: "snake_case" }), token, operationsToken, webOrigin,
  record: message => appendFile(messagesPath, `${JSON.stringify(message)}\n`)
});
let closing: Promise<void> | undefined;
let readyOwned = false;
const close = (): Promise<void> => closing ??= (async () => {
  const errors: unknown[] = [];
  try { runtime.stop(); } catch (error) { errors.push(error); }
  try { await runtime.drain(); } catch (error) { errors.push(error); }
  const released = await Promise.allSettled([client.end({ timeout: 5 }), readyOwned ? rm(readyPath, { force: true }) : Promise.resolve()]);
  for (const result of released) { if (result.status === "rejected") { errors.push(result.reason); } }
  if (errors.length > 0) { throw new Error("Recorder resource cleanup failed."); }
})();
const stop = (): void => { void close().then(() => { process.exitCode = 0; return undefined; }, () => {
  logger.error({ event: "notification_recorder.cleanup_failed" }); process.exitCode = 1; return undefined;
}); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await client`SELECT 1 FROM discord_notifications LIMIT 0`;
  await runtime.start();
  const address = runtime.address();
  if (!address) { throw new Error("Recorder did not bind its listener."); }
  await writeFile(readyPath, JSON.stringify({ origin: `http://127.0.0.1:${address.port}` }), { flag: "wx", mode: 0o600 });
  readyOwned = true;
  runtime.wake("recorder_startup");
} catch {
  await close();
  process.exitCode = 1;
  logger.error({ event: "notification_recorder.startup_failed" });
}
