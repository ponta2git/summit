import { logger } from "../logger.ts";
import { getSyncExitCode } from "./sync.protocol.ts";
import { superviseCommandSync } from "./sync.supervisor.ts";

const controller = new AbortController();
const interrupt = (): void => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const result = await superviseCommandSync(process.argv.slice(2), process.env, { signal: controller.signal });
  const exitCode = getSyncExitCode(result);
  logger[exitCode === 0 ? "info" : "error"]({ event: "commands.sync", ...result },
    "Command sync finished; check registration before retrying an unknown result.");
  process.exitCode = exitCode;
} catch {
  logger.error({ event: "commands.sync", status: "unknown", reason: "worker_failed" },
    "Command sync could not finish; check registration before retrying.");
  process.exitCode = 3;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
