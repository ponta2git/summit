import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Logger } from "pino";
import { z } from "zod";
import type { ResultNotificationsPort } from "../db/ports.resultNotifications.ts";
import type { Clock } from "../time/index.ts";
import { readNotificationBody, NotificationHttpError } from "./http.body.ts";
import { RESULT_NOTIFICATION_MAX_BODY_BYTES } from "../config.ts";

export interface NotificationHttpResult { readonly status: number; readonly body: unknown; }
export interface NotificationHttpDeps {
  readonly port: ResultNotificationsPort;
  readonly clock: Clock;
  readonly token: string;
  readonly operationsToken: string;
  readonly canAccept: () => boolean;
  readonly wake: (reason: string) => void;
  readonly logger: Pick<Logger, "info" | "warn" | "error">;
}

const authenticated = (header: string | undefined, secret: string): boolean => {
  if (!header?.startsWith("Bearer ")) { return false; }
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(secret));
};

export const authorizeNotificationRequest = (request: IncomingMessage, deps: NotificationHttpDeps): string => {
  let path: string;
  try { path = new URL(request.url ?? "", "http://localhost").pathname; }
  catch { throw new NotificationHttpError(400, "invalid_input"); }
  const receipt = path === "/internal/discord-notifications" && request.method === "POST";
  if (!authenticated(request.headers.authorization, receipt ? deps.token : deps.operationsToken)) {
    throw new NotificationHttpError(401, "unauthorized");
  }
  return path;
};

const jsonBody = async (request: IncomingMessage): Promise<string> => {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new NotificationHttpError(400, "invalid_content_type");
  }
  const length = Number(request.headers["content-length"]);
  if (Number.isFinite(length) && length < 0) { throw new NotificationHttpError(400, "invalid_input"); }
  if (length > RESULT_NOTIFICATION_MAX_BODY_BYTES) { throw new NotificationHttpError(413, "payload_too_large"); }
  return readNotificationBody(request);
};

const safeWake = (deps: NotificationHttpDeps, reason: string): void => {
  try { deps.wake(reason); }
  catch { deps.logger.warn({ event: "result_notification.wake_failed", reason }); }
};

export const routeNotificationRequest = async (
  request: IncomingMessage, path: string, deps: NotificationHttpDeps
): Promise<NotificationHttpResult> => {
  if (path === "/internal/discord-notifications" && request.method === "POST") {
    const receipt = await deps.port.receive(await jsonBody(request), deps.clock.now());
    // The port only resolves after commit. Neither a disconnected caller nor a
    // lost wake can change the durable receipt into a delivery failure.
    deps.logger.info({ event: "result_notification.received", ...receipt });
    safeWake(deps, "receipt_committed");
    return { status: receipt.disposition === "accepted" ? 202 : 200, body: receipt };
  }
  const setting = /^\/internal\/discord-notifications\/settings\/(ocr_completed|analysis_completed)$/.exec(path);
  if (setting) {
    const kind = setting[1] === "ocr_completed" ? "ocr_completed" : "analysis_completed";
    if (request.method === "GET") { return { status: 200, body: await deps.port.getSetting(kind) }; }
    if (request.method === "PATCH") {
      let value: unknown;
      try { value = JSON.parse(await jsonBody(request)); }
      catch (error) { if (error instanceof NotificationHttpError) { throw error; } throw new NotificationHttpError(400, "invalid_input"); }
      const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(value);
      if (!parsed.success) { throw new NotificationHttpError(400, "invalid_input"); }
      const changed = await deps.port.setSetting(kind, parsed.data.enabled, deps.clock.now());
      deps.logger.info({ event: "result_notification.setting_changed", ...changed });
      safeWake(deps, "setting_committed");
      return { status: 200, body: changed };
    }
  }
  const target = /^\/internal\/discord-notifications\/([^/]+)(\/retry)?$/.exec(path);
  if (target?.[1]) {
    let id: string;
    try { id = decodeURIComponent(target[1]); } catch { throw new NotificationHttpError(400, "invalid_input"); }
    if (!/^result:(ocr_completed|analysis_completed):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
      throw new NotificationHttpError(400, "invalid_input");
    }
    if (!target[2] && request.method === "GET") {
      const state = await deps.port.inspect(id);
      if (!state) { throw new NotificationHttpError(404, "not_found"); }
      return { status: 200, body: state };
    }
    if (target[2] && request.method === "POST") {
      const queued = await deps.port.retry(id, deps.clock.now());
      if (!queued) { throw new NotificationHttpError(409, "retry_ineligible"); }
      deps.logger.info({ event: "result_notification.retry_queued", notificationId: id });
      safeWake(deps, "retry_committed");
      return { status: 200, body: { notificationId: id, queued: true } };
    }
  }
  throw new NotificationHttpError(404, "not_found");
};
