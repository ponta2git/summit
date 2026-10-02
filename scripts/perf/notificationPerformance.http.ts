import { request } from "node:http";
import { performance } from "node:perf_hooks";
import { CapacityError } from "../verify/notificationCapacity.contract.ts";
import type { CapacitySession } from "../verify/notificationCapacity.scenarios.ts";
import { performanceStage } from "./notificationPerformance.diagnostics.ts";

export interface PerformanceHttpSample {
  readonly kind: "analysis" | "ocr" | "conflict" | "overload";
  readonly status: number;
  readonly milliseconds: number;
  readonly wireBytes: number;
  readonly barrierHeld: boolean;
}

/** Record no URL, authorization, payload, response body or notification ID. */
export const performancePost = (
  session: CapacitySession, raw: string, kind: PerformanceHttpSample["kind"],
  options: { wireBytes?: number; chunked?: boolean; barrierHeld?: boolean } = {}
): Promise<PerformanceHttpSample> => {
  const bytes = Buffer.byteLength(raw);
  const body = Buffer.from(raw + " ".repeat(Math.max(0, (options.wireBytes ?? bytes) - bytes)));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let responseStatus: number | undefined;
    const done = (status: number): void => resolve({ kind, status, milliseconds: performance.now() - started,
      wireBytes: body.length, barrierHeld: options.barrierHeld ?? false });
    const failed = (error: Error & { code?: string }): void => {
      if (responseStatus !== undefined && responseStatus >= 400) { done(responseStatus); return; }
      const code = ["ECONNRESET", "EPIPE", "ABORT_ERR"].includes(error.code ?? "") ? error.code : "unknown";
      reject(new CapacityError("setup_or_measurement", `http_${code}`));
    };
    const call = request(session.receiverOrigin + "/internal/discord-notifications", { method: "POST", signal: session.signal,
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json",
        ...(options.chunked ? {} : { "content-length": body.length }) }
    }, response => {
      responseStatus = response.statusCode;
      response.resume(); response.once("end", () => done(response.statusCode ?? 0)); response.once("error", failed);
    });
    call.once("error", failed);
    if (options.chunked) { call.write(body.subarray(0, Math.floor(body.length / 2))); call.end(body.subarray(Math.floor(body.length / 2))); }
    else { call.end(body); }
  });
};

export const performanceControl = async (session: CapacitySession, path: string): Promise<unknown> => {
  const operation = path.startsWith("/wait/") ? "wait" : ["/reset", "/gc", "/finish", "/stats", "/wake"].includes(path)
    ? path.slice(1) : "barrier";
  return performanceStage(`control_${operation}`, async () => {
    const response = await fetch(session.controlOrigin + path, {
      headers: { authorization: `Bearer ${session.token}` }, signal: session.signal
    });
    if (response.status !== 200) { throw new CapacityError("setup_or_measurement", `control_${operation}_status_${response.status}`); }
    return response.json();
  });
};
