/**
 * Mutation arbiter for durable heads — port of internal/room/arbiter.go.
 *
 * Same policy, one enforcement adapter down: avenor heads gate through the
 * permission layer; durable heads gate through tool wrappers whose claims run
 * in atomic Session commits (the session-scoped arbiter document holds the
 * write holder, so the claim survives crashes and cannot race).
 *
 * bash stays deliberately ungated, as in the spike: it is too coarse, and
 * mutation detection is advisory. The gate is a rebase-by-nudge, not a
 * correctness mechanism.
 */
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { ArbiterDoc, RoomDoc, RoomEventEntry, type RoomEvent } from "./room.ts";

const DENY_MESSAGE = (holder: string) =>
  `Workspace was just mutated by peer ${holder} while you were working from the same snapshot. ` +
  "Do not write over their change: re-read the affected files, reconcile your edit with theirs, and try again.";

type GateDecision = { allow: true } | { allow: false; holderName: string; message: string };

/** Atomically claim or deny one write attempt. Runs on the Session line, so
 * two heads racing during a parallel window get exactly one holder. */
async function claimWrite(
  api: ToolExecutionApi,
  head: string,
  ctx: Context,
): Promise<GateDecision> {
  return api.commit(async (tx) => {
    const d = await tx.doc(ArbiterDoc);
    if (!d.armed) return { allow: true };
    if (!d.holder || d.holder === head) {
      d.holder = head;
      return { allow: true };
    }
    // One denial per head per window: the first block carries the
    // re-read-and-reconcile instruction; the reconciled retry is allowed,
    // otherwise a persistent model turns the gate into a retry livelock.
    if (d.deniedOnce[head]) return { allow: true };
    d.deniedOnce[head] = true;
    return { allow: false, holderName: d.holder, message: DENY_MESSAGE(d.holder) };
  }, ctx);
}

async function recordMutation(
  api: ToolExecutionApi,
  head: string,
  path: string,
  ctx: Context,
): Promise<void> {
  await api.commit(async (tx) => {
    const d = await tx.doc(ArbiterDoc);
    d.revision += 1;
    d.mutations = [...d.mutations, { head, path, at: Date.now() }].slice(-50);
  }, ctx);
}

function gatedExecute(input: {
  tool: ToolRegistration<any, any>;
  headNameOf: (conversationId: ConversationId) => string | undefined;
  roomConversationId: ConversationId;
}): ToolRegistration<any, any> {
  const { tool, headNameOf, roomConversationId } = input;
  return {
    ...tool,
    execute: async (
      args: any,
      api: ToolExecutionApi,
      ctx: Context,
    ): Promise<ToolExecutionResult> => {
      const head = headNameOf(api.conversationId) ?? String(api.conversationId);
      const dec = await claimWrite(api, head, ctx);
      if (!dec.allow) {
        // The denial goes into the room log so the operator sees the
        // serialization happen (the Go gate logged the same event).
        await api
          .commit(async (tx) => {
            const counter = await tx.doc(RoomDoc, roomConversationId);
            counter.seq += 1;
            counter.counts.room = (counter.counts.room ?? 0) + 1;
            const event: RoomEvent = {
              author: "room",
              kind: "system",
              body: `arbiter denied ${head}'s write: workspace held by ${dec.holderName}`,
              visibility: "room",
              depth: 0,
              id: `room${counter.counts.room}`,
              seq: counter.seq,
              ts: Date.now(),
            };
            await tx.appendEntry(RoomEventEntry, roomConversationId, { data: event });
            return undefined;
          }, ctx)
          .catch(() => {});
        return {
          isError: true,
          content: [{ type: "text", text: dec.message }],
        };
      }
      const result = await tool.execute(args, api, ctx);
      if (!result.isError) await recordMutation(api, head, String(args?.path ?? ""), ctx);
      return result;
    },
  };
}

/**
 * The arbiter extension. Selected by every head conversation; the room
 * conversation never selects it. Wrapping (rather than a beforeTool hook)
 * lets the claim happen inside a commit — hooks can only read.
 */
export function arbiterExtension(
  headNameOf: (conversationId: ConversationId) => string | undefined,
  writeTool: ToolRegistration<any, any>,
  editTool: ToolRegistration<any, any>,
  roomConversationId: ConversationId,
) {
  const input = { headNameOf, roomConversationId };
  return defineExtension({
    name: "ettin-arbiter",
    wraps: [
      wrapTool(writeTool, (t) => gatedExecute({ tool: t, ...input })),
      wrapTool(editTool, (t) => gatedExecute({ tool: t, ...input })),
    ],
  });
}
