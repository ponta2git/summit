import { env } from "./env.ts";

// invariant: frozen must branch before importing any business bootstrap or Discord client.
if (env.MOMO_MAINTENANCE_MODE === "frozen") {
  await import("./startup/frozen.ts");
} else {
  await import("./startup/normal.ts");
}
