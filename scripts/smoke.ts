import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { del } from "@vercel/blob";
import { pool } from "../src/lib/db";
import { mintToken } from "../src/lib/policy";

const base = process.env.SMOKE_URL || "http://localhost:3000";
const space = `smoke-${randomUUID().slice(0, 8)}`;
const principals = [randomUUID(), randomUUID(), randomUUID()];
const tokens = principals.map(() => mintToken());
const client = new Client({ name: "Deaddrop smoke check", version: "1.0.0" });

async function api(
  path: string,
  index = 0,
  method = "GET",
  body?: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[index].token}`,
      "Content-Type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(
    response.status,
    status,
    `${method} ${path}: ${JSON.stringify(data)}`,
  );
  return data;
}

async function main() {
  await pool.query("INSERT INTO dd_spaces(slug,name) VALUES($1,$2)", [
    space,
    "Smoke verification",
  ]);
  for (let index = 0; index < principals.length; index++) {
    await pool.query(
      "INSERT INTO dd_connections(id,name,kind,token_hash,token_prefix,scopes,spaces) VALUES($1,$2,'token',$3,$4,$5,$6)",
      [
        principals[index],
        `Smoke ${index}`,
        tokens[index].tokenHash,
        tokens[index].prefix,
        index === 1 ? ["deaddrop:read"] : ["deaddrop:read", "deaddrop:write"],
        index === 2 ? ["general"] : [space],
      ],
    );
  }
  assert.equal((await fetch(`${base}/api/v1/drops`)).status, 401);
  await api("connections", 0, "GET", undefined, 403);
  const payload = {
    title: "Smoke handoff",
    body: "Original context survives across interfaces.",
    space,
  };
  const requests = await Promise.all(
    [0, 1, 2].map(() =>
      api("drops", 0, "POST", payload, 201, {
        "Idempotency-Key": "concurrent-smoke",
      }),
    ),
  );
  assert.equal(new Set(requests.map((r) => r.drop.id)).size, 1);
  const id = requests[0].drop.id;
  await api("drops", 0, "POST", { ...payload, body: "different" }, 409, {
    "Idempotency-Key": "concurrent-smoke",
  });
  await api("drops", 1, "POST", payload, 403);
  await api(`drops/${id}`, 2, "GET", undefined, 404);
  assert.equal((await api("drops?unread=true", 1)).drops.length, 1);
  await api(`drops/${id}`, 1);
  assert.equal((await api("drops?unread=true", 1)).drops.length, 1);
  await api(`drops/${id}/acknowledge`, 1, "POST", {});
  assert.equal((await api("drops?unread=true", 1)).drops.length, 0);
  console.log(
    "PASS: HTTP authentication, spaces, read-only access, concurrent retries, receipts",
  );

  const bytes = Buffer.from("Original file bytes.\n", "utf8");
  const upload = await api(
    "files/uploads",
    0,
    "POST",
    {
      name: "original.txt",
      content_type: "text/plain",
      size: bytes.length,
      space,
    },
    201,
  );
  const uploaded = await fetch(upload.upload_url, {
    method: upload.method,
    headers: upload.headers,
    body: bytes,
  });
  assert.equal(
    uploaded.ok,
    true,
    `Direct upload HTTP ${uploaded.status}: ${await uploaded.text()}`,
  );
  await api(`files/${upload.file_id}/complete`, 0, "POST", {});
  await api(`files/${upload.file_id}/download`, 1, "GET", undefined, 404);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a04sAAAAASUVORK5CYII=",
    "base64",
  );
  const inline = await api(
    "files/inline",
    0,
    "POST",
    {
      name: "pixel.png",
      content_type: "image/png",
      size: png.length,
      space,
      content_base64: png.toString("base64"),
    },
    201,
  );
  await api(
    "drops",
    0,
    "POST",
    {
      ...payload,
      title: "Smoke attachments",
      attachment_ids: [upload.file_id, inline.file_id],
    },
    201,
  );
  const download = await api(`files/${upload.file_id}/download`, 1);
  assert.equal((await api("drops?with_files=true", 1)).drops.length, 1);
  const downloaded = await fetch(download.url);
  assert.equal(
    downloaded.ok,
    true,
    `Signed download HTTP ${downloaded.status}`,
  );
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  await api(`files/${upload.file_id}/download`, 2, "GET", undefined, 404);
  console.log(
    "PASS: private direct upload, inline image upload, attachment ownership, exact download bytes",
  );

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens[0].token}` } },
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 10);
  const found = await client.callTool({
    name: "list_drops",
    arguments: { space },
  });
  assert.notEqual(found.isError, true);
  const result = await client.callTool({
    name: "read_drop",
    arguments: { id },
  });
  assert.notEqual(result.isError, true);
  const image = await client.callTool({
    name: "view_image",
    arguments: { file_id: inline.file_id },
  });
  assert.equal(image.content[0].type, "image");
  console.log(
    "PASS: MCP handshake, tool discovery, shared HTTP/MCP notes, native image content",
  );
  await pool.query("UPDATE dd_connections SET revoked_at=now() WHERE id=$1", [
    principals[0],
  ]);
  await api("me", 0, "GET", undefined, 401);
  console.log("PASS: token revocation");
}

main()
  .finally(async () => {
    await client.close().catch(() => {});
    const files = await pool.query<{ pathname: string }>(
      "SELECT pathname FROM dd_files WHERE space=$1",
      [space],
    );
    for (const file of files.rows) await del(file.pathname).catch(() => {});
    await pool.query(
      "DELETE FROM dd_receipts WHERE drop_id IN (SELECT id FROM dd_drops WHERE space=$1)",
      [space],
    );
    await pool.query("DELETE FROM dd_files WHERE space=$1", [space]);
    await pool.query(
      "DELETE FROM dd_activity WHERE target_id IN (SELECT id::text FROM dd_drops WHERE space=$1)",
      [space],
    );
    await pool.query("DELETE FROM dd_drops WHERE space=$1", [space]);
    await pool.query(
      "DELETE FROM dd_rate_limits WHERE split_part(key,':',1)=ANY($1::text[])",
      [principals],
    );
    await pool.query("DELETE FROM dd_connections WHERE id=ANY($1::uuid[])", [
      principals,
    ]);
    await pool.query("DELETE FROM dd_spaces WHERE slug=$1", [space]);
    await pool.end();
  })
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
