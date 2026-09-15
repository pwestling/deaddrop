import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it.each([
  ["https://handoffs.example.com", "https://handoffs.example.com/connection"],
  ["https://notes.example.net/", "https://notes.example.net/connection"],
])(
  "namespaces OAuth identities under the configured origin %s",
  async (origin, claim) => {
    vi.stubEnv("APP_URL", origin);
    vi.resetModules();
    const { CONNECTION_CLAIM } = await import("../src/lib/identities");
    expect(CONNECTION_CLAIM).toBe(claim);
  },
);

it("preserves named identities from the original token namespace on another domain", async () => {
  vi.stubEnv("APP_URL", "https://handoffs.example.com");
  const { oauthConnectionClaim, LEGACY_CONNECTION_CLAIM } =
    await import("../src/lib/identities");
  expect(
    oauthConnectionClaim({ [LEGACY_CONNECTION_CLAIM]: "existing-id" }),
  ).toBe("existing-id");
  expect(oauthConnectionClaim({})).toBeUndefined();
});

it("does not fall back to an older identity when a new claim is malformed", async () => {
  vi.stubEnv("APP_URL", "https://handoffs.example.com");
  const { oauthConnectionClaim, CONNECTION_CLAIM, LEGACY_CONNECTION_CLAIM } =
    await import("../src/lib/identities");
  expect(
    oauthConnectionClaim({
      [CONNECTION_CLAIM]: null,
      [LEGACY_CONNECTION_CLAIM]: "existing-id",
    }),
  ).toBeNull();
});
