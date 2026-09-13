import { AppError } from "./errors/index.ts";

const KNOWN_ERROR_CODES = new Set([
  "INVARIANT_VIOLATION", "VALIDATION", "NOT_FOUND", "DISCORD_API", "DATABASE", "SHUTDOWN",
  "EACCES", "EADDRINUSE", "EAI_AGAIN", "ECONNABORTED", "ECONNREFUSED", "ECONNRESET",
  "ENETUNREACH", "ENOTFOUND", "EPIPE", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "08000", "08001", "08003", "08004", "08006", "08007", "08P01",
  "23502", "23503", "23505", "23514", "23P01", "25P02", "28P01", "3D000",
  "40001", "40P01", "42501", "42601", "42703", "42P01", "53300", "53400",
  "55P03", "57014", "57P01", "57P02", "57P03"
]);
const MAX_CAUSE_DEPTH = 3;

interface SafeError {
  readonly type: "AppError" | "Error" | "ThrownValue" | "OmittedError";
  readonly code?: string | number;
  readonly status?: number;
  readonly cause?: SafeError;
  readonly reason?: "cycle" | "depth_limit" | "unreadable";
}

// 外部Errorのgetterをlog時に実行しないため、data propertyだけ読む。
const ownValue = (value: object, key: string): unknown => {
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && "value" in property ? property.value : undefined;
};

const summarize = (value: unknown, seen: Set<object>, depth: number): SafeError => {
  if (typeof value !== "object" || value === null) { return { type: "ThrownValue" }; }
  if (seen.has(value)) { return { type: "OmittedError", reason: "cycle" }; }
  if (depth > MAX_CAUSE_DEPTH) { return { type: "OmittedError", reason: "depth_limit" }; }
  seen.add(value);
  const code = ownValue(value, "code");
  const status = ownValue(value, "status");
  const cause = ownValue(value, "cause");
  const safeCode = (typeof code === "string" && KNOWN_ERROR_CODES.has(code))
    || (typeof code === "number" && Number.isSafeInteger(code) && code >= 0);
  return {
    type: value instanceof AppError ? "AppError" : value instanceof Error ? "Error" : "ThrownValue",
    ...(safeCode ? { code } : {}),
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(cause === undefined ? {} : { cause: summarize(cause, seen, depth + 1) })
  };
};

/** 診断分類だけを有限深度で残し、外部message・stack・SDK/DB payloadを出さない。 */
export const serializeLogError = (value: unknown): SafeError => {
  try { return summarize(value, new Set(), 0); }
  catch { return { type: "OmittedError", reason: "unreadable" }; }
};
