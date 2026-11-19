import { describe, it, expect, vi, afterEach } from "vitest";

// BASE_PATH is read at module load from NEXT_PUBLIC_BASE_PATH, so each group
// stubs the env, resets the module registry, and re-imports.
async function loadModule(basePath) {
  vi.resetModules();
  if (basePath === undefined) vi.unstubAllEnvs();
  else vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
  return import("../../src/shared/utils/basePath.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("normalizeBasePath", () => {
  it("maps empty inputs to the root", async () => {
    const { normalizeBasePath } = await loadModule(undefined);
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath(undefined)).toBe("");
    expect(normalizeBasePath(null)).toBe("");
  });

  it("strips trailing slashes", async () => {
    const { normalizeBasePath } = await loadModule(undefined);
    expect(normalizeBasePath("/9router/")).toBe("/9router");
    expect(normalizeBasePath("/9router///")).toBe("/9router");
    expect(normalizeBasePath("/a/b/c")).toBe("/a/b/c");
  });

  it("rejects values not starting with /", async () => {
    const { normalizeBasePath } = await loadModule(undefined);
    expect(() => normalizeBasePath("9router")).toThrow();
  });

  it("rejects characters outside the path alphabet", async () => {
    const { normalizeBasePath } = await loadModule(undefined);
    expect(() => normalizeBasePath("/a b")).toThrow();
    expect(() => normalizeBasePath("/a?x")).toThrow();
    expect(() => normalizeBasePath("/a#x")).toThrow();
    expect(() => normalizeBasePath('/a"x')).toThrow();
  });

  it("rejects // and .. segments", async () => {
    const { normalizeBasePath } = await loadModule(undefined);
    expect(() => normalizeBasePath("/a//b")).toThrow();
    expect(() => normalizeBasePath("/a/../b")).toThrow();
  });
});

describe("withBasePath", () => {
  it("is an identity when BASE_PATH is empty", async () => {
    const { BASE_PATH, withBasePath, COOKIE_PATH } = await loadModule(undefined);
    expect(BASE_PATH).toBe("");
    expect(COOKIE_PATH).toBe("/");
    expect(withBasePath("/api/x")).toBe("/api/x");
    expect(withBasePath("/dashboard")).toBe("/dashboard");
  });

  it("prefixes absolute paths under a base path", async () => {
    const { BASE_PATH, withBasePath, COOKIE_PATH } = await loadModule("/9router");
    expect(BASE_PATH).toBe("/9router");
    expect(COOKIE_PATH).toBe("/9router");
    expect(withBasePath("/api/x")).toBe("/9router/api/x");
    expect(withBasePath("/")).toBe("/9router/");
  });

  it("is idempotent and leaves non-absolute inputs alone", async () => {
    const { withBasePath } = await loadModule("/9router");
    expect(withBasePath("/9router")).toBe("/9router");
    expect(withBasePath("/9router/api/x")).toBe("/9router/api/x");
    expect(withBasePath(withBasePath("/api/x"))).toBe("/9router/api/x");
    expect(withBasePath("api/x")).toBe("api/x");
    expect(withBasePath("https://other.com/api/x")).toBe("https://other.com/api/x");
    expect(withBasePath("")).toBe("");
    expect(withBasePath(null)).toBe(null);
    // "/9routerX" is a different path, not an already-prefixed one.
    expect(withBasePath("/9routerX")).toBe("/9router/9routerX");
  });
});

describe("getInternalBaseUrl", () => {
  it("uses PORT env or the default app port, plus the base path", async () => {
    const { getInternalBaseUrl } = await loadModule("/9router");
    vi.stubEnv("PORT", "20199");
    expect(getInternalBaseUrl()).toBe("http://127.0.0.1:20199/9router");
    vi.stubEnv("PORT", "");
    expect(getInternalBaseUrl()).toBe("http://127.0.0.1:20128/9router");
    expect(getInternalBaseUrl(1234)).toBe("http://127.0.0.1:1234/9router");
  });
});

describe("getAppBaseUrl", () => {
  it("appends the base path to the page origin", async () => {
    const { getAppBaseUrl } = await loadModule("/9router");
    const prev = globalThis.window;
    globalThis.window = { location: { origin: "https://host.example" } };
    try {
      expect(getAppBaseUrl()).toBe("https://host.example/9router");
    } finally {
      globalThis.window = prev;
    }
  });
});

describe("basePathRequestShim", () => {
  function fakeWindow(origin = "http://localhost:3000") {
    const calls = [];
    const win = {
      location: { origin, href: `${origin}/9router/login` },
      fetch: (...args) => {
        calls.push(["fetch", ...args]);
        return Promise.resolve({ ok: true });
      },
      EventSource: function (url) {
        calls.push(["eventsource", url]);
      },
      __calls: calls,
    };
    return win;
  }

  function installShim(source, win) {
    // The shim touches window, URL, Request and EventSource (via window.*);
    // URL/Request are Node globals, window is injected.
    new Function("window", `"use strict";${source}`)(win);
  }

  it("returns empty source for an empty base path", async () => {
    const { basePathRequestShim } = await loadModule(undefined);
    expect(basePathRequestShim("")).toBe("");
    expect(basePathRequestShim("/")).toBe("");
  });

  it("rewrites same-origin /api, /v1, /v1beta and /i18n fetches only", async () => {
    const { basePathRequestShim } = await loadModule("/9router");
    const win = fakeWindow();
    installShim(basePathRequestShim("/9router"), win);

    await win.fetch("/api/keys");
    await win.fetch("/v1/models");
    await win.fetch("/v1beta/models");
    await win.fetch("/i18n/en.json");
    await win.fetch("/9router/api/already");
    await win.fetch("/_next/static/chunk.js");
    await win.fetch("https://other.example/api/x");

    const urls = win.__calls.map((c) => c[1]);
    expect(urls).toEqual([
      "http://localhost:3000/9router/api/keys",
      "http://localhost:3000/9router/v1/models",
      "http://localhost:3000/9router/v1beta/models",
      "http://localhost:3000/9router/i18n/en.json",
      "/9router/api/already",
      "/_next/static/chunk.js",
      "https://other.example/api/x",
    ]);
  });

  it("preserves Request inputs while rewriting their URL", async () => {
    const { basePathRequestShim } = await loadModule("/9router");
    const win = fakeWindow();
    installShim(basePathRequestShim("/9router"), win);

    const input = new Request("http://localhost:3000/api/keys", {
      method: "POST",
      headers: { "x-test": "1" },
    });
    await win.fetch(input);
    const passed = win.__calls[0][1];
    expect(passed).toBeInstanceOf(Request);
    expect(passed.url).toBe("http://localhost:3000/9router/api/keys");
    expect(passed.method).toBe("POST");
    expect(passed.headers.get("x-test")).toBe("1");
  });

  it("rewrites same-origin EventSource URLs", async () => {
    const { basePathRequestShim } = await loadModule("/9router");
    const win = fakeWindow();
    installShim(basePathRequestShim("/9router"), win);

    new win.EventSource("/api/usage/stream");
    new win.EventSource("/dashboard");
    expect(win.__calls.map((c) => c[1])).toEqual([
      "http://localhost:3000/9router/api/usage/stream",
      "/dashboard",
    ]);
  });
});
