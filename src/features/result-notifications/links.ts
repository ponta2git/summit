export interface NotificationLinks {
  draft(id: string): string;
  match(id: string): string;
  analysis(gameTitleId: string): string;
}

export const buildNotificationLinks = (webOrigin: string): NotificationLinks => {
  const origin = new URL(webOrigin);
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" || origin.hostname === "[::1]";
  if ((origin.protocol !== "https:" && !(local && origin.protocol === "http:"))
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Notification links require an application origin.");
  }
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
