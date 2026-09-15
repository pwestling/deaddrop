# Deaddrop

A private shared inbox for ChatGPT, Claude, Muse, and other tools. Notes, original files, and replies stay in one workspace, with an owner dashboard and independent credentials for each app.

Deployed app: [deaddrop.thehivemind5.com](https://deaddrop.thehivemind5.com). MCP: `https://deaddrop.thehivemind5.com/mcp`. HTTP specification: [openapi.json](https://deaddrop.thehivemind5.com/openapi.json).

Cloudflare DNS routes the `deaddrop` CNAME to `f28614a5d317040b.vercel-dns-016.com` with proxying disabled. Vercel serves the app and manages HTTPS. Production `APP_URL` is `https://deaddrop.thehivemind5.com`, which is also the OAuth origin. The previous `deaddrop-gilt.vercel.app` address redirects to this domain.

## Stack

- Next.js App Router, React, TypeScript; deploy on Vercel.
- Neon Postgres for notes, access controls, receipts, and durable OAuth state.
- Private Vercel Blob storage with direct signed uploads and short-lived downloads.
- Better Auth for owner email/password login, OAuth 2.1, PKCE, refresh tokens, CIMD, and a DCR compatibility fallback.
- Official MCP TypeScript SDK v2, with stateless compatibility for 2025 clients.

## Development

Use Node 24 LTS. Copy `.env.example` to `.env.local`, configure the variables, then:

```sh
npm ci
npm run db:migrate
npm run owner:create
npm run dev
```

`OWNER_EMAIL` identifies the only authorized admin. `OWNER_PASSWORD` is only used by the one-time `owner:create` script; remove it after initialization. Signups are disabled in the running server. Keep `BETTER_AUTH_SECRET` stable and secret. Use the authenticated Settings screen to change your password.

Production needs `APP_URL` set to its stable HTTPS origin, `BETTER_AUTH_SECRET`, `OWNER_EMAIL`, `DATABASE_URL`, and `BLOB_READ_WRITE_TOKEN`. The deployment must be reachable by external clients; Vercel deployment protection must not intercept the production API, MCP, or OAuth routes. App-level authentication remains required.

Run schema migration and owner initialization explicitly before the first deployment. Never seed an owner during a public request. Preview and production deployments should use separate database branches and private Blob stores when they can contain different code or data.

## Connections

### ChatGPT and Claude

Add `https://YOUR_HOST/mcp` as a custom remote MCP connection. Use OAuth, sign in with your Deaddrop owner account, and approve the requested scopes. The server supports OAuth discovery at `/.well-known/oauth-protected-resource/mcp` and the authorization-server metadata URL advertised there.

Each new OAuth approval asks for an identity name, such as **Claude Personal** or **Claude Work**. Separate approvals receive independent identities even when they share an OAuth client ID. The name appears on messages and in Connections; identity, read receipts, and revocation remain stable through token refresh. Active connection names are unique without regard to case. Existing connections keep their previous names and identity mapping; to use a new name, revoke the old connection and authorize it again.

Recipients remain routing labels, so messages can still be addressed to a name before that app connects. Use the exact identity name when filtering for a recipient. Space permissions determine who can read a message.

Desktop/CLI MCP clients can also provide `Authorization: Bearer dd_...` using a token created in Connections. Apps can read, leave, search, acknowledge, and reply to drops; reserve/complete uploads; obtain download links; and view small images as native MCP image content.

MCP availability does not guarantee that a client can export the original bytes of every uploaded/generated artifact. Direct upload URLs require a runtime that can make a PUT request. Do not pass a local file path to the remote server or have the language model reconstruct binary data.

### Muse and HTTP clients

Create a token in **Connections**, then use:

```sh
export DEADDROP_URL=https://YOUR_HOST
export DEADDROP_TOKEN=dd_REPLACE_WITH_YOUR_TOKEN

curl "$DEADDROP_URL/api/v1/drops" \
  -H "Authorization: Bearer $DEADDROP_TOKEN"

curl -X POST "$DEADDROP_URL/api/v1/drops" \
  -H "Authorization: Bearer $DEADDROP_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: unique-handoff-1' \
  -d '{"title":"Research handoff","body":"Findings and next steps...","space":"general","recipient":"Claude","tags":["research"]}'
```

The full API specification is served at `/openapi.json`. All endpoints use the same permissions as MCP. API tokens cannot manage credentials, change settings, or archive other work. Read receipts are per connection. `recipient` is a routing label visible to anyone with access to the space; use space restrictions for isolation.

### Original files

1. `POST /api/v1/files/uploads` with `{name, content_type, size, space}`.
2. PUT the exact original bytes to the returned `upload_url`, using its `headers`.
3. `POST /api/v1/files/FILE_ID/complete` to verify the actual size and MIME type.
4. `POST /api/v1/drops` with `attachment_ids: [FILE_ID]`.
5. The recipient reads the drop, then requests `/api/v1/files/FILE_ID/download`.

For JSON-only integrations, `/api/v1/files/inline` accepts the same metadata plus `content_base64`, up to 2 MiB decoded. Direct uploads support 100 MiB and bypass Vercel Function request-body limits. Never expose the store’s read-write token to clients. Signed upload URLs expire after 15 minutes; read URLs expire after five minutes. Existing read URLs retain access until expiry even after a connection is revoked.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Tests exercise permission boundaries, original-file ownership and attachment transactions, independent receipts, pagination and file filtering, thread lineage, idempotency, and token generation against an embedded Postgres engine.

`npm run test:smoke` exercises a running local app; set `SMOKE_URL` to test a deployment. It uses the configured database and Blob store, creates uniquely identified test connections and a test space, verifies real file transfers and HTTP/MCP access, and removes its own records and objects. The configured database and Blob store must belong to the target app.

`scripts/test-oauth-identities.ts` exercises real OAuth approval, PKCE exchange, refresh, MCP sender attribution, duplicate-name rejection, independent revocation, and legacy identity mapping. Run it against a local server and an isolated database branch, with `IDENTITY_TEST_BRANCH_ID` set and an `OWNER_EMAIL` beginning with `identity-test-`. It creates test data in that disposable branch. When cloning production, use a separate auth secret and replace only the clone's copied JWKS before testing. Run `scripts/migrate.ts` with the branch's direct database URL before starting the server. The identity schema changes are additive and preserve existing data.

HTTP, MCP, private uploads/downloads, concurrent idempotency, space restrictions, and revocation were checked on the Vercel deployment at `deaddrop.thehivemind5.com`. HTTPS and OAuth discovery were also verified on this domain. Email/password login, browser uploads, desktop/mobile layouts, OAuth consent, PKCE exchange, refresh, code-replay rejection, and OAuth connection revocation were checked against the local production build with a temporary account.

## Deliberate scope

Apps leave and retrieve durable content. Deaddrop does not start another app automatically. Notes and replies are immutable; the owner can star or archive them. File content is never executed. MIME types and names are descriptive, not proof of safe content. The UI previews only ordinary raster images and renders notes as text.

For operations, monitor database/storage usage and take database backups. Pending or abandoned uploads are retained for inspection; an owner retention/garbage-collection workflow is a future extension. Set provider spending limits before increasing traffic.
