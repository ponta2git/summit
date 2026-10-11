import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { RESULT_NOTIFICATION_MAX_CONNECTIONS, RESULT_NOTIFICATION_MAX_RECEIPTS, RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../config.ts";
import { NotificationInputError } from "../domain/resultNotificationPayload.ts";
import { NotificationHttpError, notificationBodyReservation } from "./http.body.ts";
import { authorizeNotificationRequest, routeNotificationRequest, type NotificationHttpDeps } from "./http.routes.ts";
import { isPrivateNotificationBind, RESULT_NOTIFICATION_BODY_BUDGET_BYTES, RESULT_NOTIFICATION_CONNECTION_CHECK_INTERVAL_MS,
  RESULT_NOTIFICATION_KEEP_ALIVE_TIMEOUT_MS, RESULT_NOTIFICATION_MAX_REQUESTS_PER_SOCKET } from "./config.ts";

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
  const pendingHeaders = new Map<Socket, ReturnType<typeof setTimeout>>();
  const pendingResponses = new Map<Socket, number>();
  let stopped = false;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const waitForHeaders = (socket: Socket): void => {
    clearTimeout(pendingHeaders.get(socket));
    pendingHeaders.set(socket, setTimeout(() => socket.destroy(), RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS));
  };
  const server = createServer({ maxHeaderSize: 8_192,
    connectionsCheckingInterval: RESULT_NOTIFICATION_CONNECTION_CHECK_INTERVAL_MS,
    headersTimeout: RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS, requestTimeout: RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: RESULT_NOTIFICATION_KEEP_ALIVE_TIMEOUT_MS, keepAliveTimeoutBuffer: 1_000
  }, (request, response) => {
    clearTimeout(pendingHeaders.get(request.socket));
    pendingHeaders.delete(request.socket);
    const socket = request.socket;
    pendingResponses.set(socket, (pendingResponses.get(socket) ?? 0) + 1);
    response.once("finish", () => {
      const remaining = (pendingResponses.get(socket) ?? 1) - 1;
      pendingResponses.set(socket, remaining);
      // why: 再利用時の無通信・slow headerにも固定期限を置く。処理中のpipelineはNodeのheader期限が保護する。
      if (remaining === 0 && !socket.destroyed && !stopped) { waitForHeaders(socket); }
    });
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
  });
  // why: Node の header timeout 検査周期に依存せず、認証前の無通信・slow header も接続時点から制限する。
  server.on("connection", socket => {
    if (stopped) { socket.destroy(); return; }
    waitForHeaders(socket);
    socket.once("close", () => {
      clearTimeout(pendingHeaders.get(socket)); pendingHeaders.delete(socket); pendingResponses.delete(socket);
    });
  });
  server.maxConnections = RESULT_NOTIFICATION_MAX_CONNECTIONS;
  server.maxRequestsPerSocket = RESULT_NOTIFICATION_MAX_REQUESTS_PER_SOCKET;
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
