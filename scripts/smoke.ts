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
  "Proposal: gate by token bucket. [[ask-peer]]", // fan-out answer
  "Ack, proceeding.", // second turn
]);
const headB = scriptedFaux("faux-head-b", [
  "head b ready.", // bootstrap
  "Peer A's bucket undercounts bursts; counterproposal: leaky bucket.", // react
  "Ack, aligned.", // second turn
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
if (!aFanout.body.includes("[[ask-peer]]")) throw new Error("a's output lost its marker");

const governorEvents = events.filter((e) => e.kind === "governor");
if (!governorEvents.some((e) => e.body.includes("ask-peer marker"))) {
  throw new Error(
    `governor should have logged the marker decision: ${JSON.stringify(governorEvents.map((e) => e.body))}`,
  );
}
if (!governorEvents.some((e) => e.body.includes("return to human"))) {
  throw new Error("governor should have ended the turn back to the operator");
}

// Second turn: both answers carry no marker; the room returns to the operator.
headA.handle.appendResponses([fauxAssistantMessage([fauxText("Ack, proceeding.")])]);
headB.handle.appendResponses([fauxAssistantMessage([fauxText("Ack, aligned.")])]);
await app.say("Both of you: just confirm and stop.");
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 100));
  const evs = await app.events();
  const govs = evs.filter((e) => e.kind === "governor" && e.body.includes("return to human"));
  if (govs.length >= 2) break;
}
const events2 = await app.events();
const lastSeq = events[events.length - 1]?.seq ?? 0;
const secondTurn = events2.filter((e) => e.seq > lastSeq);
if (!secondTurn.some((e) => e.kind === "governor" && e.body.includes("no peer request"))) {
  throw new Error(
    `second turn should end with 'no peer request'; got:\n` +
      secondTurn.map((e) => `[${e.id}] ${e.kind}: ${e.body.slice(0, 90)}`).join("\n"),
  );
}

console.log("SMOKE OK");
console.log("room log:");
for (const e of events2) {
  console.log(
    `  [${e.id}] ${e.kind}${e.meta?.mode ? `/${e.meta.mode}` : ""}${e.depth ? ` d${e.depth}` : ""}: ${e.body.slice(0, 90)}`,
  );
}
await app.close();
