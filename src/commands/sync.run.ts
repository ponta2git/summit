import { Readable } from "node:stream";
import { DefaultRestOptions, DiscordAPIError, HTTPError, RateLimitError, REST, type RESTOptions } from "@discordjs/rest";
import { Routes } from "discord-api-types/v10";
import { slashCommands } from "./definitions.ts";
import { commandsMatch, InvalidCommandResponseError } from "./sync.compare.ts";
import { SYNC_REQUEST_TIMEOUT_MS, SYNC_RESPONSE_MAX_BYTES, type SyncReport } from "./sync.protocol.ts";
import type { SyncSettings } from "./sync.settings.ts";

interface CommandRest {
  readonly read: (signal: AbortSignal) => Promise<unknown>;
  readonly overwrite: (signal: AbortSignal) => Promise<unknown>;
}

class CommandResponseTooLargeError extends Error {
  constructor() { super("Command response exceeded the byte limit"); }
}

// why: SDK の timeout は makeRequest 完了で解除されるため、本文までここで読み切って保護する。
const boundedRequest = (request: RESTOptions["makeRequest"]): RESTOptions["makeRequest"] => async (url, init) => {
  const response = await request(url, init);
  if (!response.body) { return response; }
  const body = response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);
  const abort = (): void => { body.destroy(new DOMException("Command request aborted", "AbortError")); };
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) { abort(); }
  // why: 断片数に比例する配列・Buffer の保持を避け、受信バッファ自体を一定容量にする。
  const received = Buffer.alloc(SYNC_RESPONSE_MAX_BYTES);
  let bytes = 0;
  try {
    const stream: AsyncIterable<unknown> = body;
    for await (const value of stream) {
      if (typeof value !== "string" && !(value instanceof Uint8Array)) { throw new InvalidCommandResponseError(); }
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      if (chunk.length > SYNC_RESPONSE_MAX_BYTES - bytes) { throw new CommandResponseTooLargeError(); }
      chunk.copy(received, bytes);
      bytes += chunk.length;
    }
    return new Response([204, 205, 304].includes(response.status) ? null : received.subarray(0, bytes), {
      status: response.status, statusText: response.statusText, headers: [...response.headers.entries()]
    });
  } finally {
    init.signal?.removeEventListener("abort", abort);
    body.destroy();
  }
};

/** Owns bounded HTTP reads and fail-fast rate limits for one guild, without background sweepers. */
export const createCommandRest = (settings: SyncSettings, transport: Pick<RESTOptions, "makeRequest"> | undefined = undefined): CommandRest => {
  const rest = new REST({ version: "10", timeout: SYNC_REQUEST_TIMEOUT_MS, retries: 0, rejectOnRateLimit: () => true,
    hashSweepInterval: 0, handlerSweepInterval: 0, makeRequest: boundedRequest(transport?.makeRequest ?? DefaultRestOptions.makeRequest) })
    .setToken(settings.token);
  const route = Routes.applicationGuildCommands(settings.applicationId, settings.guildId);
  return {
    read: signal => rest.get(route, { signal, query: new URLSearchParams({ with_localizations: "true" }) }),
    overwrite: signal => rest.put(route, { signal, body: slashCommands })
  };
};

/** Checks or synchronizes definitions; success requires a matching GET and uncertain writes are never retried. */
export const runCommandSync = async (
  settings: SyncSettings, signal: AbortSignal,
  createRest: (settings: SyncSettings) => CommandRest = createCommandRest
): Promise<SyncReport> => {
  let phase: "precheck" | "write" | "verification" = "precheck";
  try {
    const rest = createRest(settings);
    signal.throwIfAborted();
    const before = await rest.read(signal);
    signal.throwIfAborted();
    if (commandsMatch(slashCommands, before)) { return { status: "matched" }; }
    if (settings.check) { return { status: "different" }; }
    phase = "write";
    await rest.overwrite(signal);
    phase = "verification";
    signal.throwIfAborted();
    const after = await rest.read(signal);
    signal.throwIfAborted();
    return commandsMatch(slashCommands, after) ? { status: "synced" }
      : { status: "unknown", reason: "verification_failed" };
  } catch (error) {
    const rejected = phase === "write" && (error instanceof RateLimitError
      || ((error instanceof DiscordAPIError || error instanceof HTTPError) && error.status >= 400 && error.status < 500));
    const status = phase !== "precheck" && !rejected ? "unknown" : "failed";
    if (error instanceof RateLimitError) {
      return { status, reason: "rate_limited", ...(Number.isFinite(error.retryAfter) && error.retryAfter >= 0 ? { retryAfterMs: error.retryAfter } : {}) };
    }
    return { status, reason: signal.aborted ? "cancelled" : error instanceof CommandResponseTooLargeError ? "response_too_large"
      : error instanceof InvalidCommandResponseError ? "invalid_response" : "request_failed" };
  }
};
