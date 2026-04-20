// why: 依存を 1 箇所で組み立てる composition root。production は src/index.ts から `createAppContext()`、
//   tests は `createAppContext({ ports: fakePorts, clock: fakeClock })` で同じ形を使う。
// invariant: AppContext を受け取るすべての factory は、ここ以外から依存を解決しない。
// @see docs/adr/0018-port-wiring-and-factory-injection.md

import { db as defaultDb } from "./db/client.js";
import type { AppPorts } from "./ports/index.js";
import { makeRealPorts } from "./ports/real.js";
import { systemClock, type Clock } from "./time/index.js";

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
