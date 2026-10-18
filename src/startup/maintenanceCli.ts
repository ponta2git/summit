import { runMaintenanceCli } from "./maintenanceCli.run.ts";

void runMaintenanceCli(process.argv.slice(2), process.env).catch(() => {
  process.stderr.write("Maintenance command failed; inspect process state before retrying\n");
  process.exitCode = 1;
});
