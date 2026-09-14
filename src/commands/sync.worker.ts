import { getSyncExitCode, isFlyEnvironment, parseSyncOptions, type SyncReport } from "./sync.protocol.ts";

// invariant: SDK import 前に実行場所・親所有権を検査。単独起動や Fly 内の旧運用経路を許可しない。
if (isFlyEnvironment(process.env) || !process.send || !process.connected) { process.exit(1); }
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
process.once("disconnect", () => process.exit(1));

let report: SyncReport;
let applying = false;
try {
  const options = parseSyncOptions(process.argv.slice(2));
  const { readSyncSettings } = await import("./sync.settings.ts");
  const settings = options ? await readSyncSettings(options, process.env) : undefined;
  if (!settings) { report = { status: "failed", reason: "invalid_settings" }; }
  else {
    applying = !settings.check;
    const { runCommandSync } = await import("./sync.run.ts");
    report = await runCommandSync(settings, controller.signal);
  }
} catch { report = { status: applying ? "unknown" : "failed", reason: "worker_failed" }; }

// why: 単発 CLI の終了境界。IPC 送達後に終了し、SDK 内部の rate-limit timer を残さない。
process.send(report, error => process.exit(error ? 1 : getSyncExitCode(report)));
