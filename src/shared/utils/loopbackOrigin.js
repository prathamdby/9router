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

// postMessage origin gate for OAuth callbacks: accept the page's own origin,
// or a real loopback origin (hostname exactly localhost/127.0.0.1, any port —
// CLI callback proxies and the Devin loopback twin depend on that). Anything
// else, including hostnames that merely contain "localhost", is rejected.
export function isTrustedOAuthMessageOrigin(origin, selfOrigin) {
  if (!origin || typeof origin !== "string") return false;
  if (origin === selfOrigin) return true;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1";
}

