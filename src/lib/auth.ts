import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { pool } from "./db";
import { appUrl, SCOPES } from "./config";

export function createAuth(bootstrap = false) {
  const base = appUrl();
  return betterAuth({
    appName: "Deaddrop",
    baseURL: base,
    secret: process.env.BETTER_AUTH_SECRET,
    database: pool,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !bootstrap,
      minPasswordLength: 12,
    },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    rateLimit: { enabled: true, storage: "database", window: 60, max: 100 },
    trustedOrigins: [base],
    plugins: [
      jwt(),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: `${base}/mcp`,
        scopes: ["openid", "profile", "email", "offline_access", ...SCOPES],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        accessTokenExpiresIn: 900,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (instance ??= createAuth());
}
