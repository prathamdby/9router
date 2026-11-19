import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

// dashboardSession reads NEXT_PUBLIC_BASE_PATH at module load and derives a
// JWT secret from JWT_SECRET env (stubbed so no files are written).
async function loadModule(basePath) {
  vi.resetModules();
  vi.stubEnv("JWT_SECRET", "test-secret-for-dashboard-session-cookie-tests");
  if (basePath === undefined) vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  else vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
  return import("../../src/lib/auth/dashboardSession.js");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function fakeCookieStore() {
  return { set: vi.fn(), delete: vi.fn(), get: vi.fn() };
}

const fakeRequest = { headers: new Headers() };

describe("dashboard session cookie under a base path", () => {
  it("uses the 9router_auth_token name scoped to the base path", async () => {
    const { AUTH_COOKIE_NAME } = await loadModule("/9router");
    expect(AUTH_COOKIE_NAME).toBe("9router_auth_token");
  });

  it("sets the cookie with path equal to the base path", async () => {
    const { setDashboardAuthCookie } = await loadModule("/9router");
    const store = fakeCookieStore();
    await setDashboardAuthCookie(store, fakeRequest);
    expect(store.set).toHaveBeenCalledTimes(1);
    const [name, token, options] = store.set.mock.calls[0];
    expect(name).toBe("9router_auth_token");
    expect(typeof token).toBe("string");
    expect(options.path).toBe("/9router");
    expect(options.httpOnly).toBe(true);
  });

  it("clears the cookie with an explicit base-path delete", async () => {
    const { clearDashboardAuthCookie } = await loadModule("/9router");
    const store = fakeCookieStore();
    clearDashboardAuthCookie(store);
    expect(store.delete).toHaveBeenCalledWith({
      name: "9router_auth_token",
      path: "/9router",
    });
  });
});

describe("dashboard session cookie at the root", () => {
  it("keeps the auth_token name and / path", async () => {
    const { AUTH_COOKIE_NAME, setDashboardAuthCookie, clearDashboardAuthCookie } =
      await loadModule(undefined);
    expect(AUTH_COOKIE_NAME).toBe("auth_token");

    const store = fakeCookieStore();
    await setDashboardAuthCookie(store, fakeRequest);
    const [name, , options] = store.set.mock.calls[0];
    expect(name).toBe("auth_token");
    expect(options.path).toBe("/");

    clearDashboardAuthCookie(store);
    expect(store.delete).toHaveBeenCalledWith({ name: "auth_token", path: "/" });
  });
});
