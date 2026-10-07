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
import {
  type ApprovalRequest,
  ApprovalDoc,
  ArbiterDoc,
  RoomDoc,
  RoomEventEntry,
  type RoomEvent,
} from "./room.ts";

/** Build a full RoomEvent (the caller's commit assigns the counter). */
function roomEvent(body: string): Omit<RoomEvent, "id" | "seq" | "ts"> {
  return { author: "room", kind: "system", body, visibility: "room", depth: 0 };
}

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
      /** Append a system event to the room log, assigning the per-author
       * counter in the same commit so IDs stay stable. */
      const logRoomEvent = async (body: string): Promise<void> => {
        await api
          .commit(async (tx) => {
            const counter = await tx.doc(RoomDoc, roomConversationId);
            counter.seq += 1;
            counter.counts.room = (counter.counts.room ?? 0) + 1;
            const event: RoomEvent = {
              ...roomEvent(body),
              id: `room${counter.counts.room}`,
              seq: counter.seq,
              ts: Date.now(),
            };
            await tx.appendEntry(RoomEventEntry, roomConversationId, { data: event });
            return undefined;
          }, ctx)
          .catch(() => {});
      };
      const dec = await claimWrite(api, head, ctx);
      if (!dec.allow) {
        // The denial goes into the room log so the operator sees the
        // serialization happen (the Go gate logged the same event).
        await logRoomEvent(`arbiter denied ${head}'s write: workspace held by ${dec.holderName}`);
        return {
          isError: true,
          content: [{ type: "text", text: dec.message }],
        };
      }
      const requiresOp = await requiresApproval(api, ctx);
      if (!requiresOp) {
        const result = await tool.execute(args, api, ctx);
        if (!result.isError) await recordMutation(api, head, String(args?.path ?? ""), ctx);
        return result;
      }
      // Operator approval: park the claim as a pending request and wait for
      // the web UI to resolve it. The tool task's durability means a crash
      // mid-wait resumes the call; the deadline denies instead of hanging.
      const requestId = await openApprovalRequest(
        api,
        head,
        tool.name,
        String(args?.path ?? ""),
        (body) => logRoomEvent(body),
        ctx,
      );
      const decision = await awaitApproval(api, requestId, head, (body) => logRoomEvent(body), ctx);
      if (decision === "allowed") {
        const result = await tool.execute(args, api, ctx);
        if (!result.isError) await recordMutation(api, head, String(args?.path ?? ""), ctx);
        return result;
      }
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `The operator denied this write. Re-read the affected files if the plan changed, and adjust; do not retry the same write.`,
          },
        ],
      };
    },
  };
}

const APPROVAL_TIMEOUT_MS = 10 * 60_000;

/** Whether operator approval is currently required for write-class calls. */
async function requiresApproval(api: ToolExecutionApi, ctx: Context): Promise<boolean> {
  const d = await api.snapshot(ApprovalDoc, ctx);
  return d?.mode === "writes";
}

async function openApprovalRequest(
  api: ToolExecutionApi,
  head: string,
  tool: string,
  path: string,
  log: (body: string) => Promise<void>,
  ctx: Context,
): Promise<string> {
  const requestId = `${head}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  await api.commit(async (tx) => {
    const d = await tx.doc(ApprovalDoc);
    const keep = d.requests.filter(
      (r) => r.state !== "pending" || Date.now() - r.requestedAt < 30 * 60_000,
    ) as ApprovalRequest[];
    const request: ApprovalRequest = {
      id: requestId,
      head,
      tool,
      path,
      state: "pending",
      requestedAt: Date.now(),
    };
    d.requests = [...keep, request].slice(-20);
    return undefined;
  }, ctx);
  await log(`approval requested: ${head} → ${tool} ${path}`);
  return requestId;
}

/** Poll the approval doc until the operator resolves the request, the
 * deadline passes, or the invocation is signalled. */
async function awaitApproval(
  api: ToolExecutionApi,
  requestId: string,
  head: string,
  log: (body: string) => Promise<void>,
  ctx: Context,
): Promise<"allowed" | "denied"> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let state: "pending" | "allowed" | "denied" | undefined;
    try {
      const d = await api.snapshot(ApprovalDoc, ctx);
      state = d?.requests.find((x) => x.id === requestId)?.state;
    } catch {
      return "denied"; // invocation signalled; do not leave the write hanging
    }
    if (state === "allowed" || state === "denied") return state;
    await new Promise((r) => setTimeout(r, 500));
  }
  await api
    .commit(async (tx) => {
      const d = await tx.doc(ApprovalDoc);
      d.requests = d.requests.map((r) =>
        r.id === requestId ? { ...r, state: "denied", resolvedAt: Date.now() } : r,
      );
      return undefined;
    }, ctx)
    .catch(() => {});
  await log(`approval for ${head} timed out; write denied`);
  return "denied";
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
