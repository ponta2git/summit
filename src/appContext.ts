// why: composition root。AppContext を受け取る factory は、ここ以外から依存を解決しない。
// @see ADR-0018

import { db as defaultDb } from "./db/client.ts";
import type { AppPorts } from "./db/ports.ts";
import { makeRealPorts } from "./db/ports.real.ts";
import { systemClock, type Clock } from "./time/index.ts";

export interface AppContext {
  readonly ports: AppPorts;
  readonly clock: Clock;
}

export interface AppContextOverrides {
  readonly ports?: AppPorts;
  readonly clock?: Clock;
}

export const createAppContext = (overrides: AppContextOverrides = {}): AppContext => ({
  ports: overrides.ports ?? makeRealPorts(defaultDb),
  clock: overrides.clock ?? systemClock
});
