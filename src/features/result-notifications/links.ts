import { parseNotificationWebOrigin } from "../../domain/notification.ts";

export interface NotificationLinks {
  draft(id: string): string;
  match(id: string): string;
  analysis(gameTitleId: string): string;
}

export const buildNotificationLinks = (webOrigin: string): NotificationLinks => {
  const origin = parseNotificationWebOrigin(webOrigin);
  const link = (path: string): string => {
    const url = new URL(path, origin).href;
    // A confirmation URL must fit intact in one message, including its label.
    if (url.length > 1_800) { throw new Error("Notification confirmation link is too long."); }
    return `<${url}>`;
  };
  return {
    draft: (id) => link(`/review/${encodeURIComponent(id)}`),
    match: (id) => link(`/matches/${encodeURIComponent(id)}`),
    analysis: (gameTitleId) => link(`/analytics/series?${new URLSearchParams({ gameTitleId })}`)
  };
};
