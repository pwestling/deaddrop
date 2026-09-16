import { z } from "zod";
import type { Queryable } from "./db";
import type { Drop } from "./store";
import { AppError } from "./errors";
import { requireScope, requireSpace, type Principal } from "./policy";
import { spaceSlug } from "./validation";

export const eventId = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .pipe(
    z
      .string()
      .refine(
        (value) => BigInt(value) <= 9223372036854775807n,
        "Invalid event ID",
      ),
  );
const subscription = z
  .object({
    space: spaceSlug.optional(),
    recipient: z.string().trim().min(1).max(100).optional(),
    after: eventId.optional(),
  })
  .strict();
export type EventFilter = Pick<
  z.infer<typeof subscription>,
  "space" | "recipient"
>;
export type EventType = "drop.created" | "drop.updated" | "drop.acknowledged";
export interface DropEvent {
  id: string;
  type: EventType;
  space: string;
  recipient: string | null;
  drop_id: string;
  actor_id: string;
  actor: string;
  data: Record<string, unknown>;
  created_at: string;
}

export function eventSubscription(request: Request) {
  const input = Object.fromEntries(new URL(request.url).searchParams);
  const lastId = request.headers.get("last-event-id");
  if (lastId !== null) input.after = lastId;
  return subscription.parse(input);
}

// Call at the end of the same transaction as the change. Never publish after commit.
export async function publishDropEvent(
  tx: Queryable,
  type: EventType,
  principal: Principal,
  drop: Drop,
  data: Record<string, unknown>,
) {
  await tx.query("SELECT pg_advisory_xact_lock(1788124201, 1)");
  const result = await tx.query<{ id: string }>(
    `INSERT INTO dd_events(type,space,recipient,drop_id,actor_id,actor,data)
     VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id::text`,
    [
      type,
      drop.space,
      drop.recipient,
      drop.id,
      principal.id,
      principal.name,
      JSON.stringify(data),
    ],
  );
  return result.rows[0].id;
}

export class EventStore {
  constructor(private database: Queryable) {}

  async latest() {
    return (
      await this.database.query<{ id: string }>(
        "SELECT COALESCE(max(id),0)::text AS id FROM dd_events",
      )
    ).rows[0].id;
  }

  async validate(principal: Principal, filter: EventFilter) {
    requireScope(principal, "deaddrop:read");
    if (filter.space) {
      requireSpace(principal, filter.space);
      if (
        !(
          await this.database.query(
            "SELECT slug FROM dd_spaces WHERE slug=$1",
            [filter.space],
          )
        ).rows.length
      )
        throw new AppError(404, "not_found", "Space not found.");
    }
  }

  async read(principal: Principal, filter: EventFilter, after: string) {
    requireScope(principal, "deaddrop:read");
    if (filter.space) requireSpace(principal, filter.space);
    const head = await this.latest();
    const events = (
      await this.database.query<DropEvent>(
        `SELECT id::text,type,space,recipient,drop_id,actor_id,actor,data,created_at
       FROM dd_events WHERE id>$1::bigint AND id<=$2::bigint
       AND ($3::text[] IS NULL OR space=ANY($3))
       AND ($4::text IS NULL OR space=$4) AND ($5::text IS NULL OR recipient=$5)
       ORDER BY dd_events.id LIMIT 100`,
        [
          eventId.parse(after),
          head,
          principal.spaces,
          filter.space ?? null,
          filter.recipient ?? null,
        ],
      )
    ).rows;
    // Bound the scan to a committed high-water mark, including when no events match.
    return {
      events,
      cursor: events.length === 100 ? events[events.length - 1].id : head,
    };
  }
}
