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

export const createAppContext = (): AppContext => {
  const webOrigin = env.RESULT_NOTIFICATION_WEB_ORIGIN;
  return {
    ports: makeRealPorts(defaultDb, payload => {
      if (!webOrigin) { throw new Error("Notification receipt is not configured"); }
      assertNewNotificationPartLimit(payload, webOrigin);
    }),
    clock: systemClock
  };
};
