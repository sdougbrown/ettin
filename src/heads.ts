/**
 * Head roster: one durable pi-durable conversation per room participant.
 *
 * Each head's agent config carries its model, tools, thinking level, and —
 * solving the working-directory question natively — its cwd in the shared
 * workspace. Native histories persist in storage across restarts; the roster
 * document (session-scoped) maps head names to conversation IDs so a
 * restarted process reattaches instead of spawning duplicates.
 */
import {
  defineExtension,
  defineTool,
  type Conversation,
  type ConversationId,
  type Extension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
} from "@earendil-works/pi-durable/tools";
import type { Context } from "@earendil-works/chord";
import { HeadsDoc, appendRoomEvent, type HeadRecord, type RoomContext } from "./room/room.ts";
import { orientationText } from "./room/projection.ts";
import type { ModelSource } from "./models.ts";
import { arbiterExtension } from "./room/arbiter.ts";

export interface HeadOptions {
  workspace: string;
  thinkingLevel: string;
  excerptLimit: number;
}

const readTool = createReadTool();
const writeTool = createWriteTool();
const editTool = createEditTool();
const bashTool = createBashTool();

interface Roster {
  /** head record by head name */
  byName: Map<string, HeadRecord>;
  /** head name by conversationId (for the arbiter) */
  nameOf: Map<ConversationId, string>;
}

/** The coding tools must live in an installed extension: an agent's `tools`
 * array is stored by name and resolved against the selected extensions' tool
 * pool, so bare tool objects in the agent config resolve to nothing. */
const Coding = defineExtension({
  name: "ettin-coding",
  tools: [readTool, writeTool, editTool, bashTool],
});

export class HeadManager {
  private roster: Roster = { byName: new Map(), nameOf: new Map() };
  private extensions:
    | {
        arbiter: ReturnType<typeof arbiterExtension>;
        roomTools: ReturnType<typeof defineExtension>;
      }
    | undefined;
  roomConversationId = "";

  constructor(
    private rc: RoomContext,
    private models: ModelSource,
    private opts: HeadOptions,
  ) {}

  /** Extensions that reference the roster must be built before install. */
  installExtensions(): void {
    const headNameOf = (conversationId: ConversationId) => this.roster.nameOf.get(conversationId);
    const roomLog = this.roomLogTool();
    const arbiter = arbiterExtension(
      headNameOf,
      writeTool as ToolRegistration<any, any>,
      editTool as ToolRegistration<any, any>,
      this.rc.room.id,
    );
    const roomTools = defineExtension({
      name: "ettin-room",
      tools: [roomLog as ToolRegistration<any, any>],
    });
    this.extensions = { arbiter, roomTools };
  }

  extensionList(): Extension<ToolRegistration>[] {
    if (!this.extensions) throw new Error("installExtensions() first");
    return [Coding, this.extensions.arbiter, this.extensions.roomTools];
  }

  private roomLogTool() {
    const rc = this.rc;
    return defineTool({
      name: "room_log",
      description:
        "Read the room record: everything the operator and the other heads have said in this shared room. " +
        "Use it to catch up on history or to check what a peer concluded.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, ctx) => {
        const events = await api.commit(async (tx) => {
          const page = await tx.scanEntries({ conversationId: rc.room.id }, 200, undefined);
          return page.items.filter((e) => e.kind === "ettin.event").map((e) => e.data);
        }, ctx);
        const lines = (events as unknown[]).map((ev) => {
          const e = ev as { author: string; id: string; kind: string; body: string };
          return `[${e.author} | ${e.id} | ${e.kind}] ${e.body}`;
        });
        return {
          content: [
            { type: "text", text: lines.length ? lines.join("\n") : "(the room record is empty)" },
          ],
        };
      },
    });
  }

  /** Existing heads from the roster document (after a restart). */
  async load(ctx: Context): Promise<void> {
    const doc = await this.rc.harness.snapshot(HeadsDoc, ctx);
    for (const h of doc?.heads ?? []) {
      this.roster.byName.set(h.name, h);
      this.roster.nameOf.set(h.conversationId, h.name);
    }
  }

  list(): HeadRecord[] {
    return [...this.roster.byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  /** Create a head (or reattach) and run its bootstrap orientation turn. */
  async ensureHead(
    name: string,
    modelChoice: { provider: string; modelId: string; label: string },
    ctx: Context,
  ): Promise<HeadRecord> {
    const existing = this.roster.byName.get(name);
    if (existing) return existing;
    if (!this.extensions) throw new Error("installExtensions() first");
    const peers = this.list().map((h) => h.name);
    const conversation = await this.rc.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: modelChoice.provider, modelId: modelChoice.modelId },
          thinkingLevel: this.opts.thinkingLevel as never,
          tools: [readTool, writeTool, editTool, bashTool],
          instructions: orientationText(name, peers, this.opts.workspace),
          cwd: this.opts.workspace,
        },
      },
      ctx,
    );
    const record: HeadRecord = {
      name,
      conversationId: conversation.id,
      model: modelChoice.modelId,
      provider: modelChoice.provider,
    };
    this.roster.byName.set(name, record);
    this.roster.nameOf.set(conversation.id, name);
    await this.saveRoster(ctx);
    await appendRoomEvent(
      this.rc,
      {
        author: "room",
        kind: "system",
        body: `head ${name} joined (${modelChoice.provider}/${modelChoice.modelId})`,
        visibility: "room",
        depth: 0,
      },
      ctx,
    );
    await this.bootstrap(conversation, name, ctx);
    return record;
  }

  private async bootstrap(conversation: Conversation, name: string, ctx: Context): Promise<void> {
    const submission = await conversation.submit(
      {
        type: "input",
        content:
          `You are head "${name}" in a shared room with an operator and peer head(s). ` +
          "Wait for the operator's first instruction; acknowledge in one line.",
        requestId: `bootstrap-${name}`,
      },
      ctx,
    );
    const settled = await submission.wait(ctx);
    let body = "";
    if (settled.status === "done") {
      const page = await conversation.entries({}, 1, undefined, ctx); // newest
      const answer = page.items.find((e) => e.id === settled.answer) ?? page.items[0];
      body = (
        (answer?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)
          ?.content ?? []
      )
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
    } else {
      body = `(bootstrap failed: ${settled.reason})`;
    }
    await appendRoomEvent(
      this.rc,
      {
        author: name,
        kind: "head_output",
        body,
        visibility: "room",
        depth: 0,
        meta: { mode: "bootstrap" },
      },
      ctx,
    );
  }

  private async saveRoster(ctx: Context): Promise<void> {
    await this.rc.harness.commit(async (tx) => {
      const doc = await tx.doc(HeadsDoc);
      doc.heads = this.list();
    }, ctx);
  }
}
