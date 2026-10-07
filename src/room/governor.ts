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
}

export interface Governor {
  /** Async allowed: transport-backed governors await their API call. */
  decide(state: State): Decision | Promise<Decision>;
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
    // Most recent unreacted output carrying a marker wins; scanning from
    // the end keeps repeat rounds fresh instead of re-injecting the same
    // event.
    for (let i = s.settled.length - 1; i >= 0; i--) {
      const a = s.settled[i]!;
      if (s.reactedTo.has(a.eventId)) continue;
      const marker = parseRoomMarker(a.finalOutput);
      if (!marker || marker.verb !== "ask-peer") continue;
      const targets = markerTargets(marker, s.participants, a.participant);
      if (targets.length === 0) continue;
      const scope =
        marker.arg === "" || marker.arg.toLowerCase() === "all"
          ? "all peers"
          : `→ ${targets.join(",")}`;
      return {
        activate: targets,
        speakerEventId: a.eventId,
        mode: "react",
        reason: `ask-peer marker in ${a.eventId} (${scope})`,
      };
    }
    return { activate: [], speakerEventId: "", mode: "", reason: "no peer request" };
  }
}

/** Marker in a raw room event body (used when reconstructing state). */
export function markerInEvent(ev: RoomEvent): boolean {
  return ev.kind === "head_output" && hasAskMarker(ev.body);
}
