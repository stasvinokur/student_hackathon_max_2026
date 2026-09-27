import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** MAX users who started the bot. Only the MAX user id is stored — no names or contacts. */
export const users = pgTable('users', {
  maxUserId: bigint('max_user_id', { mode: 'number' }).primaryKey(),
  createdAt: createdAt(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Onboarding dialog state (core OnboardingState), so the dialog survives restarts. */
export const onboardingStates = pgTable('onboarding_states', {
  userId: bigint('user_id', { mode: 'number' })
    .primaryKey()
    .references(() => users.maxUserId, { onDelete: 'cascade' }),
  state: jsonb('state').notNull(),
  updatedAt: updatedAt(),
});

/** The user's launch route: one active route per user, rebuilt when onboarding is repeated. */
export const routes = pgTable('routes', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  userId: bigint('user_id', { mode: 'number' })
    .notNull()
    .unique()
    .references(() => users.maxUserId, { onDelete: 'cascade' }),
  packId: text('pack_id').notNull(),
  packVersion: text('pack_version').notNull(),
  /** core Profile: the onboarding answers the route was built from. */
  profile: jsonb('profile').notNull(),
  /** Snapshot of the applicable action ids at build time, for explainability across pack versions. */
  actionIds: text('action_ids').array().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const routeTasks = pgTable(
  'route_tasks',
  {
    routeId: bigint('route_id', { mode: 'number' })
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    actionId: text('action_id').notNull(),
    status: text('status', { enum: ['todo', 'done'] }).notNull(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.routeId, t.actionId] })],
);

/** Bot reminders queue, drained by the scheduler worker. */
export const reminders = pgTable(
  'reminders',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' })
      .notNull()
      .references(() => users.maxUserId, { onDelete: 'cascade' }),
    routeId: bigint('route_id', { mode: 'number' })
      .notNull()
      .references(() => routes.id, { onDelete: 'cascade' }),
    actionId: text('action_id'),
    kind: text('kind').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** Lease taken by a worker; another worker may retry after it expires. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('reminders_pending_due_idx').on(t.dueAt).where(sql`${t.sentAt} is null and ${t.cancelledAt} is null`)],
);

/** Product analytics events for the pilot KPIs. Props must not contain personal data. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }),
    type: text('type').notNull(),
    props: jsonb('props').notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('events_type_created_idx').on(t.type, t.createdAt)],
);
