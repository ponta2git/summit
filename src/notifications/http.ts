import type { Server, ServerResponse } from "node:http";
import { RESULT_NOTIFICATION_MAX_RECEIPTS, RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../config.ts";
import { NotificationInputError } from "../domain/resultNotificationPayload.ts";
import { NotificationHttpError, notificationBodyReservation } from "./http.body.ts";
import { authorizeNotificationRequest, routeNotificationRequest, type NotificationHttpDeps } from "./http.routes.ts";
import { isPrivateNotificationBind, RESULT_NOTIFICATION_BODY_BUDGET_BYTES } from "./config.ts";
import { createNotificationHttpServer } from "./http.connections.ts";

const respond = (response: ServerResponse, status: number, value: unknown, reusable = false): void => {
  if (response.destroyed || response.writableEnded) { return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    ...(!reusable ? { connection: "close" } : {}) });
  response.end(JSON.stringify(value));
};

export interface NotificationReceiver {
  readonly server: Server;
  start(host: string, port: number): Promise<void>;
  stop(): void;
  drain(): Promise<void>;
}

/** Receipt readiness depends on startup/DB acceptance, not Discord connectivity. */
export const createNotificationReceiver = (deps: NotificationHttpDeps): NotificationReceiver => {
  const active = new Set<Promise<unknown>>();
  let reservedBodyBytes = 0;
  let stopped = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const { server, closeWaitingForHeaders } = createNotificationHttpServer((request, response) => {
    void (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const path = authorizeNotificationRequest(request, deps);
        const bodyBytes = notificationBodyReservation(request);
        if (stopped || !deps.canAccept() || active.size >= RESULT_NOTIFICATION_MAX_RECEIPTS
          || bodyBytes > RESULT_NOTIFICATION_BODY_BUDGET_BYTES - reservedBodyBytes) {
          throw new NotificationHttpError(503, "unavailable");
        }
        const work = routeNotificationRequest(request, path, deps);
        active.add(work);
        reservedBodyBytes += bodyBytes;
        // A response deadline does not release the slot while its DB command is
        // still running, and never cancels a commit that may already have happened.
        void work.finally(() => { active.delete(work); reservedBodyBytes -= bodyBytes; }).catch(() => undefined);
        const result = await Promise.race([work, new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new NotificationHttpError(503, "request_timeout")), RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS);
        })]);
        // invariant: 本文を消費しない操作にbodyが付いた場合も再利用せず、次のrequestとの境界を保つ。
        const bodyConsumed = request.readableEnded
          || (request.headers["transfer-encoding"] === undefined && Number(request.headers["content-length"] ?? 0) === 0);
        respond(response, result.status, result.body, !stopped && bodyConsumed);
      } catch (error: unknown) {
        if (error instanceof NotificationHttpError) { respond(response, error.status, { error: error.code }); }
        else if (error instanceof NotificationInputError) {
          const status = { invalid_input: 400, unsupported_version: 422, identity_conflict: 409, payload_too_large: 413 }[error.code];
          respond(response, status, { error: error.code });
        } else {
          deps.logger.warn({ event: "result_notification.receipt_unavailable" });
          respond(response, 503, { error: "unavailable" });
        }
      } finally { clearTimeout(deadline); }
    })();
  }, () => stopped);
  return {
    server,
    start: async (host, port) => {
      if (!isPrivateNotificationBind(host)) { throw new Error("Notification receiver requires a private or loopback bind"); }
      if (stopped) { throw new Error("Notification receiver is stopped"); }
      if (starting) { throw new Error("Notification receiver has already started"); }
      starting = new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error); };
        server.once("error", failed);
        server.listen({ host, port, ipv6Only: true }, () => { server.off("error", failed); resolve(); });
      });
      await starting;
      if (stopped) { await closing; }
    },
    stop: () => {
      if (stopped) { return; }
      stopped = true;
      closeWaitingForHeaders();
      // race: 非同期listenの完了前にcloseすると、開始callbackが完了しない場合がある。
      closing = (starting ?? Promise.resolve()).catch(() => undefined)
        .then(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
    },
    drain: async () => { await Promise.allSettled([...active]); await closing; }
  };
};
