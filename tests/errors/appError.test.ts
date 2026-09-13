import { describe, expect, it } from "vitest";

import {
  AppError,
  DatabaseError,
  NotFoundError,
  ShutdownError
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

  it("discriminates shutdown errors", () => {
    expect(new ShutdownError("shutdown in progress").code).toBe("SHUTDOWN");
  });
});
