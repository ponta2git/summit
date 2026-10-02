// why: composition root。AppContext を受け取る factory は、ここ以外から依存を解決しない。
// @see docs/architecture.md

import { db as defaultDb } from "./db/client.ts";
import type { AppPorts } from "./db/ports.ts";
import { makeRealPorts } from "./db/ports.real.ts";
import { systemClock, type Clock } from "./time/index.ts";
import { env } from "./env.ts";
import { assertNewNotificationPartLimit } from "./features/result-notifications/render.ts";

export interface AppContext {
  readonly ports: AppPorts;
  readonly clock: Clock;
}

export interface AppContextOverrides {
  readonly ports?: AppPorts;
  readonly clock?: Clock;
}

export const createAppContext = (overrides: AppContextOverrides = {}): AppContext => ({
  ports: overrides.ports ?? makeRealPorts(defaultDb, payload => {
    if (!env.RESULT_NOTIFICATION_WEB_ORIGIN) { throw new Error("Notification receipt is not configured"); }
    assertNewNotificationPartLimit(payload, env.RESULT_NOTIFICATION_WEB_ORIGIN);
  }),
  clock: overrides.clock ?? systemClock
});
