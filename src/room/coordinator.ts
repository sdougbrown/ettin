/**
 * Room coordinator — port of internal/room/coordinator.go's HumanTurn.
 *
 * The turn loop is a durable task (ettin.turn): every checkpoint — fan-out
 * prompts, settled activations, governor rounds — is committed before it is
 * acted on, so a restart resumes the turn where it stopped. Peer requests
 * re-submit by requestId, which pi-durable deduplicates, so a rerun never
 * double-prompts a head.
 *
 * The task owns all enforcement: budget, depth cap, blocked-head
 * short-circuit, and the no-echo rule. The governor only chooses within that
 * envelope.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  defineTask,
  type ConversationHandle,
  type EntryRecord,
  type SettledSubmissionRecord,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { ArbiterDoc, HeadsDoc, appendRoomEvent, type RoomContext, type RoomEvent } from "./room.ts";
import type { Activation, Decision, Governor } from "./governor.ts";
import { fanoutPrompt, peerPrompt } from "./projection.ts";

export interface TurnInput {
  /** Room log event id of the human input that woke this turn (H17). */
  humanEventId: string;
  humanText: string;
  targets: string[];
  turnNo: number;
}

/** One head's prompt for one activation of this turn, with its dedup key. */
interface PromptRef {
  head: string;
  requestId: string;
  prompt: string;
}

interface Round {
  speakerEvent: RoomEvent;
  targets: string[];
  mode: string;
}

/**
 * Per-phase checkpoint, a discriminated union: each task phase receives its
 * own variant narrowed by pi-durable's phase map (Extract<S, {phase: P}>).
 */
export type TurnCheckpoint =
  | {
      phase: "fanout";
      fanout: PromptRef[];
      settled: Activation[];
      done: string[];
      depth: number;
      budget: number;
    }
  | {
      phase: "decide";
      settled: Activation[];
      done: string[];
      depth: number;
      budget: number;
      reactedTo: string[];
    }
  | {
      phase: "react";
      round: Round;
      roundSubs: PromptRef[];
      settled: Activation[];
      done: string[];
      depth: number;
      budget: number;
      reactedTo: string[];
    };

export interface TurnResult {
  reason: string;
  activations: number;
}

export interface CoordinatorDeps {
  rc: RoomContext;
  governor: Governor;
  maxDepth: number;
  maxAuto: number;
  excerptLimit: number;
  /** Human-readable pointer into the room record for prompts. */
  roomRef: string;
}

/** Staleness notice from the arbiter's mutation record, as in the spike's
 * projection: the cheap 90% solution; the deny-and-nudge is the enforcement. */
function mutationNotice(
  mutations: { head: string; path: string; at: number }[],
  since: number,
): string | undefined {
  const fresh = mutations.filter((m) => m.at > since && m.path);
  if (fresh.length === 0) return undefined;
  const byHead = new Map<string, string[]>();
  for (const m of fresh) byHead.set(m.head, [...(byHead.get(m.head) ?? []), m.path]);
  return (
    "Note: since some heads last observed the workspace, it was changed: " +
    [...byHead].map(([head, paths]) => `by ${head}: ${paths.join(", ")}`).join("; ") +
    ". Re-read affected files before further writes."
  );
}

