import { Readable } from "node:stream";
import { RESULT_NOTIFICATION_RESPONSE_MAX_BYTES } from "./config.ts";
import { parseNotificationJson } from "../domain/resultNotificationPayload.ts";

export class NotificationResponseError extends Error {
  constructor(reason: "invalid_response" | "response_too_large" | "rejected", status?: number) {
    super(reason === "rejected" ? `Notification operation rejected (HTTP ${status})`
      : reason === "response_too_large" ? "Notification service response exceeded the byte limit"
        : "Invalid notification service response");
  }
}

/** Read and validate bounded JSON while retaining the request's deadline through the body. */
export const readNotificationResponse = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  if (!response.body) { throw new NotificationResponseError(response.ok ? "invalid_response" : "rejected", response.status); }
  const body = Readable.fromWeb(response.body);
  const abort = (): void => { body.destroy(new Error("Notification response timed out")); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) { abort(); }
  try {
    if (!response.ok) { throw new NotificationResponseError("rejected", response.status); }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      throw new NotificationResponseError("invalid_response");
    }
    const received = Buffer.alloc(RESULT_NOTIFICATION_RESPONSE_MAX_BYTES);
    let bytes = 0;
    const stream: AsyncIterable<unknown> = body;
    for await (const value of stream) {
      if (!(value instanceof Uint8Array)) { throw new NotificationResponseError("invalid_response"); }
      if (value.byteLength > RESULT_NOTIFICATION_RESPONSE_MAX_BYTES - bytes) {
        throw new NotificationResponseError("response_too_large");
      }
      received.set(value, bytes);
      bytes += value.byteLength;
    }
    try { return parseNotificationJson(new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(0, bytes))); }
    catch { throw new NotificationResponseError("invalid_response"); }
  } finally {
    signal.removeEventListener("abort", abort);
    body.destroy();
  }
};
