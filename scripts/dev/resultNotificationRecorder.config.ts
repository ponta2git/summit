/** Only the explicitly named disposable database is accepted; no local config is read. */
export const requireRecorderDatabase = (value: string | undefined): URL => {
  if (!value) { throw new Error("TEST_DATABASE_URL is required."); }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Recorder requires a valid loopback disposable database URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || !/^\/mom24_[a-z0-9_]+$/.test(url.pathname)) {
    throw new Error("Recorder requires a loopback mom24_ disposable database.");
  }
  return url;
};
