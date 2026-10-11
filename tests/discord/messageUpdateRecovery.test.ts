import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it, vi } from "vitest";

import { bestEffortMessageUpdate } from "../../src/discord/shared/messageUpdates.ts";
import { DiscordApiError } from "../../src/errors/index.ts";
import { logger } from "../../src/logger.ts";
import { runEffect } from "../helpers/assertions.ts";

describe("best-effort message update recovery", () => {
  it("warns once and succeeds after an expected Discord failure", async () => {
    const failure = new DiscordApiError("Edit failed.");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      await expect(runEffect(bestEffortMessageUpdate(Effect.fail(failure), "session", "ask"))).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        { event: "message.repaint_failed", sessionId: "session", messageKind: "ask", error: failure },
        "State is committed; the public message could not be synchronized."
      );
    } finally { warn.mockRestore(); }
  });

  it("preserves a cleanup defect combined with a Discord failure without reporting ordinary recovery", async () => {
    const failure = new DiscordApiError("Edit failed.");
    const defect = new Error("Cleanup failed.");
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const update = Effect.fail(failure).pipe(Effect.ensuring(Effect.die(defect)));
      const exit = await runEffect(Effect.exit(bestEffortMessageUpdate(update, "session", "postpone")));
      expect(warn).not.toHaveBeenCalled();
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) { throw new Error("Expected the cleanup defect to propagate."); }
      expect(exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)).toEqual([failure]);
      expect(exit.cause.reasons.filter(Cause.isDieReason).map(reason => reason.defect)).toEqual([defect]);
    } finally { warn.mockRestore(); }
  });
});
