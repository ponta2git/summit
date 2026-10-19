import type { IncomingMessage } from "node:http";
import { RESULT_NOTIFICATION_BODY_TIMEOUT_MS, RESULT_NOTIFICATION_MAX_BODY_BYTES } from "../config.ts";

export class NotificationHttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) { super(code); this.status = status; this.code = code; }
}

/** Unknown-length bodies reserve their worst case until the entire command settles. */
export const notificationBodyReservation = (request: IncomingMessage): number => {
  if (request.method !== "POST" && request.method !== "PATCH") { return 0; }
  const declared = request.headers["content-length"];
  if (declared === undefined) { return RESULT_NOTIFICATION_MAX_BODY_BYTES; }
  const bytes = Number(declared);
  if (!Number.isSafeInteger(bytes) || bytes < 0) { throw new NotificationHttpError(400, "invalid_input"); }
  if (bytes > RESULT_NOTIFICATION_MAX_BODY_BYTES) { throw new NotificationHttpError(413, "payload_too_large"); }
  return Math.max(65_536, bytes);
};

/** Stop retaining bytes at the limit without destroying a pending error response. */
export const readNotificationBody = (request: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let received = Buffer.alloc(0);
  let bytes = 0;
  let finished = false;
  const finish = (error?: NotificationHttpError): void => {
    if (finished) { return; }
    finished = true;
    clearTimeout(timer);
    request.off("data", onData); request.off("end", onEnd);
    request.off("aborted", onAborted); request.off("error", onAborted);
    if (error) { received = Buffer.alloc(0); request.resume(); reject(error); }
  };
  const onData = (chunk: Buffer): void => {
    if (chunk.length > RESULT_NOTIFICATION_MAX_BODY_BYTES - bytes) { finish(new NotificationHttpError(413, "payload_too_large")); return; }
    const size = bytes + chunk.length;
    if (size > received.length) {
      // why: chunk 数や backing buffer の大きさに比例する保持を避ける。小さい本文には小さい領域だけ確保する。
      const capacity = Math.min(RESULT_NOTIFICATION_MAX_BODY_BYTES, Math.max(size, received.length * 2, 65_536));
      const expanded = Buffer.alloc(capacity);
      received.copy(expanded, 0, 0, bytes);
      received = expanded;
    }
    chunk.copy(received, bytes);
    bytes = size;
  };
  const onAborted = (): void => finish(new NotificationHttpError(400, "request_aborted"));
  const onEnd = (): void => {
    finish();
    try { resolve(new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(0, bytes))); }
    catch { reject(new NotificationHttpError(400, "invalid_input")); }
  };
  const timer = setTimeout(() => finish(new NotificationHttpError(503, "request_timeout")), RESULT_NOTIFICATION_BODY_TIMEOUT_MS);
  request.on("data", onData); request.once("end", onEnd); request.once("aborted", onAborted); request.once("error", onAborted);
});
