import { runNotificationCli } from "./cli.run.ts";

void runNotificationCli(process.argv.slice(2), process.env).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Notification operation failed"}\n`);
  process.exitCode = 1;
});
