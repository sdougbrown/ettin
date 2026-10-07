/**
 * Turn governors over typed decision APIs — port of internal/room/governor_jev.go.
 *
 * Two transports, one decision core:
 *  - TypeSafeGovernor: the official System One API (jev-latest), map-form
 *    questions, noul answers as bare numbers.
 *  - LocalDecisionsGovernor: a tabbyAPI `/v1/decisions` endpoint (works for
 *    gemma4:26b), array-form questions, choice probabilities keyed by the
 *    letter labels of the option order.
 *
 * The deterministic envelope is enforced here and again by the coordinator:
 * budget, depth cap, and the human-required short-circuit never depend on the
 * model. On any transport or decode error the marker governor takes over so
 * the room keeps working without the decision API.
 */
import type { Decision, Governor, State } from "./governor.ts";
import { markerTargets, parseRoomMarker } from "./governor.ts";

export interface TypedAnswers {
  /** Choice of who speaks next: human | stop | all_heads | <head name>. */
  next: { choice: string; confidence: number; probabilities: Record<string, number> };
  mode: { choice: string; confidence: number };
  /** Yes-probabilities. */
  needs_human: number;
  requests_peer: number;
}

export interface GovernorEnv {
  apiKey: string;
  fallback: Governor;
  threshold: number; // confidence deadband; below this, return to the operator
}

const MODE_CRITERIA: [string, string][] = [
  ["continue", "keep working on the operator's request"],
  ["review", "examine the other head's work and critique it"],
  ["challenge", "stress-test the other head's conclusion"],
  ["answer_peer", "respond to a question or request from the other head"],
  ["handoff", "take over the task from the other head"],
  ["recover_blocked", "help the other head past a blocker"],
];

const NEXT_DESCRIPTIONS: Record<string, string> = {
  human: "the operator must speak next; the agents should stop and wait",
  stop: "the work for this request is done; return control to the operator",
  all_heads: "every head other than the last speaker should react in parallel",
};

const NEEDS_HUMAN_CRITERIA: [string, string] = [
  "the agents are blocked, asked the operator a question, or the request is ambiguous",
  "the agents can proceed or stop without operator input",
];

const REQUESTS_PEER_CRITERIA: [string, string] = [
  "the last output explicitly requests peer review, help, or reaction",
  "no explicit request for peer input",
];

export function boundedState(s: State, excerpt: number): Record<string, unknown> {
  const turns = s.settled.map((a) => ({
    id: a.eventId,
    head: a.participant,
    depth: a.depth,
    mode: a.mode,
    output: excerptOf(a.finalOutput, excerpt),
    blocked: String(a.blocked),
  }));
  return {
    human_request: excerptOf(s.humanInput, excerpt),
    participants: s.participants,
    peer_depth: s.depth,
    max_peer_depth: s.maxDepth,
    budget_remaining: s.budgetRemaining,
    last_speaker: s.settled.length ? s.settled[s.settled.length - 1]!.participant : "",
    turns_this_request: turns,
  };
}

function excerptOf(s: string, limit: number): string {
  if (limit <= 0 || s.length <= limit) return s;
  return `${Array.from(s).slice(0, limit).join("")} […]`;
}

