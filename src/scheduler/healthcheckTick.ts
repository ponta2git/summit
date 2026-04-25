import { HEALTHCHECK_PING_TIMEOUT_MS } from "../config.js";
import { sendHealthcheckPing, type FetchFn } from "../healthcheck/ping.js";
import { logger } from "../logger.js";

/**
 * Best-effort healthcheck ping on each cron tick.
 *
 * @remarks
 * `url` 未設定時は no-op (`HEALTHCHECK_PING_URL` 未設定)。
 * redact: URL はログに含めない。`event=healthcheck.tick_ping` でのみログ化。
 * @see ADR-0034
 */
export const runHealthcheckTickPing = async (
  url: string | undefined,
  fetchFn?: FetchFn
): Promise<void> => {
  if (!url) { return; }
  try {
    const result = await sendHealthcheckPing(url, {
      timeoutMs: HEALTHCHECK_PING_TIMEOUT_MS,
      ...(fetchFn !== undefined ? { fetchFn } : {})
    });
    if (result.ok) {
      logger.info(
        { event: "healthcheck.tick_ping", ok: true, elapsedMs: result.elapsedMs, status: result.status },
        "Healthcheck tick ping."
      );
    } else {
      const failFields =
        result.status !== undefined
          ? { event: "healthcheck.tick_ping", ok: false, elapsedMs: result.elapsedMs, status: result.status }
          : { event: "healthcheck.tick_ping", ok: false, elapsedMs: result.elapsedMs, errorKind: result.errorKind };
      logger.warn(failFields, "Healthcheck tick ping failed.");
    }
  } catch (error: unknown) {
    // why: sendHealthcheckPing は throw しない契約だが belt-and-suspenders でガードする。
    logger.warn({ event: "healthcheck.tick_ping", ok: false, error }, "Healthcheck tick ping threw unexpectedly.");
  }
};
