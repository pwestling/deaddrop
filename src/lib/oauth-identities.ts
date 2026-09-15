import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { APIError } from "better-auth/api";
import { getOAuthProviderState } from "@better-auth/oauth-provider";
import { z } from "zod";
import { appUrl, ownerEmail, SCOPES } from "./config";
import { db } from "./db";
import { AppError, errorResponse, jsonBody } from "./errors";
import { CONNECTION_CLAIM, IdentityStore } from "./identities";
import { identityName } from "./validation";

// Request-local state avoids mixing simultaneous approvals in the same browser session.
const approval = new AsyncLocalStorage<{
  name: string;
  signedQuery: string;
  identity?: Promise<string>;
}>();
const identities = new IdentityStore(db);

export async function handleNamedConsent(
  request: Request,
  handler: (request: Request) => Promise<Response>,
) {
  if (new URL(request.url).pathname !== "/api/auth/oauth2/consent")
    return handler(request);
  try {
    if (request.headers.get("origin") !== appUrl())
      throw new AppError(
        403,
        "invalid_origin",
        "Approve connections from Deaddrop.",
      );
    const body = z
      .object({
        accept: z.boolean(),
        identity_name: z.unknown().optional(),
        oauth_query: z.string().min(1).max(16000),
      })
      .parse(await jsonBody(request.clone(), 20000));
    if (!body.accept) return handler(request);
    const name = identityName.parse(body.identity_name);
    return await approval.run({ name, signedQuery: body.oauth_query }, () =>
      handler(request),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const oauthIdentityOptions = {
  postLogin: {
    page: "/consent",
    // Every new authorization must pass through naming, even for a previously approved client.
    shouldRedirect: async () => !approval.getStore(),
    consentReferenceId: async ({
      user,
      scopes,
    }: {
      user: { id: string; email: string };
      scopes: string[];
    }) => {
      if (!ownerEmail() || user.email.toLowerCase() !== ownerEmail())
        throw new APIError("FORBIDDEN", {
          message: "Only the owner can connect applications.",
        });
      const current = approval.getStore();
      // Better Auth has already verified the signed OAuth query before invoking this hook.
      const state = await getOAuthProviderState();
      const clientId = new URLSearchParams(state?.query).get("client_id");
      if (!current || !clientId)
        throw new APIError("BAD_REQUEST", {
          message: "Name this connection on the approval screen.",
        });
      current.identity ??= identities.approve({
        name: current.name,
        userId: user.id,
        clientId,
        approvalKey: createHash("sha256")
          .update(`${user.id}\n${current.signedQuery}`)
          .digest("hex"),
        scopes: scopes.filter((scope) =>
          SCOPES.includes(scope as (typeof SCOPES)[number]),
        ),
      });
      try {
        return await current.identity;
      } catch (error) {
        if (error instanceof AppError)
          throw new APIError(error.status === 409 ? "CONFLICT" : "FORBIDDEN", {
            code: error.code,
            message: error.message,
          });
        throw error;
      }
    },
  },
  customAccessTokenClaims: async ({
    user,
    referenceId,
  }: {
    user?: { id: string } | null;
    referenceId?: string;
  }) => {
    // Tokens issued before named identities retain their existing connection mapping.
    if (!referenceId) return {};
    const id = z.uuid().safeParse(referenceId);
    if (!id.success || !user)
      throw new APIError("FORBIDDEN", {
        message: "Invalid connection identity.",
      });
    const result = await db.query(
      "SELECT id FROM dd_connections WHERE id=$1 AND oauth_user_id=$2 AND kind='oauth' AND revoked_at IS NULL",
      [id.data, user.id],
    );
    if (!result.rows.length)
      throw new APIError("FORBIDDEN", {
        message: "This connection was revoked or no longer exists.",
      });
    return { [CONNECTION_CLAIM]: id.data };
  },
};
