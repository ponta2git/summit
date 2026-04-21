// why: boot ping と tick ping の共通 HTTP I/O 境界。URL はログに出さない (ADR-0034)。
// redact: url 引数はログ・返り値に含めない。呼び出し側が event フィールドで event 種別を管理する。

export type FetchFn = typeof fetch;

export interface PingResult {
  readonly ok: boolean;
  readonly elapsedMs: number;
  /** HTTP status code — present on any response (2xx or non-2xx) */
  readonly status?: number;
  /** Categorized error kind — present on network failure or timeout */
  readonly errorKind?: string;
}

/**
 * Best-effort HTTP GET to a healthcheck URL with a short timeout.
 *
 * @remarks
 * URL は呼び出し元から受け取るが、このヘルパー自身はログに含めない。
 * 呼び出し側は `event=healthcheck.boot_ping` / `healthcheck.tick_ping` でログを記録し、
 * URL フィールドを絶対に含めないこと。
 * @see docs/adr/0034-healthcheck-ping.md
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
