import { and, eq, or, type SQL } from "drizzle-orm";
import { discordNotifications as notifications } from "../schema.ts";

/** Retained history is readable but only deployed result versions can dispatch. */
export const supportedResultNotification = (): SQL | undefined => or(
  and(eq(notifications.kind, "ocr_completed"), eq(notifications.schemaVersion, 2)),
  and(eq(notifications.kind, "analysis_completed"), eq(notifications.schemaVersion, 1))
);
