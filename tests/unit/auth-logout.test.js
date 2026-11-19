import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
  cookieStore: { set: vi.fn(), delete: vi.fn(), get: vi.fn() },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => mocks.cookieStore),
}));

// BASE_PATH and AUTH_COOKIE_NAME are read at module load, so the route (and
// dashboardSession) must be re-imported after stubbing the env.
async function loadRoute(basePath) {
  vi.resetModules();
  vi.stubEnv("JWT_SECRET", "test-secret-for-auth-logout-tests");
  if (basePath === undefined) vi.stubEnv("NEXT_PUBLIC_BASE_PATH", "");
  else vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
  return import("../../src/app/api/auth/logout/route.js");
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("POST /api/auth/logout under a base path", () => {
  it("deletes the auth and OIDC cookies scoped to the base path", async () => {
    const { POST } = await loadRoute("/9router");
    await POST();
    expect(mocks.cookieStore.delete).toHaveBeenCalledTimes(4);
    expect(mocks.cookieStore.delete.mock.calls.map((c) => c[0])).toEqual([
      { name: "9router_auth_token", path: "/9router" },
      { name: "oidc_state", path: "/9router" },
      { name: "oidc_nonce", path: "/9router" },
      { name: "oidc_code_verifier", path: "/9router" },
    ]);
  });
});

describe("POST /api/auth/logout at the root", () => {
  it("deletes the same four cookies with auth_token and /", async () => {
    const { POST } = await loadRoute(undefined);
    await POST();
    expect(mocks.cookieStore.delete).toHaveBeenCalledTimes(4);
    expect(mocks.cookieStore.delete.mock.calls.map((c) => c[0])).toEqual([
      { name: "auth_token", path: "/" },
      { name: "oidc_state", path: "/" },
      { name: "oidc_nonce", path: "/" },
      { name: "oidc_code_verifier", path: "/" },
    ]);
  });
});
