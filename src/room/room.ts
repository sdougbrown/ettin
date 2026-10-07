/**
 * Room data model and the room log, stored as custom entries in a
 * pi-durable conversation.
 *
 * This is the port of `internal/room/room.go` from the avenor room-spike:
 * same RoomEvent shape (author, kind, visibility, parents, depth), but the
 * authoritative record is the room conversation's transcript in durable
 * storage rather than a workspace NDJSON file. Per-author counters and the
 * global seq live in a conversation document updated in the same commit as
 * each append, so IDs (H1, A2, ...) stay stable across restarts.
 */
import {
  type Conversation,
  type ConversationId,
  type Harness,
  defineDoc,
  defineEntry,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

export type Participant = string; // "human" | "room" | head name
export type Visibility = string; // "room" for the spike; per-head later

export type RoomEventKind =
  | "human_input"
  | "head_output"
  | "head_note"
  | "mutation"
  | "governor"
  | "system";

// Type aliases (not interfaces) so doc payloads satisfy JsonObject's index
// signature.
export type RoomEvent = {
  /** Per-author turn label (H1, A2, ...) used in causal references. */
  id: string;
  seq: number;
  ts: number;
  author: Participant;
  kind: RoomEventKind;
  body: string;
  visibility: Visibility;
  parents?: string[];
  depth: number;
  meta?: Record<string, string>;
};

/** Custom entry kind carrying one room event in `data`. */
export const RoomEventEntry = defineEntry<RoomEvent>("ettin.event");

/** Room-log bookkeeping: global seq and per-author event counters. */
export const RoomDoc = defineDoc<{
  seq: number;
  counts: Record<string, number>;
}>({
  kind: "ettin.room",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ seq: 0, counts: {} }),
});

export type MutationRecord = { head: string; path: string; at: number };

/** Cross-head mutation-arbiter state. Session-scoped: every head sees it. */
export type ArbiterState = {
  /** True during a parallel window (fan-out from one snapshot). */
  armed: boolean;
  /** Last observed git working-tree fingerprint ("" until first check). */
  fingerprint: string;
  /** Head currently holding the write gate ("" when none). */
  holder: string;
  /** Heads already denied once this window; their reconciled retry passes. */
  deniedOnce: Record<string, boolean>;
  /** Bumped on every recorded mutation. */
  revision: number;
  /** Recent mutations, newest last. */
  mutations: MutationRecord[];
};

export const ArbiterDoc = defineDoc<ArbiterState>({
  kind: "ettin.arbiter",
  version: 1,
  scope: "session",
  initial: () => ({
    armed: false,
    fingerprint: "",
    holder: "",
    deniedOnce: {},
    revision: 0,
    mutations: [],
  }),
});

/** Head roster: name → durable conversation. Session-scoped, survives restart. */
export type HeadRecord = {
  name: string;
  conversationId: ConversationId;
  model: string;
  provider: string;
};

export const HeadsDoc = defineDoc<{ heads: HeadRecord[] }>({
  kind: "ettin.heads",
  version: 1,
  scope: "session",
  initial: () => ({ heads: [] }),
});

/** Durable context shared with the room module (governor, projection, UI). */
export interface RoomContext {
  harness: Harness;
  /** The room conversation: transcript of ettin.event entries. */
  room: Conversation;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Append one event to the room log. Atomic with the counter document. */
export async function appendRoomEvent(
  rc: RoomContext,
  event: Omit<RoomEvent, "id" | "seq" | "ts">,
  ctx: Context,
): Promise<RoomEvent> {
  return rc.room.commit(async (tx) => {
    const doc = await tx.doc(RoomDoc, rc.room.id);
    doc.seq += 1;
    doc.counts[event.author] = (doc.counts[event.author] ?? 0) + 1;
    const full: RoomEvent = {
      ...event,
      id: `${event.author}${doc.counts[event.author]}`,
      seq: doc.seq,
      ts: Date.now(),
    };
    await tx.appendEntry(RoomEventEntry, rc.room.id, { data: full });
    return full;
  }, ctx);
}

/** All room events, oldest first. */
export async function roomEvents(rc: RoomContext, ctx: Context): Promise<RoomEvent[]> {
  const page = await rc.room.entries({}, 10_000, undefined, ctx);
  return page.items
    .filter((e) => e.kind === RoomEventEntry.kind && e.data !== undefined)
    .map((e) => e.data as RoomEvent)
    .toSorted((a, b) => a.seq - b.seq);
}

/** Bound a string to roughly limit characters on a rune boundary. */
export function bound(s: string, limit: number): string {
  if (limit <= 0 || s.length <= limit) return s;
  const r = Array.from(s);
  if (r.length <= limit) return s;
  return `${r.slice(0, limit).join("")} […]`;
}

export function oneLine(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(" ");
}

export { ZERO_COST };
