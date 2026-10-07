/**
 * Turn governor — port of internal/room/governor.go.
 *
 * The coordinator owns all enforcement (budget, depth cap, no echo); a
 * governor only chooses who reacts next within that envelope. The marker
 * governor is the deterministic stub: a peer round happens only when a
 * settled output carries an ask-peer marker. Jev slots in behind the same
 * interface later.
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
  decide(state: State): Decision;
}

/** Deterministic signals a head can emit to request a peer round. The
 * orientation header teaches the convention; keep it in sync with
 * orientationText(). */
export const ASK_PEER_MARKERS = ["[[ask-peer]]", "[[request-review]]"];

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
      if (hasAskMarker(a.finalOutput)) {
        return {
          activate: others(s, a.participant),
          speakerEventId: a.eventId,
          mode: "react",
          reason: `ask-peer marker in ${a.eventId}`,
        };
      }
    }
    return { activate: [], speakerEventId: "", mode: "", reason: "no peer request" };
  }
}

export function hasAskMarker(out: string): boolean {
  const l = out.toLowerCase();
  return ASK_PEER_MARKERS.some((m) => l.includes(m));
}

function others(s: State, speaker: string): string[] {
  // Prefer the room roster so a head can wake a peer that has not spoken
  // this turn yet; fall back to settled participants.
  const source = s.participants.length > 0 ? s.participants : s.settled.map((a) => a.participant);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of source) {
    if (p !== speaker && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** Marker in a raw room event body (used when reconstructing state). */
export function markerInEvent(ev: RoomEvent): boolean {
  return ev.kind === "head_output" && hasAskMarker(ev.body);
}
