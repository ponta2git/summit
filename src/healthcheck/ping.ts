export type FetchFn = typeof fetch;

export interface PingResult {
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly status?: number;
  readonly errorKind?: string;
}

/**
 * Best-effort HTTP GET to a healthcheck URL with a short timeout.
 *
 * @remarks
 * redact: URL は呼び出し元から受けるが、この関数も呼び出し側もログに URL を含めない。
 * @see ADR-0034
 */
export const sendHealthcheckPing = async (
  url: string,
  options: {
    readonly timeoutMs: number;
    readonly fetchFn?: FetchFn;
  }
): Promise<PingResult> => {
  const { timeoutMs, fetchFn: fetchImpl = fetch } = options;
  const startMs = Date.now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const elapsedMs = Date.now() - startMs;
    return { ok: res.ok, elapsedMs, status: res.status };
  } catch (error: unknown) {
    const elapsedMs = Date.now() - startMs;
    const errorKind =
      error instanceof Error
        ? error.name === "TimeoutError" || error.name === "AbortError"
          ? "timeout"
          : "network_error"
        : "unknown";
    return { ok: false, elapsedMs, errorKind };
  }
};
