import { describe, it, expect, vi, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("@/lib/db/repos/settingsRepo", () => ({
  getSettings: mocks.getSettings,
}));

// BASE_PATH is read at module load; env stubs must precede the dynamic import.
async function load(basePath) {
  vi.resetModules();
  if (basePath === undefined) vi.unstubAllEnvs();
  else vi.stubEnv("NEXT_PUBLIC_BASE_PATH", basePath);
  const [saml, oidc] = await Promise.all([
    import("../../src/lib/auth/saml.js"),
    import("../../src/lib/auth/oidc.js"),
  ]);
  return { saml, oidc };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("SSO callbacks under a base path", () => {
  it("builds the SAML ACS callback under the base path", async () => {
    const { saml } = await load("/9router");
    const instance = saml.createSamlInstance({}, "https://app.example");
    expect(instance.options.callbackUrl).toBe(
      "https://app.example/9router/api/auth/saml/acs"
    );
  });

  it("strips a duplicated base path from settings.baseUrl", async () => {
    const { saml } = await load("/9router");
    expect(
      saml.getSamlBaseUrl(null, { baseUrl: "https://app.example/9router/" })
    ).toBe("https://app.example");
  });

  it("strips a duplicated base path from the OIDC public origin", async () => {
    const { oidc } = await load("/9router");
    vi.stubEnv("BASE_URL", "https://app.example/9router");
    expect(oidc.getPublicOrigin()).toBe("https://app.example");
  });

  it("leaves unrelated configured paths alone", async () => {
    const { oidc } = await load("/9router");
    vi.stubEnv("BASE_URL", "https://app.example/other");
    expect(oidc.getPublicOrigin()).toBe("https://app.example/other");
  });
});

describe("SSO callbacks at the root", () => {
  it("does not strip a base-path-looking path when no base path is built", async () => {
    const { oidc } = await load(undefined);
    vi.stubEnv("BASE_URL", "https://app.example/9router");
    expect(oidc.getPublicOrigin()).toBe("https://app.example/9router");
  });
});
