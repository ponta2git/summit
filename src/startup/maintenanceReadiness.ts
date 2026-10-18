import { createHash, timingSafeEqual } from "node:crypto";
import type { Server, ServerResponse } from "node:http";
import { createNotificationHttpServer } from "../notifications/http.connections.ts";
import { isNotificationToken, isPrivateNotificationBind, RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS } from "../notifications/config.ts";
import type { MaintenanceConnectionProof } from "./maintenanceConnectionProof.ts";

interface MaintenanceReadiness {
  readonly server: Server;
  start(host: string, port: number): Promise<void>;
  stop(): void;
  drain(): Promise<void>;
}

const respond = (response: ServerResponse, status: number, body: unknown): void => {
  if (response.destroyed || response.writableEnded) { return; }
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", connection: "close" });
  response.end(JSON.stringify(body));
};

/** Frozen exposes only an authenticated, bounded read probe; business endpoints cannot execute. */
export const createMaintenanceReadiness = (
  operationsToken: string, probe: () => Promise<MaintenanceConnectionProof>
): MaintenanceReadiness => {
  if (!isNotificationToken(operationsToken)) { throw new Error("Maintenance readiness requires an operations token"); }
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  const tokenDigest = digest(operationsToken);
  const state = { service: "summit", mode: "frozen", contract: "summit-read-schema-v1" } as const;
  let stopped = false;
  let active: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const { server, closeWaitingForHeaders } = createNotificationHttpServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/internal/maintenance/readiness") {
      respond(response, 503, { error: "maintenance_frozen" }); return;
    }
    const authorization = request.headers.authorization;
    if (request.headersDistinct["authorization"]?.length !== 1 || !authorization?.startsWith("Bearer ")
      || !timingSafeEqual(digest(authorization.slice(7)), tokenDigest)) {
      respond(response, 401, { error: "unauthorized" }); return;
    }
    if (request.headers["transfer-encoding"] !== undefined || Number(request.headers["content-length"] ?? 0) !== 0) {
      respond(response, 400, { error: "invalid_input" }); return;
    }
    if (stopped || active) { respond(response, 503, { ...state, ready: false }); return; }
    const deadline = setTimeout(() => respond(response, 503, { ...state, ready: false }), RESULT_NOTIFICATION_REQUEST_TIMEOUT_MS);
    // Keep ownership even after the response deadline or caller disconnects.
    active = Promise.resolve().then(probe).then(database => {
      respond(response, stopped ? 503 : 200, { ...state, ready: !stopped, database });
      return undefined;
    }, () => { respond(response, 503, { ...state, ready: false }); return undefined; })
      .finally(() => { clearTimeout(deadline); active = undefined; });
  }, () => stopped);
  return {
    server,
    start: async (host, port) => {
      if (!isPrivateNotificationBind(host)) { throw new Error("Maintenance readiness requires a private or loopback bind"); }
      if (stopped || starting) { throw new Error("Maintenance readiness cannot be started again"); }
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
      closing = (starting ?? Promise.resolve()).catch(() => undefined)
        .then(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
    },
    drain: async () => { await active; await closing; }
  };
};