function textOf(message: { content?: { type: string; text?: string }[] } | undefined): string {
  return (message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

export function defineTurnTask(deps: CoordinatorDeps) {
  const { rc, governor, maxDepth, maxAuto, excerptLimit, roomRef } = deps;

  async function headIds(
    runtime: TaskRuntime<TurnInput, TurnCheckpoint, TurnResult, object>,
    ctx: Context,
  ): Promise<Map<string, ConversationId>> {
    const heads = await runtime.snapshot(HeadsDoc, ctx);
    return new Map((heads?.heads ?? []).map((h) => [h.name, h.conversationId]));
  }

  async function roomLog(
    runtime: TaskRuntime<TurnInput, TurnCheckpoint, TurnResult, object>,
    ctx: Context,
  ): Promise<RoomEvent[]> {
    const view = await runtime.context(rc.room.id, ctx);
    return view.entries
      .filter((e) => e.kind === "ettin.event" && e.data !== undefined)
      .map((e) => e.data as RoomEvent);
  }

  async function finalize<C extends TurnCheckpoint>(
    runtime: TaskRuntime<TurnInput, TurnCheckpoint, TurnResult, object>,
    ref: PromptRef,
    settledRec: SettledSubmissionRecord,
    mode: string,
    depth: number,
    parents: string[],
    cp: C,
    ctx: Context,
  ): Promise<C> {
    let stopReason = "";
    let finalOutput = "";
    if (settledRec.status === "done" && settledRec.answer !== undefined) {
      // The answer entry lives in the head's conversation; read it through a
      // table-scoped transaction (the task's conversation is the room). The
      // commit callback returns undefined: in a task, a returned value is the
      // next checkpoint, not a result.
      let answer: EntryRecord | undefined;
      await runtime.commit(async (tx) => {
        answer = await tx.entry(settledRec.answer);
        return undefined;
      }, ctx);
      const msg = answer?.model?.[0] as
        | { stopReason?: string; content?: { type: string; text?: string }[] }
        | undefined;
      stopReason = msg?.stopReason ?? "";
      finalOutput = textOf(msg);
    } else {
      stopReason = `unanswered: ${settledRec.reason}`;
    }
    const ev = await appendRoomEvent(
      rc,
      {
        author: ref.head,
        kind: "head_output",
        body: finalOutput,
        visibility: "room",
        parents,
        depth,
        meta: { mode, stopReason },
      },
      ctx,
    );
    const activation: Activation = {
      participant: ref.head,
      eventId: ev.id,
      mode,
      depth,
      stopReason,
      finalOutput,
      // The room treats anything but a clean stop as needing the operator.
      blocked: stopReason !== "" && stopReason !== "stop",
    };
    const next = { ...cp, settled: [...cp.settled, activation] };
    await runtime.commit(() => ({ status: "running" as const, checkpoint: next }), ctx);
    return next;
  }

  async function waitAndFinalize<C extends TurnCheckpoint>(
    runtime: TaskRuntime<TurnInput, TurnCheckpoint, TurnResult, object>,
    refs: PromptRef[],
    mode: string,
    depth: number,
    parentsOf: (ref: PromptRef) => string[],
    cp: C,
    ctx: Context,
  ): Promise<C> {
    const ids = await headIds(runtime, ctx);
    for (const ref of refs) {
      if (cp.done.includes(ref.requestId)) continue;
      const id = ids.get(ref.head);
      if (!id) throw new Error(`no conversation for head ${ref.head}`);
      const handle: ConversationHandle | undefined = await runtime.conversation(id, ctx);
      if (!handle) throw new Error(`conversation ${id} for head ${ref.head} not found`);
      // Re-submit by requestId: after a restart this returns the
      // existing submission instead of prompting the head twice.
      const submission = await handle.submit(
        { type: "input", content: ref.prompt, requestId: ref.requestId },
        ctx,
      );
      const settledRec = await submission.wait(ctx);
      cp = await finalize(runtime, ref, settledRec, mode, depth, parentsOf(ref), cp, ctx);
      cp = { ...cp, done: [...cp.done, ref.requestId] };
    }
    return cp;
  }

  async function appendGovernor(
    runtime: TaskRuntime<TurnInput, TurnCheckpoint, TurnResult, object>,
    reason: string,
    depth: number,
    ctx: Context,
  ): Promise<void> {
    await appendRoomEvent(
      rc,
      { author: "room", kind: "governor", body: reason, visibility: "room", depth },
      ctx,
    );
  }

  return defineTask<TurnInput, TurnCheckpoint, TurnResult, object>({
    name: "ettin.turn",
    version: 1,
    initial: (_input: TurnInput): TurnCheckpoint => ({
      phase: "fanout",
      fanout: [],
      settled: [],
      done: [],
      depth: 0,
      budget: maxAuto,
    }),
    phases: {
      fanout: async (task, runtime, ctx) => {
        let cp: TurnCheckpoint = task.state.checkpoint;
        const log = await roomLog(runtime, ctx);
        const arb = await runtime.snapshot(ArbiterDoc, ctx);
        const notice = mutationNotice(arb?.mutations ?? [], 0);
        const names = [...(await headIds(runtime, ctx)).keys()];

        // Arm the arbiter for the parallel window: every head prompted
        // from the same pre-turn snapshot shares one revision, so a
        // write landing after a peer's turn finished is still a lost
        // update. The gate lifts at the join.
        await runtime.commit(async (tx) => {
          const d = await tx.doc(ArbiterDoc);
          d.armed = true;
          d.holder = "";
          d.deniedOnce = {};
          return undefined;
        }, ctx);

        if (cp.fanout.length === 0) {
          cp = {
            ...cp,
            fanout: task.input.targets.map((head) => ({
              head,
              requestId: `turn-${task.input.turnNo}-fanout-${head}`,
              prompt: fanoutPrompt({
                events: log,
                self: head,
                participants: names,
                humanEvent: {
                  id: task.input.humanEventId,
                  seq: 0,
                  ts: 0,
                  author: "human",
                  kind: "human_input",
                  body: task.input.humanText,
                  visibility: "room",
                  depth: 0,
                },
                roomRef,
                excerptLimit,
                mutationNotice: notice,
              }),
            })),
          };
          await runtime.commit(() => ({ status: "running" as const, checkpoint: cp }), ctx);
        }

        cp = await waitAndFinalize(
          runtime,
          cp.fanout,
          "answer",
          0,
          () => [task.input.humanEventId],
          cp,
          ctx,
        );

        // Join: close the parallel window; react turns are
        // single-writer by construction (their prompts carry the
        // staleness notice).
        await runtime.commit(async (tx) => {
          const d = await tx.doc(ArbiterDoc);
          d.armed = false;
          return undefined;
        }, ctx);

        const blocked = cp.settled.find((a) => a.blocked);
        if (blocked) {
          const reason = `return to human: head ${blocked.participant} ended ${blocked.stopReason}`;
          await appendGovernor(runtime, reason, cp.depth, ctx);
          await runtime.commit(
            () => ({
              status: "terminal" as const,
              outcome: {
                status: "completed" as const,
                result: { reason, activations: cp.settled.length },
              },
            }),
            ctx,
          );
          return;
        }
        await runtime.commit(
          () => ({
            status: "running" as const,
            checkpoint: {
              phase: "decide" as const,
              settled: cp.settled,
              done: cp.done,
              depth: cp.depth,
              budget: cp.budget,
              reactedTo: [],
            },
          }),
          ctx,
        );
      },

      decide: async (task, runtime, ctx) => {
        let cp: TurnCheckpoint = task.state.checkpoint;
        const state = {
          humanInput: task.input.humanText,
          participants: [...(await headIds(runtime, ctx)).keys()],
          settled: cp.settled,
          reactedTo: new Set(cp.reactedTo),
          depth: cp.depth,
          budgetRemaining: cp.budget,
          maxDepth,
        };
        const dec: Decision = governor.decide(state);
        await appendGovernor(
          runtime,
          dec.activate.length === 0
            ? `return to human: ${dec.reason}`
            : `activate ${dec.activate.join(",")} mode=${dec.mode}: ${dec.reason}`,
          cp.depth,
          ctx,
        );
        if (dec.activate.length === 0) {
          await runtime.commit(
            () => ({
              status: "terminal" as const,
              outcome: {
                status: "completed" as const,
                result: { reason: dec.reason, activations: cp.settled.length },
              },
            }),
            ctx,
          );
          return;
        }
        // The room log holds the speaker's event; pull its body so the
        // react prompt can be rebuilt after a restart.
        const log = await roomLog(runtime, ctx);
        const speakerEvent = log.find((e) => e.id === dec.speakerEventId);
        if (!speakerEvent)
          throw new Error(`governor referenced unknown event ${dec.speakerEventId}`);
        const arb = await runtime.snapshot(ArbiterDoc, ctx);
        const notice = mutationNotice(arb?.mutations ?? [], 0);
        const round: Round = { speakerEvent, targets: dec.activate, mode: dec.mode };
        cp = {
          phase: "react",
          round,
          done: cp.done,
          settled: cp.settled,
          roundSubs: dec.activate.map((head) => ({
            head,
            requestId: `turn-${task.input.turnNo}-d${cp.depth}-react-${head}`,
            prompt: peerPrompt({
              speaker: speakerEvent,
              roomRef,
              excerptLimit,
              mutationNotice: notice,
            }),
          })),
          budget: cp.budget - dec.activate.length,
          depth: cp.depth + 1,
          reactedTo: [...cp.reactedTo, dec.speakerEventId],
        };
        await runtime.commit(() => ({ status: "running" as const, checkpoint: cp }), ctx);
      },

      react: async (task, runtime, ctx) => {
        let cp: TurnCheckpoint = task.state.checkpoint;
        const round = cp.round!;
        cp = await waitAndFinalize(
          runtime,
          cp.roundSubs,
          round.mode,
          cp.depth,
          () => [round.speakerEvent.id, task.input.humanEventId],
          cp,
          ctx,
        );
        await runtime.commit(
          () => ({
            status: "running" as const,
            checkpoint: {
              phase: "decide" as const,
              settled: cp.settled,
              done: cp.done,
              depth: cp.depth,
              budget: cp.budget,
              reactedTo: cp.reactedTo,
            },
          }),
          ctx,
        );
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(
        () => ({
          status: "terminal" as const,
          outcome: { status: "aborted" as const, reason: "turn aborted" },
        }),
        ctx,
      );
    },
  });
}
