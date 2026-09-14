import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getSyncExitCode, isFlyEnvironment, parseSyncOptions, parseSyncReport,
  SYNC_DEADLINE_MS, SYNC_EXIT_GRACE_MS, type SyncReport } from "./sync.protocol.ts";

interface SupervisorOptions {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly graceMs?: number;
  readonly worker?: URL;
}

export const superviseCommandSync = async (
  args: readonly string[], environment: Readonly<NodeJS.ProcessEnv>, options: SupervisorOptions = {}
): Promise<SyncReport> => {
  if (isFlyEnvironment(environment)) { return { status: "failed", reason: "fly_environment" }; }
  const command = parseSyncOptions(args);
  if (!command) { return { status: "failed", reason: "usage" }; }
  if (options.signal?.aborted) { return { status: "failed", reason: "cancelled" }; }
  const worker = options.worker ?? new URL(import.meta.url.endsWith(".ts") ? "./sync.worker.ts" : "./sync.worker.js", import.meta.url);
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const key of ["DISCORD_TOKEN", "DISCORD_APPLICATION_ID", "DISCORD_GUILD_ID", ...(command.production ? [] : ["SUMMIT_CONFIG_YAML"])]) {
    if (environment[key] !== undefined) { childEnv[key] = environment[key]; }
  }
  return new Promise(resolve => {
    // secret: shell/execArgv は継承せず、token は環境経由のみ。worker の生 stdout/stderr も転送しない。
    const child = spawn(process.execPath, [fileURLToPath(worker), ...args], {
      env: childEnv, stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
    let report: SyncReport | undefined;
    let stopped: "deadline_exceeded" | "cancelled" | undefined;
    let closed = false;
    let disconnected = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: "deadline_exceeded" | "cancelled"): void => {
      if (closed || stopped) { return; }
      stopped = reason;
      if (!exit) { child.kill("SIGTERM"); }
      grace = setTimeout(() => { if (!closed && !exit) { child.kill("SIGKILL"); } }, options.graceMs ?? SYNC_EXIT_GRACE_MS);
    };
    const deadline = setTimeout(() => stop("deadline_exceeded"), options.deadlineMs ?? SYNC_DEADLINE_MS);
    const abort = (): void => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("message", (message: unknown) => { report = parseSyncReport(message); });
    child.on("error", () => { report = { status: "failed", reason: "worker_failed" }; });
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (closed) { return; }
      closed = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      options.signal?.removeEventListener("abort", abort);
      // why: write 到達前に親が停止した可能性も含め、apply の異常終了は保守的に結果不明とする。
      if (stopped) { resolve({ status: command.check ? "failed" : "unknown", reason: stopped }); }
      else if (!signal && report && code === getSyncExitCode(report)) { resolve(report); }
      else { resolve({ status: command.check ? "failed" : "unknown", reason: "worker_failed" }); }
    };
    child.once("close", finish);
    // why: 親から IPC を切った場合の close 欠落も扱う。stdio は ignore なので exit + disconnect で回収完了。
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      if (disconnected) { finish(code, signal); }
    });
    child.once("disconnect", () => {
      disconnected = true;
      if (exit) { finish(exit.code, exit.signal); }
    });
  });
};
