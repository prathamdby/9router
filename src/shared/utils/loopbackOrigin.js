// Loopback-twin origin helper: localhost <-> 127.0.0.1 with the same scheme
// and port. Returns null for every other host (no relay between arbitrary
// origins) or an unparseable origin.

export function loopbackTwin(origin) {
  if (!origin || typeof origin !== "string") return null;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  let twinHost = null;
  if (host === "localhost") twinHost = "127.0.0.1";
  else if (host === "127.0.0.1") twinHost = "localhost";
  if (!twinHost) return null;
  return `${url.protocol}//${twinHost}${url.port ? `:${url.port}` : ""}`;
}

