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
  script: string[],
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
  faux.setResponses(script.map((text) => fauxAssistantMessage([fauxText(text)])));
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
]);
const headB = scriptedFaux("faux-head-b", [
  "head b ready.", // bootstrap
  "Peer A's bucket undercounts bursts; counterproposal: leaky bucket.", // react
  "Aligned, nothing to add.", // turn 1 react
  "This is aligned <|room: ask-peer|> inline. // turn 2: embedded in prose — ignored",
  "Confirmed, done.", // turn 3: no marker anywhere,
]);

const models = createModels();
models.setProvider(headA.handle.provider);
models.setProvider(headB.handle.provider);
const modelSource: ModelSource = {
  kind: "faux",
  models,
  choices: [headA.choice, headB.choice],
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

const afterBootstrap = await app.events();
const bootOutputs = afterBootstrap.filter((e) => e.kind === "head_output");
if (bootOutputs.length !== 2)
  throw new Error(`expected 2 bootstrap outputs, got ${bootOutputs.length}`);

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
// 2 bootstrap + 2 fan-out + 1 react
if (outputs.length !== 5) {
  throw new Error(
    `expected 5 head outputs (2 bootstrap, 2 fanout, 1 react), got ${outputs.length}:\n` +
      events.map((e) => `[${e.id}] ${e.kind}: ${e.body.slice(0, 80)}`).join("\n"),
  );
}

const aFanout = outputs.find((e) => e.author === "a" && e.meta?.mode === "answer");
const bFanout = outputs.find((e) => e.author === "b" && e.meta?.mode === "answer");
const bReact = outputs.find((e) => e.author === "b" && e.meta?.mode === "react");
if (!aFanout || !bFanout || !bReact) throw new Error("missing fan-out or react activations");

if (aFanout.parents?.[0] !== human.id) throw new Error(`a fan-out parent should be ${human.id}`);
if (bFanout.parents?.[0] !== human.id) throw new Error(`b fan-out parent should be ${human.id}`);
if (!bReact.parents?.includes(aFanout.id))
  throw new Error(`b react should reference a's output ${aFanout.id}`);
if (bReact.depth !== 1) throw new Error(`b react depth should be 1, got ${bReact.depth}`);
if (!aFanout.body.includes("<|room: ask-peer|>")) throw new Error("a's output lost its marker");

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

const all = await app.events();
const lastSeq = all.findIndex((e) => e.id === "human2") - 1;
const turns23 = all.filter((e) => e.seq > (lastSeq >= 0 ? all[lastSeq]!.seq : 0));
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
