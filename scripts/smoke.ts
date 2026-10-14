/**
 * Smoke test: the full room loop on scripted faux providers, no network.
 *
 * Each head gets its own faux provider so model-call order across
 * concurrently scheduled conversations cannot scramble the script.
 *
 * Scenario (mirrors the avenor room-spike's live Phase 1 run):
 *   1. bootstrap acks for both heads
 *   2. unqualified human input fans out; a answers with [[ask-peer]]
 *   3. marker governor activates b (react, depth 1)
 *   4. no further marker → return to operator
 *   5. assertions over the room log: ids, parents, depth, causality
 */
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxProviderHandle,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/providers/faux";
import type { HeadModelChoice, ModelSource } from "../src/models.ts";
import { mkdirSync, rmSync } from "node:fs";
import { EttinApp } from "../src/app.ts";

const TMP = "/tmp/ettin-smoke";
rmSync(TMP, { recursive: true, force: true });
mkdirSync(`${TMP}/workspace`, { recursive: true });
mkdirSync(`${TMP}/data`, { recursive: true });

/** One scripted faux provider per head: deterministic by construction. */
function scriptedFaux(
  id: string,
  script: (string | FauxResponseStep)[],
): { choice: HeadModelChoice; handle: FauxProviderHandle } {
  const faux = fauxProvider({
    provider: id,
    api: "faux",
    models: [
      {
        id: "scripted",
        name: "Scripted",
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
    ],
  });
  faux.setResponses(
    script.map((text) =>
      typeof text === "string" ? fauxAssistantMessage([fauxText(text)]) : text,
    ),
  );
  return {
    choice: { provider: id, modelId: "scripted", label: id },
    handle: faux,
  };
}

const headA = scriptedFaux("faux-head-a", [
  "head a ready.", // bootstrap
  "Proposal: gate by token bucket.\n<|room: ask-peer|>", // fan-out answer: all peers
  "Confirmed.\n<|room: ask-peer | a|>", // turn 2: self-target, filtered by no-echo
  "Standing by.", // turn 3: no marker
  "Ping received.\n@b", // turn 4: lone-line mention triggers a react round
  "Queued reply from a.", // turn 5: drained queued input
]);
// Serial react rounds are relays: b's prompt is rebuilt after a settles, so
// it must carry a's fan-out output. Captured by the response factory below.
let bReactSawARelayout = false;
let cReactSawB = false;
const headB = scriptedFaux("faux-head-b", [
  "head b ready.", // bootstrap
  "Peer A's bucket undercounts bursts; counterproposal: leaky bucket.", // turn 1 fanout
  (ctx) => {
    bReactSawARelayout = JSON.stringify(ctx).includes("gate by token bucket");
    return fauxAssistantMessage([fauxText("Aligned, nothing to add.")]);
  }, // turn 1 react (relay prompt assertion runs here)
  "This is aligned <|room: ask-peer|> inline. // turn 2: embedded in prose — ignored",
  "Confirmed, done.", // turn 3: no marker anywhere,
  "Mention heard.", // turn 4 react: triggered by a's bare "@b" mention
]);

const headC = scriptedFaux("faux-head-c", [
  "head c ready.", // bootstrap
  "Quota per client with a burst allowance.", // turn 1 fanout
  (ctx) => {
    // Serial relay: c reacts after b in the same round, so c's prompt must
    // carry b's react output (which is not the round speaker's body).
    cReactSawB = JSON.stringify(ctx).includes("Aligned, nothing to add");
    return fauxAssistantMessage([fauxText("Nothing further.")]);
  },
  "No concerns.", // turn 2: marker-free
  "Confirmed, done.", // turn 3: marker-free
]);

const models = createModels();
models.setProvider(headA.handle.provider);
models.setProvider(headB.handle.provider);
models.setProvider(headC.handle.provider);
const modelSource: ModelSource = {
  kind: "faux",
  models,
  choices: [headA.choice, headB.choice, headC.choice],
  faux: headA.handle,
};

const app = new EttinApp({
  models: modelSource,
  dbPath: `${TMP}/data/ettin.sqlite`,
  workspace: `${TMP}/workspace`,
  thinkingLevel: "off",
  maxDepth: 2,
  maxAuto: 8,
  excerptLimit: 1200,
  roomRef: "room_log tool (the shared room record)",
});

await app.open();

// Each head pinned to its own scripted provider.
await app.addHead("a", "faux-head-a/scripted");
await app.addHead("b", "faux-head-b/scripted");
await app.addHead("c", "faux-head-c/scripted");

const afterBootstrap = await app.events();
const bootOutputs = afterBootstrap.filter((e) => e.kind === "head_output");
if (bootOutputs.length !== 3)
  throw new Error(`expected 3 bootstrap outputs, got ${bootOutputs.length}`);

// Turn 1: fan-out, then a's marker triggers a react round for b.
await app.say("How should we rate-limit the API?");
// Allow the durable turn task to run to completion.
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 100));
  const evs = await app.events();
  if (evs.some((e) => e.kind === "governor" && e.body.startsWith("return to human"))) break;
}
const events = await app.events();

const human = events.find((e) => e.kind === "human_input");
if (!human) throw new Error("no human_input recorded");
const outputs = events.filter((e) => e.kind === "head_output");
// 3 bootstrap + 3 fan-out + 2 react (b, then c in serial relay order)
if (outputs.length !== 8) {
  throw new Error(
    `expected 8 head outputs (3 bootstrap, 3 fanout, 2 react), got ${outputs.length}:\n` +
      events.map((e) => `[${e.id}] ${e.kind}: ${e.body.slice(0, 80)}`).join("\n"),
  );
}

