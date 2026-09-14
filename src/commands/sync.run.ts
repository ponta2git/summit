import { DiscordAPIError, HTTPError, RateLimitError, REST, type RESTOptions } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { slashCommands } from "./definitions.ts";
import { commandsMatch, InvalidCommandResponseError } from "./sync.compare.ts";
import { SYNC_REQUEST_TIMEOUT_MS, type SyncReport } from "./sync.protocol.ts";
import type { SyncSettings } from "./sync.settings.ts";

interface CommandRest {
  readonly read: (signal: AbortSignal) => Promise<unknown>;
  readonly overwrite: (signal: AbortSignal) => Promise<unknown>;
  readonly dispose: () => void;
}

export const createCommandRest = (settings: SyncSettings, transport: Pick<RESTOptions, "makeRequest"> | undefined = undefined): CommandRest => {
  const rest = new REST({ version: "10", timeout: SYNC_REQUEST_TIMEOUT_MS, retries: 0, rejectOnRateLimit: () => true, ...transport })
    .setToken(settings.token);
  const route = Routes.applicationGuildCommands(settings.applicationId, settings.guildId);
  return {
    read: signal => rest.get(route, { signal, query: new URLSearchParams({ with_localizations: "true" }) }),
    overwrite: signal => rest.put(route, { signal, body: slashCommands }),
    dispose: () => { rest.clearHashSweeper(); rest.clearHandlerSweeper(); }
  };
};

export const runCommandSync = async (
  settings: SyncSettings, signal: AbortSignal,
  createRest: (settings: SyncSettings) => CommandRest = createCommandRest
): Promise<SyncReport> => {
  let writeStarted = false;
  let writeAccepted = false;
  const rest = createRest(settings);
  try {
    signal.throwIfAborted();
    const before = await rest.read(signal);
    signal.throwIfAborted();
    if (commandsMatch(slashCommands, before)) { return { status: "matched" }; }
    if (settings.check) { return { status: "different" }; }
    signal.throwIfAborted();
    writeStarted = true;
    await rest.overwrite(signal);
    writeAccepted = true;
    signal.throwIfAborted();
    const after = await rest.read(signal);
    signal.throwIfAborted();
    return commandsMatch(slashCommands, after) ? { status: "synced" }
      : { status: "unknown", reason: "verification_failed" };
  } catch (error) {
    const rejected = !writeAccepted && (error instanceof RateLimitError
      || ((error instanceof DiscordAPIError || error instanceof HTTPError) && error.status >= 400 && error.status < 500));
    const status = writeStarted && !rejected ? "unknown" : "failed";
    if (error instanceof RateLimitError) {
      return { status, reason: "rate_limited", ...(Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? { retryAfterMs: error.retryAfter } : {}) };
    }
    return { status, reason: signal.aborted ? "cancelled" : error instanceof InvalidCommandResponseError ? "invalid_response" : "request_failed" };
  } finally { rest.dispose(); }
};
