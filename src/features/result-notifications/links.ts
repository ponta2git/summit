import { parseNotificationWebOrigin } from "../../domain/notification.ts";
import { NotificationInputError } from "../../domain/notificationInput.ts";

export interface NotificationLinks {
  draft(id: string): string;
  match(id: string): string;
  analysis(gameTitleId: string): string;
}

const requireWellFormedId = (id: string): string => {
  for (const point of id) {
    const code = point.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) { throw new NotificationInputError("invalid_input"); }
  }
  return id;
};

export const buildNotificationLinks = (webOrigin: string): NotificationLinks => {
  const origin = parseNotificationWebOrigin(webOrigin);
  const link = (path: string): string => {
    const url = new URL(path, origin).href;
    // A confirmation URL must fit intact in one message, including its label.
    if (url.length > 1_800) { throw new NotificationInputError("payload_too_large"); }
    return `<${url}>`;
  };
  return {
    draft: (id) => link(`/review/${encodeURIComponent(requireWellFormedId(id))}`),
    match: (id) => link(`/matches/${encodeURIComponent(requireWellFormedId(id))}`),
    analysis: (gameTitleId) => link(`/analytics/series?${new URLSearchParams({ gameTitleId: requireWellFormedId(gameTitleId) })}`)
  };
};
