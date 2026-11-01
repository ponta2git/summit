import { logger } from "../logger.ts";
import { NotificationNotStartedError } from "../errors/index.ts";
import { createNotificationAdmission, type NotificationAdmission, type NotificationAdmissionRequest } from "./notificationAdmission.ts";

const admissions = new WeakMap<object, NotificationAdmission>();

/** A root handle shares one coordinator across result and attendance repositories. */
export const notificationAdmissionFor = (db: object): NotificationAdmission => {
  let admission = admissions.get(db);
  if (!admission) { admission = createNotificationAdmission({ logger }); admissions.set(db, admission); }
  return admission;
};

/** Stop/expiry is a no-op for internal work, never a database backoff or a delivery failure. */
export const notificationNotStarted = <T>(work: Promise<T>, fallback: T): Promise<T> => work.catch((error: unknown) => {
  if (error instanceof NotificationNotStartedError && error.reason !== "queue_timeout") { return fallback; }
  throw error;
});

export const notificationOwnerRequest = (id: string, token: string,
  operation: "begin" | "renew" | "finalize", remainingMs?: () => number
): Omit<NotificationAdmissionRequest, "family"> => ({
  key: `owner:${id}:${token}:${operation === "renew" ? "renew" : "work"}`, operation,
  ...(remainingMs ? { remainingMs } : {})
});
