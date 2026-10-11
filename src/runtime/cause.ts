import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import { InvariantViolationError } from "../errors/index.ts";

/** Recover only typed failures; a concurrent defect or interruption must still propagate. */
export const findExpectedError = <E>(cause: Cause.Cause<E>): Result.Result<E, Cause.Cause<E>> =>
  Cause.hasDies(cause) || Cause.hasInterrupts(cause) ? Result.fail(cause) : Cause.findError(cause);

/** Preserve single-error identity while keeping compound defects distinct from expected failures. */
export const errorFromCause = <E>(cause: Cause.Cause<E>): unknown => {
  if (cause.reasons.length > 1 && Cause.hasDies(cause)) {
    return new InvariantViolationError("Effect operation failed with multiple causes.", { cause });
  }
  if (Cause.hasInterrupts(cause)) {
    return new Error("Effect operation was interrupted.", { cause });
  }
  return Cause.squash(cause);
};