/** The shared decision core: typed answers in, decision out, envelope first. */
export function decideFromAnswers(g: GovernorEnv, s: State, ans: TypedAnswers): Decision {
  if (s.budgetRemaining <= 0 || s.depth >= s.maxDepth) {
    return { activate: [], speakerEventId: "", mode: "", reason: "envelope: budget/depth" };
  }
  if (ans.needs_human >= 0.8) {
    return {
      activate: [],
      speakerEventId: "",
      mode: "",
      reason: `needs_human=${ans.needs_human.toFixed(2)} → operator`,
    };
  }
  const last = s.settled[s.settled.length - 1];
  // Envelope rule: an explicit peer request is honored unless the operator
  // intervenes — the orientation promises heads that markers work, so the
  // governor may choose who reacts and in what mode, but not whether an
  // explicit request is silently denied. A directed marker sharpens the
  // target; without one, all peers react.
  if (ans.requests_peer >= 0.8 && last) {
    const marker = parseRoomMarker(last.finalOutput);
    const targets = marker
      ? markerTargets(marker, s.participants, last.participant)
      : s.participants.filter((p) => p !== last.participant);
    if (targets.length > 0) {
      return {
        activate: targets,
        speakerEventId: last.eventId,
        mode: ans.mode.choice,
        reason: `peer request honored (requests_peer=${ans.requests_peer.toFixed(2)}) targets=${targets.join(",")} mode=${ans.mode.choice} (next=${ans.next.choice} p=${(ans.next.probabilities[ans.next.choice] ?? ans.next.confidence).toFixed(2)})`,
      };
    }
  }
  const dist = Object.entries(ans.next.probabilities)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ");
  if (ans.next.confidence < g.threshold) {
    return {
      activate: [],
      speakerEventId: "",
      mode: "",
      reason: `next=${ans.next.choice} confidence=${ans.next.confidence.toFixed(2)} below deadband → operator [${dist}]`,
    };
  }
  if (ans.next.choice === "human" || ans.next.choice === "stop") {
    return {
      activate: [],
      speakerEventId: "",
      mode: "",
      reason: `next=${ans.next.choice} (p=${(ans.next.probabilities[ans.next.choice] ?? ans.next.confidence).toFixed(2)}) [${dist}]`,
    };
  }
  if (ans.next.choice === "all_heads") {
    const targets = s.participants.filter((p) => !last || p !== last.participant);
    if (targets.length === 0 || !last) {
      return {
        activate: [],
        speakerEventId: "",
        mode: "",
        reason: "no peer output to react to → operator",
      };
    }
    return {
      activate: targets,
      speakerEventId: last.eventId,
      mode: ans.mode.choice,
      reason: `all_heads p=${ans.next.confidence.toFixed(2)} mode=${ans.mode.choice} [${dist}]`,
    };
  }
  if (!s.participants.includes(ans.next.choice)) {
    return {
      activate: [],
      speakerEventId: "",
      mode: "",
      reason: `unknown participant "${ans.next.choice}" → operator [${dist}]`,
    };
  }
  // The chosen head reacts to the most recent output not its own.
  const speakerEvent = [...s.settled].toReversed().find((a) => a.participant !== ans.next.choice);
  if (!speakerEvent) {
    return {
      activate: [],
      speakerEventId: "",
      mode: "",
      reason: "no peer output to react to → operator",
    };
  }
  return {
    activate: [ans.next.choice],
    speakerEventId: speakerEvent.eventId,
    mode: ans.mode.choice,
    reason: `next=${ans.next.choice} p=${(ans.next.probabilities[ans.next.choice] ?? ans.next.confidence).toFixed(2)} mode=${ans.mode.choice} [${dist}]`,
  };
}

async function fallback(g: GovernorEnv, s: State, err: unknown): Promise<Decision> {
  const d = await g.fallback.decide(s);
  return {
    ...d,
    reason: `decision api unavailable (${err instanceof Error ? err.message : String(err)}); marker fallback: ${d.reason}`,
  };
}

/** Official TypeSafe System One (jev-latest). */
export class TypeSafeGovernor implements Governor {
  constructor(
    private env: GovernorEnv,
    private endpoint = "https://api.typesafe.ai/v1/systemone",
    private model = "jev-latest",
    private excerpt = 800,
  ) {}

  async decide(s: State): Promise<Decision> {
    try {
      const choiceOpts: Record<string, string> = { ...NEXT_DESCRIPTIONS };
      for (const p of s.participants) choiceOpts[p] = `head ${p} should get the next turn`;
      const body = {
        model: this.model,
        state: boundedState(s, this.excerpt),
        questions: {
          next: {
            type: "choice",
            instructions:
              "One head just finished a turn in a shared room with an operator. Who should speak next?",
            criteria: choiceOpts,
          },
          mode: {
            type: "choice",
            instructions: "If a head is activated next, what kind of turn should it be?",
            criteria: Object.fromEntries(MODE_CRITERIA),
          },
          needs_human: {
            type: "noul",
            instructions:
              "Does this situation require an operator decision before any head continues?",
            criteria: { true: NEEDS_HUMAN_CRITERIA[0], false: NEEDS_HUMAN_CRITERIA[1] },
          },
          requests_peer: {
            type: "noul",
            instructions:
              "Did the most recent speaker explicitly ask for the peer's input or review?",
            criteria: { true: REQUESTS_PEER_CRITERIA[0], false: REQUESTS_PEER_CRITERIA[1] },
          },
        },
      };
      const res = await postJson(this.endpoint, this.env.apiKey, body);
      const answers = res.answers as Record<
        string,
        {
          type: string;
          choice?: string;
          confidence?: number;
          probabilities?: Record<string, number>;
          noul?: number;
        }
      >;
      return decideFromAnswers(this.env, s, {
        next: {
          choice: answers.next?.choice ?? "",
          confidence: answers.next?.confidence ?? 0,
          probabilities: answers.next?.probabilities ?? {},
        },
        mode: {
          choice: answers.mode?.choice ?? "continue",
          confidence: answers.mode?.confidence ?? 0,
        },
        needs_human: answers.needs_human?.noul ?? 0,
        requests_peer: answers.requests_peer?.noul ?? 0,
      });
    } catch (err) {
      return fallback(this.env, s, err);
    }
  }
}

