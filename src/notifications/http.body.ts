import type { IncomingMessage } from "node:http";
import { RESULT_NOTIFICATION_BODY_TIMEOUT_MS, RESULT_NOTIFICATION_MAX_BODY_BYTES } from "../config.ts";

export class NotificationHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

/** Stop retaining bytes at the limit without destroying a pending error response. */
export const readNotificationBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const finish = (error?: NotificationHttpError): void => {
    clearTimeout(timer);
    request.off("data", onData); request.off("end", onEnd);
    request.off("aborted", onAborted); request.off("error", onAborted);
    if (error) { chunks.length = 0; request.resume(); reject(error); }
  };
  const onData = (chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes > RESULT_NOTIFICATION_MAX_BODY_BYTES) { finish(new NotificationHttpError(413, "payload_too_large")); return; }
    chunks.push(chunk);
  };
  const onAborted = (): void => finish(new NotificationHttpError(400, "request_aborted"));
  const onEnd = (): void => {
    finish();
    try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { reject(new NotificationHttpError(400, "invalid_input")); }
  };
  const timer = setTimeout(() => finish(new NotificationHttpError(503, "request_timeout")), RESULT_NOTIFICATION_BODY_TIMEOUT_MS);
  request.on("data", onData); request.once("end", onEnd); request.once("aborted", onAborted); request.once("error", onAborted);
});
