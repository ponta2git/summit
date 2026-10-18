import { Readable } from "node:stream";
import { z } from "zod";
import { isNotificationToken, isPrivateNotificationBind, RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS,
  RESULT_NOTIFICATION_DEFAULT_PORT } from "../notifications/config.ts";

const usage = "Usage: maintenance readiness | status | drain <cutover-id> <stop-epoch> <admission|all>";
const cutoverId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const stopEpoch = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const stage = z.enum(["admission", "all"]);
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/);
const readinessSchema = z.object({
  service: z.literal("summit"), mode: z.literal("frozen"), ready: z.literal(true), contract: z.literal("summit-read-schema-v1"),
  database: z.object({ formatVersion: z.literal(1), targetFingerprint: fingerprint, ledgerFingerprint: fingerprint }).strict()
}).strict();
const writerStages = {
  startup: "admission", discord_interactions: "admission", reconnect_recovery: "admission", scheduler: "admission",
  ask_sends: "admission", notification_operations: "admission", result_notifications: "all"
} as const;
const drainSchema = z.object({
  consumer: z.literal("summit"), scope: z.literal("process"), cutoverId: cutoverId.nullable(), stopEpoch: stopEpoch.nullable(),
  stage: stage.nullable(), phase: z.enum(["running", "draining", "drained", "timed_out", "failed"]),
  writers: z.array(z.object({
    name: z.enum(Object.keys(writerStages) as [keyof typeof writerStages, ...(keyof typeof writerStages)[]]), stage,
    status: z.enum(["active", "draining", "drained", "timed_out", "failed"]),
    failure: z.enum(["stop_failed", "drain_failed", "drain_timeout"]).optional()
  }).strict()).length(Object.keys(writerStages).length)
}).strict().refine(value => new Set(value.writers.map(writer => writer.name)).size === Object.keys(writerStages).length
  && value.writers.every(writer => writer.stage === writerStages[writer.name]));

const readResponse = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    await response.body?.cancel();
    throw new Error("Invalid maintenance response");
  }
  const body = Readable.fromWeb(response.body);
  const abort = (): void => { body.destroy(new Error("Maintenance response timed out")); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) { abort(); }
  try {
    const bytes = Buffer.alloc(8192);
    let length = 0;
    const stream: AsyncIterable<unknown> = body;
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array) || chunk.length > bytes.length - length) { throw new Error("Invalid maintenance response"); }
      bytes.set(chunk, length); length += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as unknown;
  } finally { signal.removeEventListener("abort", abort); body.destroy(); }
};

/** Runs in the target machine; credentials stay in its environment and never enter command arguments. */
export const runMaintenanceCli = async (
  args: readonly string[], environment: Readonly<Record<string, string | undefined>>,
  output: (text: string) => void = text => process.stdout.write(`${text}\n`)
): Promise<void> => {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) { output(usage); return; }
  try {
    const [action, id, epoch, requestedStage] = args;
    if (!((args.length === 1 && (action === "readiness" || action === "status"))
      || (args.length === 4 && action === "drain" && /^[1-9][0-9]*$/.test(epoch ?? "")))) { throw new Error(usage); }
    const request = action === "drain"
      ? z.object({ cutoverId, stopEpoch, stage }).strict().parse({ cutoverId: id, stopEpoch: Number(epoch), stage: requestedStage })
      : undefined;
    const token = environment["RESULT_NOTIFICATION_OPERATIONS_TOKEN"];
    const host = environment["RESULT_NOTIFICATION_BIND_HOST"] ?? "fly-local-6pn";
    const port = environment["RESULT_NOTIFICATION_PORT"] ?? String(RESULT_NOTIFICATION_DEFAULT_PORT);
    if (!token || !isNotificationToken(token) || !isPrivateNotificationBind(host)
      || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) { throw new Error("Invalid maintenance configuration"); }
    const path = action === "readiness" ? "readiness" : "drain";
    const url = new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}/internal/maintenance/${path}`);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS);
    try {
      const response = await fetch(url, { method: request ? "POST" : "GET", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(request ? { body: JSON.stringify(request) } : {}) });
      const value = await readResponse(response, controller.signal);
      if (action === "readiness") { output(JSON.stringify(readinessSchema.parse(value))); }
      else {
        const state = drainSchema.parse(value);
        if (request && (state.cutoverId !== request.cutoverId || state.stopEpoch !== request.stopEpoch || state.stage !== request.stage)) {
          throw new Error("Mismatched maintenance response");
        }
        output(JSON.stringify(state));
      }
    } finally { clearTimeout(deadline); }
  } catch { throw new Error("Maintenance command failed; inspect process state before retrying"); }
};