/** tabbyAPI `/v1/decisions`: same questions, letter-labeled probabilities. */
export class LocalDecisionsGovernor implements Governor {
  constructor(
    private env: GovernorEnv,
    private endpoint = "http://localhost:8081/v1/decisions",
    private model?: string,
    private excerpt = 800,
  ) {}

  async decide(s: State): Promise<Decision> {
    try {
      const choiceOpts: { name: string; description: string }[] = Object.entries(
        NEXT_DESCRIPTIONS,
      ).map(([name, description]) => ({
        name,
        description,
      }));
      for (const p of s.participants)
        choiceOpts.push({ name: p, description: `head ${p} should get the next turn` });
      const body = {
        model: this.model,
        input: boundedState(s, this.excerpt),
        questions: [
          {
            id: "next",
            type: "choice",
            question:
              "One head just finished a turn in a shared room with an operator. Who should speak next?",
            options: choiceOpts,
          },
          {
            id: "mode",
            type: "choice",
            question: "If a head is activated next, what kind of turn should it be?",
            options: MODE_CRITERIA.map(([name, description]) => ({ name, description })),
          },
          {
            id: "needs_human",
            type: "yes_no",
            question: "Does this situation require an operator decision before any head continues?",
            yes_description: NEEDS_HUMAN_CRITERIA[0],
            no_description: NEEDS_HUMAN_CRITERIA[1],
          },
          {
            id: "requests_peer",
            type: "yes_no",
            question: "Did the most recent speaker explicitly ask for the peer's input or review?",
            yes_description: REQUESTS_PEER_CRITERIA[0],
            no_description: REQUESTS_PEER_CRITERIA[1],
          },
        ],
      };
      const res = await postJson(this.endpoint, this.env.apiKey, body);
      const answers = res.answers as Record<string, Record<string, unknown>>;
      // Choice probabilities are keyed by label (A = first option); map
      // letters back to option names.
      const nextQ = body.questions[0]! as { options: { name: string }[] };
      const letterToName = new Map(
        nextQ.options.map((o, i) => [String.fromCharCode(65 + i), o.name]),
      );
      const nextProbs: Record<string, number> = {};
      let bestName = "";
      let bestP = 0;
      for (const [letter, p] of Object.entries(
        (answers.next?.probabilities ?? {}) as Record<string, number>,
      )) {
        const name = letterToName.get(letter) ?? letter;
        nextProbs[name] = p;
        if (p > bestP) {
          bestP = p;
          bestName = name;
        }
      }
      const modeLetters = MODE_CRITERIA.map(([name]) => name);
      const modeProbs = (answers.mode?.probabilities ?? {}) as Record<string, number>;
      let modeChoice = modeLetters[0]!;
      let modeP = -1;
      for (const [i, name] of modeLetters.entries()) {
        const p = modeProbs[String.fromCharCode(65 + i)] ?? 0;
        if (p > modeP) {
          modeP = p;
          modeChoice = name;
        }
      }
      return decideFromAnswers(this.env, s, {
        next: { choice: bestName, confidence: bestP, probabilities: nextProbs },
        mode: { choice: modeChoice, confidence: modeP },
        needs_human: Number(
          (answers.needs_human?.probabilities as Record<string, number> | undefined)?.yes ?? 0,
        ),
        requests_peer: Number(
          (answers.requests_peer?.probabilities as Record<string, number> | undefined)?.yes ?? 0,
        ),
      });
    } catch (err) {
      return fallback(this.env, s, err);
    }
  }
}

async function postJson(
  endpoint: string,
  apiKey: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`decision api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as Record<string, unknown>;
}
