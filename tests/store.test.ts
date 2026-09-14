import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import { DropStore, decodeCursor } from "../src/lib/store";
import { mintToken, hash, type Principal } from "../src/lib/policy";
import type { Database, Queryable } from "../src/lib/db";
import { fileInput } from "../src/lib/validation";

const engine = new PGlite();
const query: Queryable["query"] = async <T extends QueryResultRow>(
  sql: string,
  values?: unknown[],
) => {
  // PGlite is a single-process Postgres instance; advisory locks have no concurrent sessions.
  if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
  const result = await engine.query<T>(sql, values);
  return { rows: result.rows, rowCount: result.affectedRows };
};
const database: Database = {
  query,
  transaction: (fn) =>
    engine.transaction(async (tx) =>
      fn({
        query: async <T extends QueryResultRow>(
          sql: string,
          values?: unknown[],
        ) => {
          if (sql.startsWith("SELECT pg_advisory_xact_lock"))
            return { rows: [] };
          const result = await tx.query<T>(sql, values);
          return { rows: result.rows, rowCount: result.affectedRows };
        },
      }),
    ),
};
const store = new DropStore(database);
const writer: Principal = {
  id: "writer",
  name: "Muse",
  owner: false,
  scopes: ["deaddrop:read", "deaddrop:write"],
  spaces: ["general"],
};
const reader: Principal = {
  id: "reader",
  name: "Claude",
  owner: false,
  scopes: ["deaddrop:read"],
  spaces: ["general"],
};
const owner: Principal = {
  id: "owner:test",
  name: "Porter",
  owner: true,
  scopes: ["deaddrop:read", "deaddrop:write"],
  spaces: null,
};
beforeAll(async () => {
  await engine.exec(
    await readFile(new URL("../src/lib/schema.sql", import.meta.url), "utf8"),
  );
  await query("INSERT INTO dd_spaces(slug,name) VALUES('private','Private')");
});
afterAll(() => engine.close());

