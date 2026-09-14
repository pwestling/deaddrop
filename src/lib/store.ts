import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, type Database, type Queryable } from "./db";
import { AppError } from "./errors";
import { hash, requireScope, requireSpace, type Principal } from "./policy";
import { dropInput, listInput } from "./validation";

export interface Drop {
  id: string;
  title: string;
  body: string;
  sender: string;
  space: string;
  principal_id: string;
  recipient: string | null;
  tags: string[];
  parent_id: string | null;
  thread_id: string;
  pinned: boolean;
  archived_at: string | null;
  created_at: string;
  unread?: boolean;
  attachment_count?: number;
  reply_count?: number;
}
export interface Attachment {
  id: string;
  name: string;
  content_type: string;
  size: string | number;
  space: string;
  pathname: string;
  principal_id: string;
  status: "pending" | "ready";
  drop_id: string | null;
  created_at: string;
}

export const cursorSchema = z.object({
  created_at: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});
export function decodeCursor(cursor: string) {
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw new AppError(
      400,
      "invalid_cursor",
      "The pagination cursor is invalid.",
    );
  }
}
export function encodeCursor(drop: Drop) {
  return Buffer.from(
    JSON.stringify({
      created_at: drop.created_at,
      id: drop.id,
    }),
  ).toString("base64url");
}

export class DropStore {
  constructor(private database: Database) {}

  async activity(
    actor: string,
    action: string,
    target: string | null,
    detail: string | null = null,
    tx: Queryable = this.database,
  ) {
    await tx.query(
      "INSERT INTO dd_activity(actor,action,target_id,detail) VALUES($1,$2,$3,$4)",
      [actor, action, target, detail],
    );
  }

  async get(
    principal: Principal,
    id: string,
    tx: Queryable = this.database,
  ): Promise<Drop> {
    requireScope(principal, "deaddrop:read");
    const result = await tx.query<Drop>("SELECT * FROM dd_drops WHERE id=$1", [
      z.uuid().parse(id),
    ]);
    const drop = result.rows[0];
    if (!drop) throw new AppError(404, "not_found", "Drop not found.");
    requireSpace(principal, drop.space);
    return drop;
  }

  async list(principal: Principal, raw: unknown) {
    requireScope(principal, "deaddrop:read");
    const input = listInput.parse(raw);
    if (input.space) requireSpace(principal, input.space);
    const args: unknown[] = [principal.id];
    const where = [
      input.archived ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL",
      "d.parent_id IS NULL",
    ];
    const arg = (value: unknown) => {
      args.push(value);
      return `$${args.length}`;
    };
    if (principal.spaces)
      where.push(`d.space = ANY(${arg(principal.spaces)}::text[])`);
    if (input.space) where.push(`d.space=${arg(input.space)}`);
    if (input.recipient) where.push(`d.recipient=${arg(input.recipient)}`);
    if (input.q)
      where.push(
        `(to_tsvector('english',d.title || ' ' || d.body) @@ websearch_to_tsquery('english',${arg(input.q)}) OR d.title ILIKE ${arg(`%${input.q.replace(/[\\%_]/g, "\\$&")}%`)})`,
      );
    if (input.unread) where.push("r.drop_id IS NULL AND d.principal_id <> $1");
    if (input.pinned) where.push("d.pinned=true");
    if (input.with_files)
      where.push("EXISTS (SELECT 1 FROM dd_files f WHERE f.drop_id=d.id)");
    if (input.cursor) {
      const cursor = decodeCursor(input.cursor);
      where.push(
        `(d.created_at,d.id)<(${arg(cursor.created_at)}::timestamptz,${arg(cursor.id)}::uuid)`,
      );
    }
    const result = await this.database.query<Drop>(
      `SELECT d.*, to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
       (r.drop_id IS NULL AND d.principal_id<>$1) AS unread,
       (SELECT count(*)::integer FROM dd_files f WHERE f.drop_id=d.id) AS attachment_count,
       (SELECT count(*)::integer FROM dd_drops reply WHERE reply.thread_id=d.id AND reply.parent_id IS NOT NULL) AS reply_count
       FROM dd_drops d LEFT JOIN dd_receipts r ON r.drop_id=d.id AND r.principal_id=$1
       WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC,d.id DESC LIMIT ${arg(input.limit + 1)}`,
      args,
    );
    const more = result.rows.length > input.limit;
    const drops = result.rows.slice(0, input.limit);
    return {
      drops,
      next_cursor: more ? encodeCursor(drops[drops.length - 1]) : null,
    };
  }

  async detail(principal: Principal, id: string) {
    const drop = await this.get(principal, id);
    const [files, replies] = await Promise.all([
      this.database.query<Attachment>(
        "SELECT id,name,content_type,size,drop_id,status FROM dd_files WHERE drop_id=$1 ORDER BY created_at",
        [drop.id],
      ),
      this.database.query<Drop>(
        "SELECT * FROM dd_drops WHERE thread_id=$1 AND parent_id IS NOT NULL ORDER BY created_at,id",
        [drop.thread_id],
      ),
    ]);
    return { drop, attachments: files.rows, replies: replies.rows };
  }

