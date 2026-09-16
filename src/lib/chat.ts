import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { db, type Database } from "./db";
import { AppError } from "./errors";
import { EventStore, eventId } from "./events";
import { requireScope, type Principal } from "./policy";
import { DropStore, type Drop } from "./store";
import { dropInput, spaceSlug } from "./validation";

const waitOptions = {
  after: eventId.optional(),
  timeout_seconds: z.number().int().min(0).max(50).default(30),
  limit: z.number().int().min(1).max(50).default(20),
  include_self: z.boolean().default(false),
};
export const waitMessagesInput = z
  .object({
    ...waitOptions,
    space: spaceSlug.optional(),
    recipient: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export const waitReplyInput = z
  .object({ ...waitOptions, drop_id: z.uuid() })
  .strict();
export const replyInput = dropInput
  .pick({ body: true, attachment_ids: true, recipient: true })
  .extend({
    drop_id: z.uuid(),
    idempotency_key: z.string().min(1).max(150).optional(),
  })
  .strict();
export const threadInput = z
  .object({
    drop_id: z.uuid(),
    limit: z.number().int().min(1).max(50).default(20),
    page: z.string().max(1000).optional(),
  })
  .strict();
const threadPage = z
  .object({
    thread_id: z.uuid(),
    head: eventId,
    event_id: eventId.nullable(),
    created_at: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

type Message = Pick<
  Drop,
  | "id"
  | "thread_id"
  | "parent_id"
  | "space"
  | "sender"
  | "principal_id"
  | "recipient"
  | "title"
  | "body"
  | "created_at"
> & {
  body_truncated: boolean;
  attachments: {
    id: string;
    name: string;
    content_type: string;
    size: string;
  }[];
  event_id: string | null;
};
// Bound tool results even when messages have large bodies. Full content remains in read_drop.
const messageColumns = `d.id,d.thread_id,d.parent_id,d.space,d.sender,d.principal_id,d.recipient,d.title,
  left(d.body,8000) AS body,(length(d.body)>8000) AS body_truncated,
  to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  e.id::text AS event_id,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'content_type',f.content_type,'size',f.size::text) ORDER BY f.created_at,f.id)
    FROM dd_files f WHERE f.drop_id=d.id),'[]'::jsonb) AS attachments`;

export interface ChatContext {
  authenticate: () => Promise<Principal>;
  signal: AbortSignal;
  pollMs?: number;
}

export class ChatStore {
  private drops: DropStore;
  private events: EventStore;
  constructor(private database: Database) {
    this.drops = new DropStore(database);
    this.events = new EventStore(database);
  }

  async reply(principal: Principal, raw: unknown) {
    const input = replyInput.parse(raw);
    const parent = await this.drops.get(principal, input.drop_id);
    // No caller-supplied space or sender: replies always stay in the parent's space.
    return this.drops.create(
      principal,
      {
        title: parent.title,
        body: input.body,
        attachment_ids: input.attachment_ids,
        space: parent.space,
        parent_id: parent.id,
        recipient:
          input.recipient === undefined ? parent.sender : input.recipient,
      },
      input.idempotency_key,
    );
  }

  async thread(principal: Principal, raw: unknown) {
    const input = threadInput.parse(raw);
    const anchor = await this.drops.get(principal, input.drop_id);
    const latest = await this.events.latest();
    let page: z.infer<typeof threadPage> | undefined;
    if (input.page) {
      try {
        page = threadPage.parse(
          JSON.parse(Buffer.from(input.page, "base64url").toString("utf8")),
        );
      } catch {
        throw new AppError(400, "invalid_cursor", "Invalid conversation page.");
      }
      if (
        page.thread_id !== anchor.thread_id ||
        BigInt(page.head) > BigInt(latest)
      )
        throw new AppError(
          400,
          "invalid_cursor",
          "This page belongs to another conversation or event log.",
        );
    }
    const head = page?.head ?? latest;
    const rows = (
      await this.database.query<Message>(
        `SELECT ${messageColumns} FROM dd_drops d
       LEFT JOIN dd_events e ON e.drop_id=d.id AND e.type='drop.created'
       WHERE d.thread_id=$1 AND d.space=$2 AND (e.id IS NULL OR e.id<=$3::bigint)
       AND ($4::timestamptz IS NULL
         OR ($6::bigint IS NULL AND (e.id IS NOT NULL OR (d.created_at,d.id)>($4::timestamptz,$5::uuid)))
         OR e.id>$6::bigint)
       ORDER BY e.id NULLS FIRST,d.created_at,d.id LIMIT $7`,
        [
          anchor.thread_id,
          anchor.space,
          head,
          page?.created_at ?? null,
          page?.id ?? null,
          page?.event_id ?? null,
          input.limit + 1,
        ],
      )
    ).rows;
    const messages = rows.slice(0, input.limit);
    const last = messages.at(-1);
    return {
      thread_id: anchor.thread_id,
      space: anchor.space,
      messages,
      cursor: head,
      next_page:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                thread_id: anchor.thread_id,
                head,
                event_id: last.event_id,
                created_at: last.created_at,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
    };
  }

  waitMessages(principal: Principal, raw: unknown, context: ChatContext) {
    return this.wait(principal, waitMessagesInput.parse(raw), context);
  }

  waitReply(principal: Principal, raw: unknown, context: ChatContext) {
    return this.wait(principal, waitReplyInput.parse(raw), context);
  }

  private async wait(
    principal: Principal,
    input: z.infer<typeof waitMessagesInput> | z.infer<typeof waitReplyInput>,
    context: ChatContext,
  ) {
    const deadline = Date.now() + input.timeout_seconds * 1000;
    context.signal.throwIfAborted();
    requireScope(principal, "deaddrop:read");
    const anchor =
      "drop_id" in input
        ? await this.drops.get(principal, input.drop_id)
        : undefined;
    const filter =
      "drop_id" in input
        ? { space: anchor!.space }
        : { space: input.space, recipient: input.recipient };
    await this.events.validate(principal, filter);
    const head = await this.events.latest();
    if (input.after && BigInt(input.after) > BigInt(head))
      throw new AppError(
        400,
        "invalid_cursor",
        "The event cursor is ahead of this instance's event log.",
      );
    let cursor = input.after ?? head;
    if (anchor) {
      const event = (
        await this.database.query<{ id: string }>(
          "SELECT id::text FROM dd_events WHERE drop_id=$1 AND type='drop.created' ORDER BY id LIMIT 1",
          [anchor.id],
        )
      ).rows[0];
      const start = event?.id ?? "0";
      cursor =
        input.after && BigInt(input.after) > BigInt(start)
          ? input.after
          : start;
    }
    while (true) {
      context.signal.throwIfAborted();
      // Current credentials and space access are checked even when the inbox is quiet.
      const current = await context.authenticate();
      context.signal.throwIfAborted();
      if (current.id !== principal.id)
        throw new AppError(
          403,
          "identity_changed",
          "Connection identity changed.",
        );
      await this.events.validate(current, filter);
      const highWater = await this.events.latest();
      const rows = (
        await this.database.query<Message>(
          `SELECT ${messageColumns} FROM dd_events e JOIN dd_drops d ON d.id=e.drop_id
         WHERE e.type='drop.created' AND e.id>$1::bigint AND e.id<=$2::bigint
         AND ($3::text[] IS NULL OR d.space=ANY($3))
         AND ($4::text IS NULL OR d.space=$4) AND ($5::text IS NULL OR d.recipient=$5)
         AND ($6::uuid IS NULL OR d.thread_id=$6)
         AND ($7::boolean OR d.principal_id<>$8)
         ORDER BY e.id LIMIT $9`,
          [
            cursor,
            highWater,
            current.spaces,
            filter.space ?? null,
            "recipient" in filter ? (filter.recipient ?? null) : null,
            anchor?.thread_id ?? null,
            input.include_self,
            current.id,
            input.limit + 1,
          ],
        )
      ).rows;
      context.signal.throwIfAborted();
      const messages = rows.slice(0, input.limit);
      const more = rows.length > input.limit;
      cursor = more ? messages[messages.length - 1].event_id! : highWater;
      if (messages.length || Date.now() >= deadline)
        return {
          status: messages.length ? "messages" : "timeout",
          messages,
          cursor,
          has_more: more,
          ...(anchor ? { thread_id: anchor.thread_id } : {}),
        };
      await delay(
        Math.min(context.pollMs ?? 2000, Math.max(0, deadline - Date.now())),
        undefined,
        { signal: context.signal },
      );
    }
  }
}

export const chat = new ChatStore(db);
