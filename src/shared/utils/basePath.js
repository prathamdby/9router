// Sub-path deployment support. NEXT_PUBLIC_BASE_PATH is a build-time value
// (inlined into client bundles like every NEXT_PUBLIC_* var); empty means the
// app is served from the domain root and everything here is a no-op.

const ALLOWED_BASE_PATH_CHARS = /^[A-Za-z0-9._~/-]+$/;
// Mirrors UPDATER_CONFIG.appPort; duplicated so this module stays dependency-free
// (it is also imported by next.config.mjs, where "@/..." aliases do not resolve).
const DEFAULT_APP_PORT = 20128;

export function normalizeBasePath(raw) {
  if (raw === undefined || raw === null) return "";
  const value = String(raw).trim();
  if (value === "" || value === "/") return "";
  const normalized = value.replace(/\/+$/, "");
  if (!normalized.startsWith("/")) {
    throw new Error(`NEXT_PUBLIC_BASE_PATH must start with "/" (got ${JSON.stringify(raw)})`);
  }
  if (!ALLOWED_BASE_PATH_CHARS.test(normalized)) {
    throw new Error(`NEXT_PUBLIC_BASE_PATH contains invalid characters (got ${JSON.stringify(raw)})`);
  }
  if (normalized.includes("//")) {
    throw new Error(`NEXT_PUBLIC_BASE_PATH must not contain "//" (got ${JSON.stringify(raw)})`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`NEXT_PUBLIC_BASE_PATH must not contain ".." segments (got ${JSON.stringify(raw)})`);
  }
  return normalized;
}

export const BASE_PATH = normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH);

// Idempotent: an already-prefixed path is returned unchanged.
export function withBasePath(path) {
  if (!BASE_PATH || typeof path !== "string" || !path.startsWith("/")) return path;
  if (path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return `${BASE_PATH}${path}`;
}

// Absolute same-origin URL of the app root as seen by the browser.
export function getAppBaseUrl() {
  return `${window.location.origin}${BASE_PATH}`;
}

// Loopback URL of this app: server self-calls and local CLI endpoint defaults.
export function getInternalBaseUrl(port = process.env.PORT || DEFAULT_APP_PORT) {
  return `http://127.0.0.1:${port}${BASE_PATH}`;
}

export const COOKIE_PATH = BASE_PATH || "/";

// Inline script source that prefixes same-origin API requests with the base
// path: raw fetch()/EventSource() calls do not get Next.js basePath handling.
// Injected as the first <head> script so wrappers are in place before any
// client code runs. `base` is embedded via JSON.stringify after validation,
// so it cannot break out of the string literal.
export function basePathRequestShim(base) {
  const normalized = normalizeBasePath(base);
  if (!normalized) return "";
  return `(function(){var B=${JSON.stringify(normalized)};var RE=new RegExp("^/(api|v1|v1beta|i18n)(/|$)");function ok(p){return RE.test(p)&&p!==B&&p.indexOf(B+"/")!==0}function fix(u){try{var x=new URL(u,window.location.href);if(x.origin===window.location.origin&&ok(x.pathname)){x.pathname=B+x.pathname;return x.href}}catch(e){}return u}var F=window.fetch;if(F){window.fetch=function(i,n){try{if(typeof i==="string"){i=fix(i)}else if(i&&i.url){var x=new URL(i.url);if(x.origin===window.location.origin&&ok(x.pathname)){x.pathname=B+x.pathname;i=new Request(x.href,i)}}}catch(e){}return F.call(this,i,n)}}var E=window.EventSource;if(E){window.EventSource=function(u,c){return new E(fix(u),c)};window.EventSource.prototype=E.prototype}})();`;
}
