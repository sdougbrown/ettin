/**
 * Ettin app: wires the pi-durable harness, the room conversation (the room
 * log), head conversations, and the durable turn task together.
 *
 * Conversation plane: pi-durable (room record, head transcripts, durability).
 * The coordinator task is the control plane; it drives head conversations
 * through submissions and owns all turn enforcement.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  RoomDoc,
  RoomEventEntry,
  roomEvents,
  type HeadRecord,
  type RoomContext,
  type RoomEvent,
} from "./room/room.ts";
import { MarkerGovernor, type Governor } from "./room/governor.ts";
import { defineTurnTask } from "./room/coordinator.ts";
import { HeadManager } from "./heads.ts";
import { loadModels, type ModelSource } from "./models.ts";

export interface AppOptions {
  prefer?: "sparky" | "faux";
  /** Injected model source (tests); otherwise loadModels() decides. */
  models?: ModelSource;
  dbPath: string;
  workspace: string;
  thinkingLevel: string;
  maxDepth: number;
  maxAuto: number;
  excerptLimit: number;
  roomRef: string;
}

export class EttinApp {
  rc!: RoomContext;
  heads!: HeadManager;
  turnTask!: ReturnType<typeof defineTurnTask>;
  governor: Governor = new MarkerGovernor();
  models!: ModelSource;

  constructor(public options: AppOptions) {}

  async open(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.models =
      this.options.models ?? loadModels({ allowFauxFallback: true, prefer: this.options.prefer });
    const registry = createRegistry();

    const storage =
      this.options.dbPath === ":memory:"
        ? new MemoryStorage()
        : await openNodeSqliteStorage(this.options.dbPath);
    const harness = await Harness.open(storage, { models: this.models.models, registry }, ctx);

    // The room conversation: transcript of ettin.event entries. No tools,
    // no extensions, and nothing is ever submitted to it — only writes.
    // The reserved root conversation, so the room log survives restarts.
    const room = await harness.root(ctx, { agent: { extensions: [], tools: [] } });
    this.rc = { harness, room };

    this.heads = new HeadManager(this.rc, this.models, {
      workspace: this.options.workspace,
      thinkingLevel: this.options.thinkingLevel,
      excerptLimit: this.options.excerptLimit,
    });

    // Registry: arbiter + room tools for heads, the turn task for the
    // coordinator. Extension objects are built against the live context.
    this.heads.installExtensions();
    for (const ext of this.heads.extensionList()) registry.install(ext);
    this.turnTask = defineTurnTask({
      rc: this.rc,
      governor: this.governor,
      maxDepth: this.options.maxDepth,
      maxAuto: this.options.maxAuto,
      excerptLimit: this.options.excerptLimit,
      roomRef: this.options.roomRef,
    });
    registry.install(defineExtension({ name: "ettin-turn", tasks: [this.turnTask] }));

    // Reattach to any heads a previous process created.
    await this.heads.load(ctx);
    // Start the task scheduler: pending turn tasks resume immediately, and
    // reattached heads (no bootstrap turn) still get a running scheduler.
    harness.resume();
  }

  /** Operator input → room log entry + durable turn task, in one commit. */
  async say(
    text: string,
    targets: string[] = [],
    ctx: Context = BACKGROUND_CONTEXT,
  ): Promise<{ eventId: string; taskId: number }> {
    const headNames = targets.length > 0 ? targets : this.heads.list().map((h) => h.name);
    if (headNames.length === 0) throw new Error("no heads in the room yet");
    const rc = this.rc;
    const turnTask = this.turnTask;
    return rc.room.commit(async (tx) => {
      const doc = await tx.doc(RoomDoc, rc.room.id);
      const turnNo = doc.seq + 1;
      doc.seq += 1;
      doc.counts.human = (doc.counts.human ?? 0) + 1;
      const event: RoomEvent = {
        id: `human${doc.counts.human}`,
        seq: doc.seq,
        ts: Date.now(),
        author: "human",
        kind: "human_input",
        body: text,
        visibility: "room",
        depth: 0,
        meta: { targets: headNames.join(",") },
      };
      await tx.appendEntry(RoomEventEntry, rc.room.id, { data: event });
      const task = await tx.createTask(
        turnTask,
        { humanEventId: event.id, humanText: text, targets: headNames, turnNo },
        { ownership: { kind: "conversation" } },
      );
      return { eventId: event.id, taskId: task as unknown as number };
    }, ctx);
  }

  async events(ctx: Context = BACKGROUND_CONTEXT): Promise<RoomEvent[]> {
    return roomEvents(this.rc, ctx);
  }

  async addHead(
    name: string,
    model?: string,
    ctx: Context = BACKGROUND_CONTEXT,
  ): Promise<HeadRecord> {
    // `model` is "provider/modelId" or a bare modelId; default: first choice.
    const choice =
      this.models.choices.find((c) => `${c.provider}/${c.modelId}` === model) ??
      this.models.choices.find((c) => c.modelId === model) ??
      this.models.choices[0];
    if (!choice) throw new Error("no models available");
    return this.heads.ensureHead(name, choice, ctx);
  }

  async close(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    await this.rc.harness.close(ctx);
  }
}
