import { HEALTHCHECK_PING_TIMEOUT_MS } from "../config.js";
import { sendHealthcheckPing } from "../healthcheck/ping.js";
import { logger } from "../logger.js";

export const sendBootHealthcheckPing = (url: string | undefined): void => {
  // why: 起動完了後に healthchecks.io へ best-effort boot ping。未設定は no-op、失敗しても起動継続。
  if (url === undefined) {
    return;
  }
  void sendHealthcheckPing(url, { timeoutMs: HEALTHCHECK_PING_TIMEOUT_MS }).then((result) => {
    if (result.ok) {
      logger.info(
        { event: "healthcheck.boot_ping", ok: true, elapsedMs: result.elapsedMs, status: result.status },
        "Healthcheck boot ping."
      );
    } else {
      const failFields =
        result.status !== undefined
          ? { event: "healthcheck.boot_ping", ok: false, elapsedMs: result.elapsedMs, status: result.status }
          : { event: "healthcheck.boot_ping", ok: false, elapsedMs: result.elapsedMs, errorKind: result.errorKind };
      logger.warn(failFields, "Healthcheck boot ping failed.");
    }
    return undefined;
  });
};
