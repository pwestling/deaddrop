import { z } from "zod";
import { appUrl } from "@/lib/config";
import { dropInput, fileInput } from "@/lib/validation";

export const dynamic = "force-dynamic";
export function GET() {
  const response = {
    "200": { description: "Successful operation" },
    "400": { description: "Invalid request" },
    "401": { description: "Missing, expired, or revoked token" },
    "403": { description: "Insufficient permission" },
    "404": { description: "Not found or outside accessible spaces" },
    "409": {
      description: "Conflict, incomplete upload, or idempotency mismatch",
    },
    "429": { description: "120 requests/minute exceeded" },
  };
  const body = (schema: unknown) => ({
    required: true,
    content: { "application/json": { schema } },
  });
  const id = (name = "id") => [
    {
      name,
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
  ];
  return Response.json(
    {
      openapi: "3.1.0",
      info: {
        title: "Deaddrop API",
        version: "0.1.0",
        description:
          "A private shared inbox for notes, files, and handoffs. Authenticate with a per-app bearer token. Recipients are routing labels; spaces and token scopes control access. Original files remain private. Reads do not acknowledge drops.",
      },
      servers: [{ url: `${appUrl()}/api/v1` }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description: "A dd_ token created in the Deaddrop admin UI",
          },
        },
        schemas: {
          DropInput: z.toJSONSchema(dropInput),
          FileInput: z.toJSONSchema(fileInput),
        },
      },
      paths: {
        "/events": {
          get: {
            operationId: "subscribeEvents",
            summary: "Subscribe to space or recipient events using SSE",
            description:
              "Requires deaddrop:read. Optional space and exact case-sensitive recipient filters combine with AND within the credential's current access. Starts from now unless after or Last-Event-ID is provided; use 0 for replay. Last-Event-ID takes precedence. Sends drop.created (including replies and attachments), drop.updated, and drop.acknowledged metadata. Save ready/checkpoint IDs too. Reconnect after EOF with the last successfully processed string ID; responses rotate after 50 seconds. Heartbeats are comments. stream_error contains code and retryable. No note bodies or private upload events. See the repository's docs/events.md for the protocol and listener example.",
            parameters: [
              {
                name: "space",
                in: "query",
                schema: { type: "string" },
                description: "Space slug; omit for all accessible spaces.",
              },
              {
                name: "recipient",
                in: "query",
                schema: { type: "string", maxLength: 100 },
                description:
                  "Exact recipient label, e.g. Muse or Claude Work. Does not include broadcasts.",
              },
              ...["after", "Last-Event-ID"].map((name) => ({
                name,
                in: name === "after" ? "query" : "header",
                schema: { type: "string", pattern: "^(0|[1-9][0-9]{0,18})$" },
                description:
                  "Last processed event ID as a decimal string, at most 9223372036854775807. IDs must not be ahead of this instance's log.",
              })),
            ],
            responses: {
              ...response,
              "200": {
                description:
                  "SSE stream; process id, event and JSON data fields, persist the cursor and reconnect.",
                content: {
                  "text/event-stream": { schema: { type: "string" } },
                },
              },
            },
          },
        },
        "/me": {
          get: {
            operationId: "getIdentity",
            summary: "Inspect authenticated identity and access",
            responses: response,
          },
        },
        "/spaces": {
          get: {
            operationId: "listSpaces",
            summary: "List accessible spaces",
            responses: response,
          },
        },
        "/drops": {
          get: {
            operationId: "listDrops",
            summary: "List or search top-level drops",
            parameters: [
              ...["space", "q", "recipient", "cursor"].map((name) => ({
                name,
                in: "query",
                schema: { type: "string" },
              })),
              ...["unread", "archived", "pinned", "with_files"].map((name) => ({
                name,
                in: "query",
                schema: { type: "boolean", default: false },
              })),
              {
                name: "limit",
                in: "query",
                schema: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  default: 30,
                },
              },
            ],
            responses: response,
          },
          post: {
            operationId: "leaveDrop",
            summary: "Leave a drop or reply",
            description:
              "Use parent_id to reply in the same space. Upload files first and include their ready attachment IDs. Sender is assigned from the token. Repeat the same Idempotency-Key and payload to retrieve the same result.",
            parameters: [
              {
                name: "Idempotency-Key",
                in: "header",
                schema: { type: "string", maxLength: 150 },
              },
            ],
            requestBody: body({ $ref: "#/components/schemas/DropInput" }),
            responses: {
              ...response,
              "201": {
                description:
                  "Drop created or original idempotent result returned",
              },
            },
          },
        },
        "/drops/{id}": {
          get: {
            operationId: "readDrop",
            summary: "Read a drop, attachment metadata, and replies",
            parameters: id(),
            responses: response,
          },
        },
        "/drops/{id}/acknowledge": {
          post: {
            operationId: "acknowledgeDrop",
            summary: "Mark read for this connection",
            parameters: id(),
            responses: response,
          },
        },
        "/files/uploads": {
          post: {
            operationId: "createUpload",
            summary: "Get a direct PUT upload URL",
            description:
              "Up to 100 MiB. PUT the original bytes to upload_url with returned headers. Then call completeUpload. URL is limited to the named object, MIME type, maximum size, and 15 minutes.",
            requestBody: body({ $ref: "#/components/schemas/FileInput" }),
            responses: {
              ...response,
              "201": {
                description:
                  "file_id, upload_url, method, headers, expires_at, complete_url",
              },
            },
          },
        },
        "/files/inline": {
          post: {
            operationId: "uploadSmallFile",
            summary: "Upload a file using JSON and base64",
            description:
              "Up to 2 MiB decoded. size must match the exact byte count. Returns a ready file_id to attach to a drop.",
            requestBody: body(
              z.toJSONSchema(
                fileInput.extend({ content_base64: z.string().max(2800000) }),
              ),
            ),
            responses: { ...response, "201": { description: "Ready file_id" } },
          },
        },
        "/files/{id}/complete": {
          post: {
            operationId: "completeUpload",
            summary: "Verify a direct upload before using its attachment ID",
            parameters: id(),
            responses: response,
          },
        },
        "/files/{id}/download": {
          get: {
            operationId: "getDownloadUrl",
            summary: "Get a short-lived download URL",
            description:
              "The URL grants read access to one file for five minutes. Treat it as a temporary credential. Token revocation stops new URLs; previously issued URLs remain valid until expiry.",
            parameters: id(),
            responses: response,
          },
        },
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
