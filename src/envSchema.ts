import { z } from "zod";
import { isNotificationWebOrigin, isPrivateNotificationBind, RESULT_NOTIFICATION_DEFAULT_PORT } from "./notifications/config.ts";

export const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().url(),
  SUMMIT_CONFIG_YAML: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(1)
  ),
  // jst: Asia/Tokyo 固定のみ許可（DST なし、他地域運用想定なし）。
  TZ: z.literal("Asia/Tokyo"),
  // why: デプロイ追跡用。Fly の FLY_IMAGE_REF を優先、CI inject の GIT_SHA をフォールバックに使う。
  FLY_IMAGE_REF: z.string().optional(),
  GIT_SHA: z.string().optional(),
  RESULT_NOTIFICATION_TOKEN: z.string().min(32).max(512).optional(),
  RESULT_NOTIFICATION_OPERATIONS_TOKEN: z.string().min(32).max(512).optional(),
  RESULT_NOTIFICATION_WEB_ORIGIN: z.string().refine(isNotificationWebOrigin, "Application origin is required").optional(),
  RESULT_NOTIFICATION_BIND_HOST: z.string().refine(isPrivateNotificationBind, "Private or loopback bind is required").default("fly-local-6pn"),
  RESULT_NOTIFICATION_PORT: z.coerce.number().int().min(1).max(65_535).default(RESULT_NOTIFICATION_DEFAULT_PORT)
}).superRefine((value, ctx) => {
  const fields = ["RESULT_NOTIFICATION_TOKEN", "RESULT_NOTIFICATION_OPERATIONS_TOKEN", "RESULT_NOTIFICATION_WEB_ORIGIN"] as const;
  if (fields.some(field => value[field] !== undefined)) {
    for (const field of fields) {
      if (value[field] === undefined) { ctx.addIssue({ code: "custom", path: [field], message: "Required when result notifications are configured" }); }
    }
    if (value.RESULT_NOTIFICATION_TOKEN === value.RESULT_NOTIFICATION_OPERATIONS_TOKEN) {
      ctx.addIssue({ code: "custom", path: ["RESULT_NOTIFICATION_OPERATIONS_TOKEN"], message: "Use a separate operations token" });
    }
  }
});
