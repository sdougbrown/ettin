/**
 * Governor comparison: run the same synthetic room states through the
 * official TypeSafe Jev and the local /v1/decisions endpoint (gemma4:26b),
 * side by side. No heads needed — the governors are pure transport calls.
 *
 * Usage: npx tsx scripts/governor-compare.ts
 */
import { MarkerGovernor } from "../src/room/governor.ts";
import { LocalDecisionsGovernor, TypeSafeGovernor } from "../src/room/governor_jev.ts";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Decision, State } from "../src/room/governor.ts";

const key = readFileSync(`${homedir()}/.secrets/jev.key`, "utf8").trim();
const env = { apiKey: key, fallback: new MarkerGovernor(), threshold: 0.35 };
const jev = new TypeSafeGovernor(env);
const local = new LocalDecisionsGovernor(env, "http://localhost:8081/v1/decisions");

function state(partial: Omit<Partial<State>, "reactedTo"> & { reactedTo?: string[] }): State {
  return {
    humanInput: partial.humanInput ?? "How should we rate-limit the API?",
    participants: partial.participants ?? ["a", "b"],
    settled: partial.settled ?? [],
    reactedTo: new Set(partial.reactedTo ?? []),
    depth: partial.depth ?? 0,
    budgetRemaining: partial.budgetRemaining ?? 8,
    maxDepth: partial.maxDepth ?? 2,
  };
}

function act(
  participant: string,
  eventId: string,
  output: string,
  extra: Record<string, unknown> = {},
) {
  return {
    participant,
    eventId,
    mode: "answer",
    depth: 0,
    stopReason: "stop",
    finalOutput: output,
    blocked: false,
    ...extra,
  };
}

const SCENARIOS: { name: string; state: () => State }[] = [
  {
    name: "S1 explicit marker from b (all peers)",
    state: () =>
      state({
        settled: [
          act("a", "a2", "Token bucket keyed by IP, backed by Redis. Simple and scales."),
          act("b", "b2", "Fixed-window counter per IP is fine for small APIs.\n<|room: ask-peer|>"),
        ],
      }),
  },
  {
    name: "S2 converged, no marker (b asked via marker earlier; a agreed)",
    state: () =>
      state({
        depth: 1,
        reactedTo: ["b2"],
        settled: [
          act(
            "b",
            "b2",
            "Fixed-window counter per IP; Redis when multi-instance.\n<|room: ask-peer|>",
            { depth: 0 },
          ),
          act(
            "a",
            "a3",
            "I agree with b — fixed-window counter per IP; Redis only when multi-instance.",
            { depth: 1, mode: "react" },
          ),
        ],
      }),
  },
  {
    name: "S3 head blocked (unanswered error)",
    state: () =>
      state({
        settled: [
          act("a", "a2", "", {
            blocked: true,
            stopReason: "unanswered: model_error",
            finalOutput: "",
          }),
        ],
      }),
  },
  {
    name: "S4 ambiguous request, no markers, a spoke last",
    state: () =>
      state({
        humanInput: "Make the auth system better. You decide what that means.",
        settled: [
          act(
            "a",
            "a2",
            "I could add OAuth, or harden sessions, or both — the scope is unclear to me.",
          ),
        ],
      }),
  },
  {
    name: "S5 clean completion, both answered, no markers",
    state: () =>
      state({
        settled: [
          act(
            "a",
            "a2",
            "Sliding-window counter in middleware; in-process is fine for one instance.",
          ),
          act("b", "b2", "Same: sliding-window counter; Redis only for multi-instance."),
        ],
      }),
  },
  {
    name: "S6 directed marker from a → b",
    state: () =>
      state({
        settled: [act("a", "a2", "Proposal: token bucket.\n<|room: ask-peer | b|>")],
      }),
  },
];

const pad = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);

for (const sc of SCENARIOS) {
  const s = sc.state();
  console.log(`\n=== ${sc.name}`);
  const results: (Decision | string)[] = await Promise.all([
    jev.decide(s).catch((e) => `error: ${e}`),
    local.decide(s).catch((e) => `error: ${e}`),
  ]);
  const rows: [string, Decision | string][] = [
    ["jev-latest      ", results[0]!],
    ["gemma4 /decisions", results[1]!],
  ];
  for (const [label, d] of rows) {
    if (typeof d === "string") {
      console.log(`  ${label} ERROR ${d}`);
    } else if (d.activate.length === 0) {
      console.log(`  ${label} → operator: ${d.reason}`);
    } else {
      console.log(
        `  ${label} → activate ${d.activate.join(",")} mode=${d.mode} | ${pad(d.reason, 96)}`,
      );
    }
  }
}
