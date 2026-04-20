// invariant: discriminated union の全ケースを漏れなく処理するためのコンパイル時ガード。
//   switch の default で assertNever(x) を呼び、想定外の型に達したことを runtime 側でも log + throw する。
export function assertNever(x: never, context?: string): never {
  throw new Error(`assertNever reached${context ? `: ${context}` : ""}: ${JSON.stringify(x)}`);
}
