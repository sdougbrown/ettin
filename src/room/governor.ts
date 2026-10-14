/**
 * Turn governor — port of internal/room/governor.go.
 *
 * The coordinator owns all enforcement (budget, depth cap, no echo); a
 * governor only chooses who reacts next within that envelope. The marker
 * governor is the deterministic stub: a peer round happens only when a
 * settled output carries a room marker. Jev slots in behind the same
 * interface later.
 *
 * Room markers follow avenor's whole-line marker convention (the team run's
 * `<|team: skip | name|>` shape): `<|room: verb | arg|>`, matched whole-line
 * and case-insensitively, so markers embedded in prose are ignored.
 */
import type { RoomEvent } from "./room.ts";

export interface Activation {
  participant: string;
  /** Room log event id carrying the final output (A42). */
  eventId: string;
  mode: string; // answer | react | bootstrap
  depth: number;
  stopReason: string;
  finalOutput: string;
  blocked: boolean;
}

export interface State {
  humanInput: string;
  participants: string[];
  /** This operator turn's activations, causal order. */
  settled: Activation[];
  /** Speaker event ids already used for a react round. */
  reactedTo: Set<string>;
  depth: number;
  budgetRemaining: number;
  maxDepth: number;
}

export interface Decision {
  activate: string[];
  speakerEventId: string;
  mode: string;
  reason: string;
  /** Execution shape for a multi-head round: parallel (all heads share the
   * same pre-round snapshot) or serial (relay — each head's prompt is built
   * after the previous one settles, so it sees prior outputs). Defaults to
   * serial. The coordinator owns the mechanism; this is policy only. */
  parallel?: boolean;
}

export interface Governor {
  /** Async allowed: transport-backed governors await their API call. */
  decide(state: State): Decision | Promise<Decision>;
  /** Execution shape for the operator fanout round, decided before any
   * activation exists. Absent ⇒ coordinator default (parallel when the
   * operator addressed more than one head). */
  fanoutParallel?(input: {
    targets: string[];
    participants: string[];
    humanInput: string;
  }): boolean;
}

const MARKER_LINE = /^<\|room:\s*([a-z-]+)\s*(?:\|\s*([^|>]*?)\s*)?\|>$/i;

/** One whole-line room marker: verb plus optional argument. */
export interface RoomMarker {
  verb: string; // lowercased, e.g. "ask-peer"
  arg: string; // trimmed argument; "" when absent
}

/** Parse the first room marker in an output. Only whole-line markers count —
 * a marker embedded in prose is ignored, as in avenor's team runner. */
export function parseRoomMarker(out: string): RoomMarker | undefined {
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    const m = MARKER_LINE.exec(line);
    if (m) return { verb: (m[1] ?? "").toLowerCase(), arg: (m[2] ?? "").trim() };
  }
  return undefined;
}

/** A lone-line mention ("@b" or "@all", optional trailing "?") resolves to
 * an ask-peer trigger — but only when the name resolves to a known
 * participant (or all). Inline mentions in prose are inert. Non-resolving
 * names fall through as plain text. */
export function parseMention(
  out: string,
  participants: string[],
  speaker: string,
): RoomMarker | undefined {
  for (const rawLine of out.split("\n")) {
    const line = rawLine.trim();
    const m = /^@([a-zA-Z][\w-]*)\??$/.exec(line);
    if (!m) continue;
    const name = m[1]!.toLowerCase();
    if (name === "all" || name === "room") return { verb: "ask-peer", arg: "" };
    const hit = participants.find((p) => p.toLowerCase() === name);
    if (hit && hit !== speaker) return { verb: "ask-peer", arg: hit };
  }
  return undefined;
}

/** The room trigger for an output: an explicit marker if present, else a
 * resolving lone-line mention. Both normalize to a RoomMarker. */
export function roomTrigger(
  out: string,
  participants: string[],
  speaker: string,
): RoomMarker | undefined {
  return parseRoomMarker(out) ?? parseMention(out, participants, speaker);
}

export function hasAskMarker(out: string): boolean {
  const m = parseRoomMarker(out);
  return m !== undefined && m.verb === "ask-peer";
}

/** Resolve a marker's target list: a named head, "all", or absent (all). */
export function markerTargets(m: RoomMarker, participants: string[], speaker: string): string[] {
  const wanted =
    m.arg === "" || m.arg.toLowerCase() === "all"
      ? participants
      : participants.filter((p) => p.toLowerCase() === m.arg.toLowerCase());
  // The speaker never reacts to their own output (no-echo rule).
  return wanted.filter((p) => p !== speaker);
}

export class MarkerGovernor implements Governor {
  decide(s: State): Decision {
    if (s.budgetRemaining <= 0)
      return { activate: [], speakerEventId: "", mode: "", reason: "budget exhausted" };
    if (s.depth >= s.maxDepth)
      return { activate: [], speakerEventId: "", mode: "", reason: "peer depth cap" };
    // Most recent unreacted output carrying a trigger wins; scanning from
    // the end keeps repeat rounds fresh instead of re-injecting the same
    // event.
    for (let i = s.settled.length - 1; i >= 0; i--) {
      const a = s.settled[i]!;
      if (s.reactedTo.has(a.eventId)) continue;
      const marker = roomTrigger(a.finalOutput, s.participants, a.participant);
      if (!marker || marker.verb !== "ask-peer") continue;
      const targets = markerTargets(marker, s.participants, a.participant);
      if (targets.length === 0) continue;
      const scope =
        marker.arg === "" || marker.arg.toLowerCase() === "all"
          ? "all peers"
          : `→ ${targets.join(",")}`;
      const via = parseRoomMarker(a.finalOutput) ? "marker" : "mention";
      return {
        activate: targets,
        speakerEventId: a.eventId,
        mode: "react",
        reason: `ask-peer ${via} in ${a.eventId} (${scope})`,
        // Relay semantics: each reactor sees the peers that answered
        // before it in the round.
        parallel: false,
      };
    }
    return { activate: [], speakerEventId: "", mode: "", reason: "no peer request" };
  }

  /** Operator fanout: multiple addressed heads answer independently from
   * the same snapshot (the useful default for @-broadcasts); a single
   * target is trivially serial. */
  fanoutParallel(input: { targets: string[] }): boolean {
    return input.targets.length > 1;
  }
}

/** Marker in a raw room event body (used when reconstructing state). */
export function markerInEvent(ev: RoomEvent): boolean {
  return ev.kind === "head_output" && hasAskMarker(ev.body);
}
