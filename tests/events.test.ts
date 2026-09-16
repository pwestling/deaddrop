import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { QueryResultRow } from "pg";
import type { Database } from "../src/lib/db";
import { DropStore } from "../src/lib/store";
import { EventStore, eventSubscription } from "../src/lib/events";
import { eventResponse } from "../src/lib/event-stream";
import { AppError } from "../src/lib/errors";
import type { Principal } from "../src/lib/policy";

const engine = new PGlite();
const database: Database = {
  query: async <T extends QueryResultRow>(sql: string, values?: unknown[]) => ({
    rows: (await engine.query<T>(sql, values)).rows,
  }),
  transaction: (fn) =>
    engine.transaction((tx) =>
      fn({
        query: async <T extends QueryResultRow>(
          sql: string,
          values?: unknown[],
        ) => {
          if (sql.startsWith("SELECT pg_advisory_xact_lock"))
            return { rows: [] };
          return { rows: (await tx.query<T>(sql, values)).rows };
        },
      }),
    ),
};
const drops = new DropStore(database);
const events = new EventStore(database);
const owner: Principal = {
  id: "owner:test",
  userId: "test",
  owner: true,
  name: "Owner",
  spaces: null,
  scopes: ["deaddrop:read", "deaddrop:write"],
};
const reader: Principal = {
  id: "reader",
  owner: false,
  name: "Muse",
  spaces: ["general"],
  scopes: ["deaddrop:read"],
};
beforeAll(async () => {
  const schema = await readFile(
    new URL("../src/lib/schema.sql", import.meta.url),
    "utf8",
  );
  await engine.exec(schema);
  await engine.exec(schema);
  await database.query(
    "INSERT INTO dd_spaces(slug,name) VALUES('private','Private')",
  );
});
beforeEach(() =>
  engine.exec(
    "TRUNCATE dd_events,dd_drops,dd_files,dd_receipts,dd_activity RESTART IDENTITY CASCADE",
  ),
);
afterAll(() => engine.close());

it("publishes committed changes exactly once for idempotent creation and acknowledgement", async () => {
  const input = {
    title: "Hello",
    body: "Not in notifications",
    recipient: "Muse",
  };
  const { drop } = await drops.create(owner, input, "retry-key");
  await drops.create(owner, input, "retry-key");
  await drops.acknowledge(reader, drop.id);
  await drops.acknowledge(reader, drop.id);
  await drops.update(owner, drop.id, { pinned: true, archived: true });
  const batch = await events.read(reader, {}, "0");
  expect(batch.events.map((event) => event.type)).toEqual([
    "drop.created",
    "drop.acknowledged",
    "drop.updated",
  ]);
  expect(batch.events[0]).toMatchObject({
    drop_id: drop.id,
    recipient: "Muse",
    data: { title: "Hello", attachment_ids: [] },
  });
  expect(batch.events[2].data).toMatchObject({ pinned: true });
  expect(JSON.stringify(batch)).not.toContain("Not in notifications");
});

it("rolls back the drop when its notification cannot be stored", async () => {
  const failing = new DropStore({
    ...database,
    transaction: (fn) =>
      database.transaction((tx) =>
        fn({
          query: async (sql, values) => {
            if (sql.includes("INSERT INTO dd_events"))
              throw new Error("Event write failed");
            return tx.query(sql, values);
          },
        }),
      ),
  });
  await expect(failing.create(owner, { title: "Rolled back" })).rejects.toThrow(
    "Event write failed",
  );
  expect((await database.query("SELECT id FROM dd_drops")).rows).toHaveLength(
    0,
  );
  expect(await events.latest()).toBe("0");
});