const aFanout = outputs.find((e) => e.author === "a" && e.meta?.mode === "answer");
const bFanout = outputs.find((e) => e.author === "b" && e.meta?.mode === "answer");
const bReact = outputs.find((e) => e.author === "b" && e.meta?.mode === "react");
const cReact = outputs.find((e) => e.author === "c" && e.meta?.mode === "react");
if (!aFanout || !bFanout || !bReact || !cReact)
  throw new Error("missing fan-out or react activations");

if (aFanout.parents?.[0] !== human.id) throw new Error(`a fan-out parent should be ${human.id}`);
if (bFanout.parents?.[0] !== human.id) throw new Error(`b fan-out parent should be ${human.id}`);
if (!bReact.parents?.includes(aFanout.id))
  throw new Error(`b react should reference a's output ${aFanout.id}`);
if (bReact.depth !== 1) throw new Error(`b react depth should be 1, got ${bReact.depth}`);
if (!aFanout.body.includes("<|room: ask-peer|>")) throw new Error("a's output lost its marker");
if (!bReactSawARelayout)
  throw new Error("serial relay: b's react prompt must include a's settled fanout output");
if (!cReactSawB)
  throw new Error(
    "serial relay: c's react prompt must include b's settled react output (the relay chain)",
  );

const governorEvents = events.filter((e) => e.kind === "governor");
if (!governorEvents.some((e) => e.body.includes("ask-peer marker"))) {
  throw new Error(
    `governor should have logged the marker decision: ${JSON.stringify(governorEvents.map((e) => e.body))}`,
  );
}
if (!governorEvents.some((e) => e.body.includes("return to human"))) {
  throw new Error("governor should have ended the turn back to the operator");
}

// Wait until a turn's governor logs its final decision.
async function waitForReturnToHuman(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const evs = await app.events();
    const returns = evs.filter((e) => e.kind === "governor" && e.body.includes("return to human"));
    if (returns.length >= turn) return;
  }
  throw new Error(`turn ${turn}: governor never returned to the operator`);
}

let turn = 2;
// Turn 2: a emits a marker naming itself; the no-echo rule filters the
// target out, so the turn returns to the operator without a react round.
await app.say("a: confirm your position.");
await waitForReturnToHuman();

turn = 3;
// Turn 3: b embeds a marker inside prose — whole-line matching ignores it.
await app.say("b: confirm your position.");
await waitForReturnToHuman();

turn = 4;
// Turn 4: a lone-line "@b" mention in a's output is the natural shorthand
// for ask-peer | b — it resolves (b is a participant) and triggers a round.
await app.say("@a", ["a"]);
// While turn 4 is live, a second input must queue (no turn task yet).
const queued = await app.say("queued ping", ["a"]);
if (queued.taskId !== null)
  throw new Error("input during a live turn should queue, not start a turn");
await waitForReturnToHuman();
// The settled turn leaves the queue; draining starts turn 5 for the input.
if (!(await app.events()).some((e) => e.kind === "human_input" && e.meta?.queued))
  throw new Error("queued input missing from the room log");
await app.drainPending();
turn = 5;
await waitForReturnToHuman();
const turn5 = (await app.events()).filter(
  (e) => e.kind === "head_output" && e.body === "Queued reply from a.",
);
if (turn5.length !== 1) throw new Error("drained queued input never produced its turn output");

const all = await app.events();
const lastSeq = all.findIndex((e) => e.id === "human2") - 1;
const endIdx = all.findIndex((e) => e.id === "human4");
const turns23 = all.filter(
  (e) => e.seq > (lastSeq >= 0 ? all[lastSeq]!.seq : 0) && (endIdx < 0 || all.indexOf(e) < endIdx),
);
// Turn 4 assertions: the mention round fired, attributed to the mention.
if (endIdx < 0) throw new Error("turn 4 never started");
const turn4 = all.filter((e) => e.seq >= all[endIdx]!.seq);
if (!turn4.some((e) => e.kind === "governor" && e.body.includes("ask-peer mention"))) {
  throw new Error(
    `turn 4 should react via lone-line mention: ${JSON.stringify(turn4.map((e) => e.body))}`,
  );
}
const a4ping = turn4.find((e) => e.kind === "head_output" && e.body.includes("@b"));
const b4react = turn4.find((e) => e.kind === "head_output" && e.meta?.mode === "react");
if (!a4ping || !b4react) throw new Error("turn 4: missing mention output or react");
if (!b4react.parents?.includes(a4ping.id))
  throw new Error(`turn 4: b's react should reference a's mention output ${a4ping.id}`);
const reasons = turns23.filter((e) => e.kind === "governor").map((e) => e.body);
const noPeerRequests = reasons.filter((r) => r.includes("no peer request"));
if (noPeerRequests.length !== 2) {
  throw new Error(
    `turns 2 and 3 should each end with 'no peer request'; got:\n${reasons.join("\n")}`,
  );
}
// No react activations may appear after turn 1.
const lateReacts = turns23.filter((e) => e.kind === "head_output" && e.meta?.mode === "react");
if (lateReacts.length > 0) throw new Error("turns 2/3 must not produce react rounds");

console.log("SMOKE OK");
console.log("room log:");
for (const e of all) {
  console.log(
    `  [${e.id}] ${e.kind}${e.meta?.mode ? `/${e.meta.mode}` : ""}${e.depth ? ` d${e.depth}` : ""}: ${e.body.replaceAll("\n", " / ").slice(0, 90)}`,
  );
}
await app.close();