describe("durable handoffs and permissions", () => {
  it("assigns sender identity on the server and rejects spoofed fields", async () => {
    await expect(
      store.create(writer, { title: "spoof", sender: "Porter" }),
    ).rejects.toThrow();
    const { drop } = await store.create(writer, {
      title: "Real handoff",
      body: "Original context",
    });
    expect(drop.sender).toBe("Muse");
    expect(drop.principal_id).toBe("writer");
  });
  it("replays an identical key but rejects a different payload", async () => {
    const a = await store.create(
      writer,
      { title: "One delivery" },
      "retry-key",
    );
    const b = await store.create(
      writer,
      { title: "One delivery" },
      "retry-key",
    );
    expect(b.drop.id).toBe(a.drop.id);
    expect(b.replayed).toBe(true);
    await expect(
      store.create(writer, { title: "Different" }, "retry-key"),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("enforces read-only access and space boundaries", async () => {
    await expect(
      store.create(reader, { title: "Unauthorized" }),
    ).rejects.toMatchObject({ status: 403 });
    const { drop } = await store.create(owner, {
      title: "Private",
      space: "private",
    });
    await expect(store.get(reader, drop.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      store.create(writer, { title: "Cross-space", space: "private" }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await store.list(reader, {})).drops.some((d) => d.id === drop.id),
    ).toBe(false);
  });
  it("keeps receipts independent and reads non-destructive", async () => {
    const { drop } = await store.create(writer, { title: "Read receipt" });
    await store.detail(reader, drop.id);
    expect(
      (await store.list(reader, { unread: true })).drops.some(
        (d) => d.id === drop.id,
      ),
    ).toBe(true);
    await store.acknowledge(reader, drop.id);
    expect(
      (await store.list(reader, { unread: true })).drops.some(
        (d) => d.id === drop.id,
      ),
    ).toBe(false);
    expect(
      (await store.list(owner, { unread: true })).drops.some(
        (d) => d.id === drop.id,
      ),
    ).toBe(true);
  });
  it("paginates without duplicate drops", async () => {
    const first = await store.list(owner, { limit: 2 });
    expect(first.next_cursor).toBeTruthy();
    const second = await store.list(owner, {
      limit: 2,
      cursor: first.next_cursor!,
    });
    expect(
      second.drops.every((d) => !first.drops.some((a) => a.id === d.id)),
    ).toBe(true);
    expect(() => decodeCursor("invalid")).toThrow("pagination cursor");
  });
  it("preserves conversation lineage and prevents cross-space replies", async () => {
    const parent = await store.create(writer, { title: "Parent" });
    const child = await store.create(writer, {
      title: "Reply",
      parent_id: parent.drop.id,
    });
    expect(child.drop.thread_id).toBe(parent.drop.id);
    expect((await store.detail(reader, parent.drop.id)).replies).toHaveLength(
      1,
    );
    await expect(
      store.create(owner, {
        title: "Cross-space reply",
        space: "private",
        parent_id: parent.drop.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("preserves microseconds and ID ordering across pagination boundaries", async () => {
    const ids: string[] = [];
    for (const fractional of ["123456", "123456", "123789"]) {
      const { drop } = await store.create(writer, {
        title: "Microsecond boundary",
      });
      ids.push(drop.id);
      await query(
        "UPDATE dd_drops SET created_at=$1::timestamptz WHERE id=$2",
        [`2026-09-13T10:00:00.${fractional}Z`, drop.id],
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const result = await store.list(reader, {
        q: "Microsecond boundary",
        limit: 1,
        cursor,
      });
      expect(result.drops).toHaveLength(1);
      seen.push(result.drops[0].id);
      cursor = result.next_cursor || undefined;
    }
    expect(seen.sort()).toEqual(ids.sort());
    expect(cursor).toBeUndefined();
  });
  it("attaches only the uploader’s ready files atomically", async () => {
    const id = randomUUID();
    await query(
      "INSERT INTO dd_files(id,space,name,content_type,size,pathname,principal_id) VALUES($1,'general','image.png','image/png',12,$2,'writer')",
      [id, `test/${id}`],
    );
    await expect(
      store.create(writer, { title: "Pending file", attachment_ids: [id] }),
    ).rejects.toMatchObject({ status: 409 });
    await query("UPDATE dd_files SET status='ready' WHERE id=$1", [id]);
    await expect(
      store.create(owner, {
        title: "Someone else’s upload",
        attachment_ids: [id],
      }),
    ).rejects.toMatchObject({ status: 409 });
    const { drop } = await store.create(writer, {
      title: "Image attached",
      attachment_ids: [id],
    });
    expect((await store.detail(reader, drop.id)).attachments[0].id).toBe(id);
    await store.create(writer, { title: "Newer note without attachments" });
    const filtered = await store.list(reader, { with_files: true, limit: 1 });
    expect(filtered.drops[0].id).toBe(drop.id);
    expect(filtered.next_cursor).toBeNull();
    await expect(
      store.create(writer, { title: "Reuse", attachment_ids: [id] }),
    ).rejects.toMatchObject({ status: 409 });
    const orphan = await query(
      "SELECT id FROM dd_drops WHERE title=ANY($1::text[])",
      [["Pending file", "Someone else’s upload", "Reuse"]],
    );
    expect(orphan.rows).toHaveLength(0);
  });
  it("hides unattached uploads from other connections", async () => {
    const id = randomUUID();
    await query(
      "INSERT INTO dd_files(id,space,name,content_type,size,pathname,principal_id) VALUES($1,'general','a.txt','text/plain',1,$2,'writer')",
      [id, `test/${id}`],
    );
    await expect(store.file(reader, id)).rejects.toMatchObject({ status: 404 });
    expect((await store.file(writer, id)).id).toBe(id);
  });
  it("restricts archive and star controls to the owner", async () => {
    const { drop } = await store.create(writer, { title: "Organize" });
    await expect(
      store.update(writer, drop.id, { archived: true }),
    ).rejects.toMatchObject({ status: 403 });
    await store.update(owner, drop.id, { archived: true, pinned: true });
    expect(
      (await store.list(owner, { archived: true })).drops.some(
        (d) => d.id === drop.id,
      ),
    ).toBe(true);
  });
  it("issues high-entropy tokens and rejects file paths", () => {
    const a = mintToken(),
      b = mintToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hash(a.token));
    expect(a.tokenHash).not.toContain(a.token);
    expect(
      fileInput.safeParse({
        name: "../secret",
        size: 10,
        content_type: "text/plain",
      }).success,
    ).toBe(false);
    expect(
      fileInput.safeParse({
        name: "image.png",
        size: 10,
        content_type: "image/png",
      }).success,
    ).toBe(true);
  });
});
