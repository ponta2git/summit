import { isPrivateNotificationBind, RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS, RESULT_NOTIFICATION_DEFAULT_PORT } from "./config.ts";

const usage = "Usage: notifications inspect <notification-id> | retry <notification-id> | settings <ocr_completed|analysis_completed> [on|off]";

export const buildNotificationOperation = (args: readonly string[]): { readonly path: string; readonly method: string; readonly body?: string } => {
  const [command, id, change] = args;
  if ((command === "inspect" || command === "retry") && id && args.length === 2
    && /^result:(ocr_completed|analysis_completed):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id)) {
    return { path: `/internal/discord-notifications/${encodeURIComponent(id)}${command === "retry" ? "/retry" : ""}`,
      method: command === "retry" ? "POST" : "GET" };
  }
  if (command === "settings" && (id === "ocr_completed" || id === "analysis_completed")
    && (args.length === 2 || (args.length === 3 && (change === "on" || change === "off")))) {
    return { path: `/internal/discord-notifications/settings/${id}`, method: change ? "PATCH" : "GET",
      ...(change ? { body: JSON.stringify({ enabled: change === "on" }) } : {}) };
  }
  throw new Error(usage);
};

export const runNotificationCli = async (
  args: readonly string[], environment: Readonly<Record<string, string | undefined>>,
  output: (text: string) => void = text => process.stdout.write(`${text}\n`)
): Promise<void> => {
  if (args.length === 0 || args[0] === "--help") { output(usage); return; }
  const operation = buildNotificationOperation(args);
  const token = environment["RESULT_NOTIFICATION_OPERATIONS_TOKEN"];
  if (!token || token.length < 32) { throw new Error("RESULT_NOTIFICATION_OPERATIONS_TOKEN is required"); }
  const host = environment["RESULT_NOTIFICATION_BIND_HOST"] ?? "fly-local-6pn";
  const port = environment["RESULT_NOTIFICATION_PORT"] ?? String(RESULT_NOTIFICATION_DEFAULT_PORT);
  let url: URL;
  try {
    url = new URL(environment["RESULT_NOTIFICATION_URL"] ?? `http://${host.includes(":") ? `[${host}]` : host}:${port}`);
  } catch { throw new Error("Invalid notification service URL"); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "http:" || (!isPrivateNotificationBind(hostname) && !hostname.endsWith(".internal"))
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Notification operations require a private HTTP service origin");
  }
  let response: Response;
  try {
    response = await fetch(new URL(operation.path, url), { method: operation.method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(operation.body === undefined ? {} : { body: operation.body }), redirect: "error",
      signal: AbortSignal.timeout(RESULT_NOTIFICATION_CLIENT_TIMEOUT_MS) });
  } catch { throw new Error("Notification service is unavailable; inspect the same ID before retrying"); }
  if (!response.ok) { throw new Error(`Notification operation rejected (HTTP ${response.status})`); }
  let state: unknown;
  try { state = await response.json(); } catch { throw new Error("Invalid notification service response"); }
  output(JSON.stringify(state, null, 2));
};
