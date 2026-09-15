import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db";
import { AppError } from "./errors";
import { mintToken, requireScope, type Principal } from "./security";
import { connectionInput, spaceSlug } from "./validation";
import { store } from "./store";
import { reserveIdentityName } from "./identities";

export function requireOwner(principal: Principal) {
  if (!principal.owner)
    throw new AppError(
      403,
      "owner_required",
      "This action requires the owner account.",
    );
}
export async function overview(principal: Principal) {
  requireOwner(principal);
  const [counts, connections, activity] = await Promise.all([
    db.query(
      `SELECT count(*) FILTER (WHERE archived_at IS NULL AND parent_id IS NULL)::integer AS total,
      count(*) FILTER (WHERE pinned AND archived_at IS NULL)::integer AS pinned,
      (SELECT count(*)::integer FROM dd_files WHERE status='ready') AS files,
      (SELECT COALESCE(sum(size),0)::text FROM dd_files WHERE status='ready') AS storage_bytes,
      count(*) FILTER (WHERE parent_id IS NULL AND archived_at IS NULL AND principal_id<>$1 AND NOT EXISTS (SELECT 1 FROM dd_receipts r WHERE r.drop_id=dd_drops.id AND r.principal_id=$1))::integer AS unread
      FROM dd_drops`,
      [principal.id],
    ),
    listConnections(principal),
    db.query("SELECT * FROM dd_activity ORDER BY id DESC LIMIT 20"),
  ]);
  return {
    ...counts.rows[0],
    connections: connections.connections,
    activity: activity.rows,
  };
}

export async function listConnections(principal: Principal) {
  requireOwner(principal);
  const result = await db.query(
    `SELECT id,name,kind,token_prefix,scopes,spaces,created_at,last_used_at,expires_at,revoked_at FROM dd_connections ORDER BY created_at DESC`,
  );
  return { connections: result.rows };
}

export async function createConnection(principal: Principal, raw: unknown) {
  requireOwner(principal);
  const input = connectionInput.parse(raw);
  if (input.spaces) {
    const spaces = await db.query(
      "SELECT slug FROM dd_spaces WHERE slug=ANY($1::text[])",
      [input.spaces],
    );
    if (spaces.rows.length !== new Set(input.spaces).size)
      throw new AppError(400, "invalid_space", "Choose existing spaces.");
  }
  const { token, tokenHash, prefix } = mintToken();
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + input.expires_in_days * 86400000);
  await db.transaction(async (tx) => {
    await reserveIdentityName(tx, input.name);
    await tx.query(
      `INSERT INTO dd_connections(id,name,kind,token_hash,token_prefix,scopes,spaces,expires_at)
    VALUES($1,$2,'token',$3,$4,$5,$6,$7)`,
      [
        id,
        input.name,
        tokenHash,
        prefix,
        input.scopes,
        input.spaces,
        expiresAt,
      ],
    );
  });
  await store.activity(principal.name, "connected", id, input.name);
  return { id, name: input.name, token, expires_at: expiresAt.toISOString() };
}

export async function revokeConnection(principal: Principal, id: string) {
  requireOwner(principal);
  const result = await db.query<{ name: string }>(
    "UPDATE dd_connections SET revoked_at=now() WHERE id=$1 RETURNING name",
    [z.uuid().parse(id)],
  );
  if (!result.rows[0])
    throw new AppError(404, "not_found", "Connection not found.");
  await store.activity(principal.name, "revoked", id, result.rows[0].name);
  return { revoked: true };
}

export async function listSpaces(principal: Principal) {
  requireScope(principal, "deaddrop:read");
  const result = await db.query(
    "SELECT * FROM dd_spaces WHERE $1::text[] IS NULL OR slug=ANY($1::text[]) ORDER BY name",
    [principal.spaces],
  );
  return { spaces: result.rows };
}
export async function createSpace(principal: Principal, raw: unknown) {
  requireOwner(principal);
  const input = z
    .object({ slug: spaceSlug, name: z.string().trim().min(1).max(80) })
    .strict()
    .parse(raw);
  const result = await db.query(
    "INSERT INTO dd_spaces(slug,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING *",
    [input.slug, input.name],
  );
  if (!result.rows[0])
    throw new AppError(409, "space_exists", "This space already exists.");
  return { space: result.rows[0] };
}
