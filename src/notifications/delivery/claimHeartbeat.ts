import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { settledCall } from "../../runtime/effect.ts";
import type { Clock } from "../../time/index.ts";
import { claimLeaseRemainingMs, monotonicNow, type ClaimLease } from "../../time/lease.ts";
import { NOTIFICATION_LEASE_RETRY_MS } from "../../config.ts";
import { NotificationAdmissionInvariantError, NotificationNotStartedError } from "../../errors/index.ts";

type OwnershipState = "owned" | "uncertain" | "lost";
export interface ClaimOwnership {
  state(): OwnershipState;
  remainingMs(): number;
  /** Synchronous guard immediately before registering and starting foreign I/O. */
  canStart(): boolean;
  /** Wait for a confirmed renewal; stop or terminal ownership loss returns false. */
  awaitOwnership(): Effect.Effect<boolean>;
}

/** Own delivery, an independent deadline guard, and every actual renewal through settlement. */
export const withClaimHeartbeat = <T, E>(options: {
  readonly intervalMs: number;
  readonly lease: ClaimLease;
  readonly clock: Clock;
  readonly renew: (remainingMs: () => number) => Promise<ClaimLease | null>;
  readonly onLost: (reason: "lost" | "uncertain") => void;
  readonly isStopping?: () => boolean;
  readonly stopSignal?: AbortSignal;
}, run: (ownership: ClaimOwnership) => Effect.Effect<T, E>): Effect.Effect<T, E> => Effect.suspend(() => {
  let lease = options.lease;
  let state: OwnershipState = "owned";
  let reported: OwnershipState = "owned";
  let finished = false;
  let requested = false;
  let pendingSince: number | undefined;
  let changed = Deferred.makeUnsafe<void>();
  let renewalRequested = Deferred.makeUnsafe<void>();
  const failures: Cause.Cause<never>[] = [];
  const remaining = (): number => claimLeaseRemainingMs(lease, options.clock);
  const notify = (): void => {
    const previous = changed; changed = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(previous, Effect.void);
  };
  const transition = (next: OwnershipState): void => {
    if (state === "lost" || state === next) { return; }
    state = next; notify();
  };
  const refresh = (): OwnershipState => {
    if (remaining() <= 0) { transition("lost"); }
    else if (pendingSince !== undefined && monotonicNow(options.clock) - pendingSince >= options.intervalMs) {
      transition("uncertain");
    }
    return state;
  };
  const report = (): void => {
    if (reported === state) { return; }
    reported = state;
    if (!finished && state !== "owned") { options.onLost(state); }
  };
  const requestRenewal = (): void => {
    requested = true;
    Deferred.doneUnsafe(renewalRequested, Effect.void);
  };
  const stopping = (): boolean => options.stopSignal?.aborted === true || options.isStopping?.() === true;
  const canStart = (): boolean => {
    if (refresh() === "lost" || stopping()) { return false; }
    if (remaining() < options.intervalMs) { transition("uncertain"); requestRenewal(); }
    return state === "owned";
  };
  const ownership: ClaimOwnership = {
    state: refresh, canStart, remainingMs: remaining,
    awaitOwnership: () => Effect.gen(function* () {
      while (true) {
        if (finished) { return false; }
        const wake = changed;
        if (canStart()) { return true; }
        if (refresh() === "lost" || stopping()) { return false; }
        yield* Deferred.await(wake);
      }
    })
  };
  const supervise = (work: Effect.Effect<void>): Effect.Effect<void> => work.pipe(Effect.onExit(exit => Effect.sync(() => {
    if (Exit.isFailure(exit) && (!finished || !Cause.hasInterruptsOnly(exit.cause))) {
      transition("lost"); failures.push(exit.cause);
    }
  })));
  const heartbeat = supervise(Effect.gen(function* () {
    let retry = 0;
    let retryDelay: number | undefined;
    while (true) {
      if (finished || refresh() === "lost") { break; }
      if (retryDelay !== undefined) { yield* Effect.sleep(retryDelay); }
      else if (!requested) { yield* Effect.raceFirst(Effect.sleep(options.intervalMs), Deferred.await(renewalRequested)); }
      requested = false; renewalRequested = Deferred.makeUnsafe<void>();
      if (finished || refresh() === "lost") { report(); return; }
      pendingSince = monotonicNow(options.clock);
      let failed = false;
      // DB promises are not cancellable: the scope keeps this single renewal until settlement.
      yield* settledCall(() => options.renew(remaining)).pipe(Effect.match({
        onFailure: error => {
          pendingSince = undefined;
          if (error instanceof NotificationAdmissionInvariantError || error instanceof NotificationNotStartedError) { throw error; }
          failed = true; transition("uncertain");
        },
        onSuccess: renewed => {
          pendingSince = undefined;
          // A reply after the previously confirmed deadline cannot resurrect a terminal owner.
          if (refresh() === "lost") { return; }
          if (!renewed) { transition("lost"); return; }
          lease = renewed;
          requested = false; renewalRequested = Deferred.makeUnsafe<void>();
          transition(remaining() > 0 ? "owned" : "lost");
        }
      }));
      notify(); report();
      if (finished || refresh() === "lost") { return; }
      retryDelay = failed ? NOTIFICATION_LEASE_RETRY_MS[retry++] : undefined;
      if (!failed) { retry = 0; }
      else if (retryDelay === undefined || remaining() <= retryDelay + options.intervalMs) {
        transition("lost"); report(); return;
      }
    }
    report();
  }));
  const deadline = supervise(Effect.gen(function* () {
    while (true) {
      if (finished || refresh() === "lost") { break; }
      const pendingLeft = pendingSince === undefined ? Infinity : options.intervalMs - (monotonicNow(options.clock) - pendingSince);
      yield* Effect.sleep(Math.max(1, Math.min(options.intervalMs, remaining(), pendingLeft > 0 ? pendingLeft : options.intervalMs)));
      if (pendingSince !== undefined && monotonicNow(options.clock) - pendingSince >= options.intervalMs) { transition("uncertain"); }
      refresh(); report();
    }
  }));
  options.stopSignal?.addEventListener("abort", notify, { once: true });
  return Effect.scoped(Effect.gen(function* () {
    yield* Effect.forkScoped(heartbeat);
    yield* Effect.forkScoped(deadline);
    return yield* Effect.suspend(() => run(ownership)).pipe(Effect.ensuring(Effect.sync(() => {
      finished = true; notify(); options.stopSignal?.removeEventListener("abort", notify);
    })));
  })).pipe(Effect.ensuring(Effect.suspend(() => {
    if (failures.length === 0) { return Effect.void; }
    return Effect.failCause(failures.reduce((combined, failure) => Cause.combine(combined, failure), Cause.empty));
  })));
});
