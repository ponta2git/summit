export type NotificationInputCode = "invalid_input" | "unsupported_version" | "identity_conflict" | "payload_too_large";

/** Stable, payload-free errors shared by pure input guards and transport adapters. */
export class NotificationInputError extends Error {
  readonly code: NotificationInputCode;
  constructor(code: NotificationInputCode) { super(code); this.name = "NotificationInputError"; this.code = code; }
}
