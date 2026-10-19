const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "postgres"]);

/** Reject non-local targets before a development command issues any DB query. */
export const assertLocalDatabase = (value: string): void => {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("A local PostgreSQL DATABASE_URL is required"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error("Development database commands require a local PostgreSQL target");
  }
};