  async create(principal: Principal, raw: unknown, idempotencyKey?: string) {
    requireScope(principal, "deaddrop:write");
    const input = dropInput.parse(raw);
    requireSpace(principal, input.space);
    if (new Set(input.attachment_ids).size !== input.attachment_ids.length)
      throw new AppError(
        400,
        "duplicate_attachment",
        "Each attachment can appear only once.",
      );
    if (
      idempotencyKey &&
      (idempotencyKey.length > 150 || !/^[\x21-\x7e]+$/.test(idempotencyKey))
    )
      throw new AppError(
        400,
        "invalid_idempotency_key",
        "Use a printable key of at most 150 characters.",
      );
    const requestHash = hash(JSON.stringify(input));
    return this.database.transaction(async (tx) => {
      // Serialize identical retry keys across serverless instances before checking the result.
      if (idempotencyKey) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `${principal.id}:${idempotencyKey}`,
        ]);
        const existing = await tx.query<Drop & { request_hash: string }>(
          "SELECT * FROM dd_drops WHERE principal_id=$1 AND idempotency_key=$2",
          [principal.id, idempotencyKey],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== requestHash)
            throw new AppError(
              409,
              "idempotency_conflict",
              "This key was already used for a different drop.",
            );
          return { drop: existing.rows[0], replayed: true };
        }
      }
      const spaces = await tx.query(
        "SELECT slug FROM dd_spaces WHERE slug=$1",
        [input.space],
      );
      if (!spaces.rows.length)
        throw new AppError(404, "not_found", "Space not found.");
      let threadId: string = randomUUID();
      const id = threadId;
      if (input.parent_id) {
        const parent = await tx.query<Drop>(
          "SELECT * FROM dd_drops WHERE id=$1",
          [input.parent_id],
        );
        if (!parent.rows[0] || parent.rows[0].space !== input.space)
          throw new AppError(
            404,
            "not_found",
            "Parent drop not found in this space.",
          );
        threadId = parent.rows[0].thread_id;
      }
      if (input.attachment_ids.length) {
        const files = await tx.query<Attachment>(
          "SELECT * FROM dd_files WHERE id=ANY($1::uuid[]) AND principal_id=$2 AND space=$3 AND status='ready' AND drop_id IS NULL FOR UPDATE",
          [input.attachment_ids, principal.id, input.space],
        );
        if (files.rows.length !== input.attachment_ids.length)
          throw new AppError(
            409,
            "attachment_unavailable",
            "Attachments must be uploaded by this connection, ready, unused, and in this space.",
          );
      }
      const result = await tx.query<Drop>(
        `INSERT INTO dd_drops(id,space,title,body,sender,principal_id,recipient,tags,parent_id,thread_id,idempotency_key,request_hash)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          id,
          input.space,
          input.title,
          input.body,
          principal.name,
          principal.id,
          input.recipient || null,
          input.tags,
          input.parent_id || null,
          threadId,
          idempotencyKey || null,
          requestHash,
        ],
      );
      await tx.query(
        "UPDATE dd_files SET drop_id=$1 WHERE id=ANY($2::uuid[])",
        [id, input.attachment_ids],
      );
      await this.activity(
        principal.name,
        input.parent_id ? "replied" : "created",
        id,
        input.title,
        tx,
      );
      return { drop: result.rows[0], replayed: false };
    });
  }

  async acknowledge(principal: Principal, id: string) {
    await this.get(principal, id);
    await this.database.query(
      "INSERT INTO dd_receipts(drop_id,principal_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [id, principal.id],
    );
    return { acknowledged: true, id };
  }

  async update(principal: Principal, id: string, raw: unknown) {
    if (!principal.owner)
      throw new AppError(
        403,
        "owner_required",
        "Only the owner can organize drops.",
      );
    const change = z
      .object({
        pinned: z.boolean().optional(),
        archived: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    await this.get(principal, id);
    const result = await this.database.query<Drop>(
      `UPDATE dd_drops SET pinned=COALESCE($2,pinned),
       archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN now() ELSE NULL END
       WHERE id=$1 RETURNING *`,
      [id, change.pinned ?? null, change.archived ?? null],
    );
    await this.activity(principal.name, "organized", id);
    return { drop: result.rows[0] };
  }

  async file(principal: Principal, id: string) {
    requireScope(principal, "deaddrop:read");
    const result = await this.database.query<Attachment>(
      "SELECT * FROM dd_files WHERE id=$1",
      [z.uuid().parse(id)],
    );
    const file = result.rows[0];
    if (
      !file ||
      (!file.drop_id && file.principal_id !== principal.id && !principal.owner)
    )
      throw new AppError(404, "not_found", "File not found.");
    requireSpace(principal, file.space);
    if (file.drop_id) await this.get(principal, file.drop_id);
    return file;
  }
}
export const store = new DropStore(db);
