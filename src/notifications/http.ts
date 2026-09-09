import { createServer, type Server, type ServerResponse } from "node:http";
import { RESULT_NOTIFICATION_MAX_CONNECTIONS, RESULT_NOTIFICATION_MAX_RECEIPTS, RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../config.ts";
import { NotificationInputError } from "../domain/resultNotificationPayload.ts";
import { NotificationHttpError } from "./http.body.ts";
import { authorizeNotificationRequest, routeNotificationRequest, type NotificationHttpDeps } from "./http.routes.ts";
import { isPrivateNotificationBind } from "./config.ts";

const respond = (response: ServerResponse, status: number, value: unknown): void => {
  if (response.destroyed || response.writableEnded) { return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "connection": "close" });
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
  let stopped = false;
  let closing: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 8_192 }, (request, response) => {
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    void (async () => {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const path = authorizeNotificationRequest(request, deps);
        if (stopped || !deps.canAccept() || active.size >= RESULT_NOTIFICATION_MAX_RECEIPTS) {
          throw new NotificationHttpError(503, "unavailable");
        }
        const work = routeNotificationRequest(request, path, deps);
        active.add(work);
        // A response deadline does not release the slot while its DB command is
        // still running, and never cancels a commit that may already have happened.
        void work.finally(() => active.delete(work)).catch(() => undefined);
        const result = await Promise.race([work, new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new NotificationHttpError(503, "request_timeout")), RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS);
        })]);
        respond(response, result.status, result.body);
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
  });
  server.maxConnections = RESULT_NOTIFICATION_MAX_CONNECTIONS;
  server.headersTimeout = RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS;
  server.requestTimeout = RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); }
  });
  return {
    server,
    start: async (host, port) => {
      if (!isPrivateNotificationBind(host)) { throw new Error("Notification receiver requires a private or loopback bind"); }
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error); };
        server.once("error", failed);
        server.listen({ host, port, ipv6Only: true }, () => { server.off("error", failed); resolve(); });
      });
    },
    stop: () => {
      if (stopped) { return; }
      stopped = true;
      closing = new Promise(resolve => { server.close(() => resolve()); });
    },
    drain: async () => { await Promise.allSettled([...active]); await closing; }
  };
};
