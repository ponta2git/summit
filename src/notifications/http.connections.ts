import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { RESULT_NOTIFICATION_CONNECTION_CHECK_INTERVAL_MS, RESULT_NOTIFICATION_KEEP_ALIVE_TIMEOUT_MS,
  RESULT_NOTIFICATION_MAX_CONNECTIONS, RESULT_NOTIFICATION_MAX_REQUESTS_PER_SOCKET,
  RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "./config.ts";

/** Bound sockets independently of accepted DB work; shutdown only discards sockets awaiting headers. */
export const createNotificationHttpServer = (
  handleRequest: (request: IncomingMessage, response: ServerResponse) => void,
  isStopping: () => boolean
): { readonly server: Server; closeWaitingForHeaders(): void } => {
  const pendingHeaders = new Map<Socket, ReturnType<typeof setTimeout>>();
  const pendingResponses = new Map<Socket, number>();
  const waitForHeaders = (socket: Socket): void => {
    clearTimeout(pendingHeaders.get(socket));
    pendingHeaders.set(socket, setTimeout(() => socket.destroy(), RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS));
  };
  const server = createServer({ maxHeaderSize: 8_192,
    connectionsCheckingInterval: RESULT_NOTIFICATION_CONNECTION_CHECK_INTERVAL_MS,
    headersTimeout: RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS, requestTimeout: RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: RESULT_NOTIFICATION_KEEP_ALIVE_TIMEOUT_MS, keepAliveTimeoutBuffer: 1_000
  }, (request, response) => {
    const socket = request.socket;
    clearTimeout(pendingHeaders.get(socket));
    pendingHeaders.delete(socket);
    pendingResponses.set(socket, (pendingResponses.get(socket) ?? 0) + 1);
    response.once("finish", () => {
      const remaining = (pendingResponses.get(socket) ?? 1) - 1;
      pendingResponses.set(socket, remaining);
      // why: 再利用時の無通信・slow headerにも固定期限を置く。処理中のpipelineはNodeのheader期限が保護する。
      if (remaining === 0 && !socket.destroyed && !isStopping()) { waitForHeaders(socket); }
    });
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    handleRequest(request, response);
  });
  // why: Node の header timeout 検査周期に依存せず、認証前の無通信・slow header も接続時点から制限する。
  server.on("connection", socket => {
    if (isStopping()) { socket.destroy(); return; }
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
  return { server, closeWaitingForHeaders: () => {
    for (const [socket, deadline] of pendingHeaders) { clearTimeout(deadline); socket.destroy(); }
    pendingHeaders.clear();
  } };
};
