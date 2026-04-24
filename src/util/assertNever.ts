// invariant: discriminated union の default で未処理ケースを compile-time + runtime に露出させる。
export function assertNever(x: never, context?: string): never {
  throw new Error(`assertNever reached${context ? `: ${context}` : ""}: ${JSON.stringify(x)}`);
}