it("combines exact recipient filtering with space access, including replies", async () => {
  const { drop } = await drops.create(owner, {
    title: "To Muse",
    recipient: "Muse",
  });
  const reply = await drops.create(owner, {
    title: "Reply",
    parent_id: drop.id,
    recipient: "Muse",
  });
  await drops.create(owner, { title: "Broadcast" });
  await drops.create(owner, { title: "Different case", recipient: "muse" });
  await drops.create(owner, {
    title: "Private",
    space: "private",
    recipient: "Muse",
  });
  const batch = await events.read(reader, { recipient: "Muse" }, "0");
  expect(batch.events.map((event) => event.drop_id)).toEqual([
    drop.id,
    reply.drop.id,
  ]);
  expect(batch.events[1].data).toMatchObject({
    parent_id: drop.id,
    thread_id: drop.id,
  });
  expect(batch.cursor).toBe("5");
  expect((await events.read(reader, {}, "0")).events).toHaveLength(4);
  await expect(
    events.read(reader, { space: "private" }, "0"),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    events.validate(owner, { space: "missing" }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    events.read({ ...reader, scopes: ["deaddrop:write"] }, {}, "0"),
  ).rejects.toMatchObject({ status: 403 });
});

it("orders numeric IDs correctly over multiple batches and keeps bigint cursors exact", async () => {
  for (let index = 0; index < 105; index++)
    await drops.create(owner, { title: `Event ${index}` });
  const first = await events.read(reader, {}, "0");
  expect(first.events.map((event) => event.id)).toEqual(
    Array.from({ length: 100 }, (_, i) => String(i + 1)),
  );
  expect(first.cursor).toBe("100");
  const next = await events.read(reader, {}, first.cursor);
  expect(next.events.map((event) => event.id)).toEqual([
    "101",
    "102",
    "103",
    "104",
    "105",
  ]);
  await database.query(
    "SELECT setval(pg_get_serial_sequence('dd_events','id'),9007199254740993,true)",
  );
  await drops.create(owner, { title: "Large cursor" });
  expect((await events.read(reader, {}, "105")).cursor).toBe(
    "9007199254740994",
  );
});

it("validates cursors and prefers Last-Event-ID on reconnect", () => {
  expect(
    eventSubscription(
      new Request(
        "http://localhost/api/v1/events?space=general&recipient=Muse&after=0",
        { headers: { "Last-Event-ID": "42" } },
      ),
    ),
  ).toEqual({ space: "general", recipient: "Muse", after: "42" });
  for (const value of [
    "-1",
    "1e3",
    "01",
    "9223372036854775808",
    "1\nevent: injected",
  ]) {
    expect(() =>
      eventSubscription(
        new Request(
          `http://localhost/api/v1/events?after=${encodeURIComponent(value)}`,
        ),
      ),
    ).toThrow();
  }
});

it("starts live by default and emits heartbeats and a graceful reconnect", async () => {
  await drops.create(owner, { title: "Before subscription" });
  const response = await eventResponse(
    new Request("http://localhost/events"),
    reader,
    events,
    async () => reader,
    { lifetimeMs: 65, heartbeatMs: 15, pollMs: 5 },
  );
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const text = await response.text();
  expect(text).toContain('event: ready\ndata: {"cursor":"1"}');
  expect(text).not.toContain("drop.created");
  expect(text).toContain(": heartbeat");
  expect(text).toContain("event: reconnect");
  await expect(
    eventResponse(
      new Request("http://localhost/events?after=99"),
      reader,
      events,
      async () => reader,
    ),
  ).rejects.toMatchObject({ status: 400 });
});

it("stops an established stream after access revocation without disclosing subsequent events", async () => {
  let calls = 0;
  const response = await eventResponse(
    new Request("http://localhost/events?after=0"),
    reader,
    events,
    async () => {
      if (++calls > 1) throw new AppError(403, "access_revoked", "Revoked");
      return reader;
    },
    { lifetimeMs: 1000, pollMs: 5 },
  );
  const text = await response.text();
  expect(text).toContain(
    'event: stream_error\ndata: {"code":"access_revoked","retryable":false}',
  );
  expect(calls).toBe(2);
});

it("ends on request abort and cancels cleanly when the reader disconnects", async () => {
  const abort = new AbortController();
  const response = await eventResponse(
    new Request("http://localhost/events", { signal: abort.signal }),
    reader,
    events,
    async () => reader,
  );
  abort.abort();
  expect(await response.text()).toContain("event: ready");
  const other = await eventResponse(
    new Request("http://localhost/events"),
    reader,
    events,
    async () => reader,
  );
  await expect(other.body!.cancel()).resolves.toBeUndefined();
});
