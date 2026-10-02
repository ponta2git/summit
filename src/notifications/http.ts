import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { RESULT_NOTIFICATION_MAX_CONNECTIONS, RESULT_NOTIFICATION_MAX_RECEIPTS, RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../config.ts";
import { NotificationInputError } from "../domain/resultNotificationPayload.ts";
import { NotificationHttpError, notificationBodyReservation } from "./http.body.ts";
import { authorizeNotificationRequest, routeNotificationRequest, type NotificationHttpDeps } from "./http.routes.ts";
import { isPrivateNotificationBind, RESULT_NOTIFICATION_BODY_BUDGET_BYTES } from "./config.ts";

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
  let reservedBodyBytes = 0;
  const pendingHeaders = new Map<Socket, ReturnType<typeof setTimeout>>();
  let stopped = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const server = createServer({ maxHeaderSize: 8_192 }, (request, response) => {
    clearTimeout(pendingHeaders.get(request.socket));
    pendingHeaders.delete(request.socket);
    request.on("error", () => undefined);
    response.on("error", () => undefined);
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
  // why: Node の header timeout 検査周期に依存せず、認証前の無通信・slow header も接続時点から制限する。
  server.on("connection", socket => {
    if (stopped) { socket.destroy(); return; }
    const deadline = setTimeout(() => socket.destroy(), RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS);
    pendingHeaders.set(socket, deadline);
    socket.once("close", () => { clearTimeout(deadline); pendingHeaders.delete(socket); });
  });
  server.maxConnections = RESULT_NOTIFICATION_MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 1;
  server.headersTimeout = RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS;
  server.requestTimeout = RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); }
  });
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
      for (const [socket, deadline] of pendingHeaders) { clearTimeout(deadline); socket.destroy(); }
      pendingHeaders.clear();
      // race: 非同期listenの完了前にcloseすると、開始callbackが完了しない場合がある。
      closing = (starting ?? Promise.resolve()).catch(() => undefined)
        .then(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
    },
    drain: async () => { await Promise.allSettled([...active]); await closing; }
  };
};
