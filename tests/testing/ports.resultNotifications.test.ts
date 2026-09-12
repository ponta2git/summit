import { resultNotificationContract, notificationNow } from "../contracts/resultNotifications.ts";
import { createFakeResultNotificationsPort } from "./ports.resultNotifications.ts";

resultNotificationContract("fake", async () => {
  const port = createFakeResultNotificationsPort({ now: () => notificationNow });
  port.setTargetAvailable("match_draft", "draft-1", true);
  port.setTargetAvailable("match", "match-1", true);
  return { port, deleteMatch: async () => { port.setTargetAvailable("match", "match-1", false); }, close: async () => undefined };
});
