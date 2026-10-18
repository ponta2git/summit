import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { NotificationHttpError, readNotificationBody } from "../notifications/http.body.ts";
import type { MaintenanceDrain } from "./maintenanceDrain.ts";

export const MAINTENANCE_DRAIN_PATH = "/internal/maintenance/drain";
const requestSchema = z.object({
  cutoverId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  stopEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  stage: z.enum(["admission", "all"])
}).strict();

/** Called only after single-header operations-token authorization. Never awaits business drain. */
export const routeMaintenanceDrain = async (
  request: IncomingMessage, maintenance: MaintenanceDrain
): Promise<{ readonly status: number; readonly body: unknown }> => {
  if (request.method === "GET") { return { status: 200, body: maintenance.snapshot() }; }
  if (request.method !== "POST") { throw new NotificationHttpError(405, "method_not_allowed"); }
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new NotificationHttpError(400, "invalid_content_type");
  }
  const length = Number(request.headers["content-length"]);
  if (length > 512) { throw new NotificationHttpError(413, "payload_too_large"); }
  const body = await readNotificationBody(request, 512);
  let value: unknown;
  try { value = JSON.parse(body); }
  catch { throw new NotificationHttpError(400, "invalid_input"); }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) { throw new NotificationHttpError(400, "invalid_input"); }
  if (maintenance.request(parsed.data) === "conflict") { throw new NotificationHttpError(409, "cutover_conflict"); }
  return { status: 202, body: maintenance.snapshot() };
};
