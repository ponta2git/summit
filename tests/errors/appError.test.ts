import { describe, expect, it } from "vitest";

import {
  AppError,
  DatabaseError,
  NotFoundError,
  ValidationError,
  errResult,
  okResult
} from "../../src/errors/index.js";

describe("AppError", () => {
  it("discriminates by error code", () => {
    const error = new NotFoundError("session not found");

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("NOT_FOUND");
  });

  it("preserves cause chain", () => {
    const cause = new Error("neon timeout");
    const error = new DatabaseError("database write failed", { cause });

    expect(error.cause).toBe(cause);
    expect(error.message).toBe("database write failed");
  });
});

describe("AppResult", () => {
  it("handles ok/err branches", () => {
    const ok = okResult("ok");
    const err = errResult(new ValidationError("invalid custom_id"));

    expect(ok.match((value) => value, () => "err")).toBe("ok");
    expect(err.match(() => "ok", (error) => error.code)).toBe("VALIDATION");
  });
});
