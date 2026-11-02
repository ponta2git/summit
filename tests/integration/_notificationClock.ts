import type { Clock } from "../../src/time/index.ts";
import {
  claimNextOutboxBatch as claim, beginOutboxDelivery as begin,
  markOutboxDelivered as complete, markOutboxFailed as fail
} from "../../src/db/repositories/outbox.ts";

// Sequential repository contracts supply their logical timestamp explicitly.
// An epoch clock preserves it; clock-progress tests inject a separate mutable clock.
export const repositoryClock: Clock = { now: () => new Date(0) };

export const claimNextOutboxBatch = (db: Parameters<typeof claim>[0], options: Parameters<typeof claim>[1]) => claim(db, options, repositoryClock);
export const beginOutboxDelivery = (db: Parameters<typeof begin>[0], id: string, options: Parameters<typeof begin>[2]) => begin(db, id, options, repositoryClock);
export const markOutboxDelivered = (db: Parameters<typeof complete>[0], id: string, options: Parameters<typeof complete>[2]) => complete(db, id, options, repositoryClock);
export const markOutboxFailed = (db: Parameters<typeof fail>[0], id: string, options: Parameters<typeof fail>[2]) => fail(db, id, options, repositoryClock);
