/**
 * Ettin app: wires the pi-durable harness, the room conversation (the room
 * log), head conversations, and the durable turn task together.
 *
 * Conversation plane: pi-durable (room record, head transcripts, durability).
 * The coordinator task is the control plane; it drives head conversations
 * through submissions and owns all turn enforcement.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  RoomDoc,
  RoomEventEntry,
  roomEvents,
  appendRoomEvent,
  type HeadRecord,
  type RoomContext,
  type RoomEvent,
} from "./room/room.ts";
import { MarkerGovernor, type Governor } from "./room/governor.ts";
import { defineTurnTask } from "./room/coordinator.ts";
import { HeadManager } from "./heads.ts";
import { loadModels, type ModelSource } from "./models.ts";
import { AvenorClient } from "./avenor.ts";
import { parseRoomConfig, readRosterEntry, type AvenorHeadDef, type RoomConfig } from "./roster.ts";

export interface AppOptions {
  prefer?: "config" | "faux";
  governor?: Governor;
  /** Per-activation deadline; 0 uses the 15-minute default. */
  turnTimeoutMs?: number;
  /** Injected model source (tests); otherwise loadModels() decides. */
  models?: ModelSource;
  dbPath: string;
  workspace: string;
  thinkingLevel: string;
  maxDepth: number;
  maxAuto: number;
  excerptLimit: number;
  roomRef: string;
  /** Avenor stable control socket (enables kind: "avenor" heads). */
  avenorSocket?: string;
  /** Path to the room head-definition file (room.json). */
  roomConfigPath?: string;
  /** Directory holding avenor roster files (identity-only); defaults to
   * ~/.botfiles/config/rosters. Relative roster_file refs resolve here. */
  rostersDir?: string;
  /** Injected avenor client (tests); overrides avenorSocket. */
  avenorClient?: AvenorClient;
}

/** One registered avenor-driven head: room-only definition + resolved
 * roster identity (backend/agent/model live in the roster file). */
export interface AvenorHeadRegistration {
  def: AvenorHeadDef;
  entry: Record<string, unknown>;
}

/** pi-durable allows exactly one process per storage (no cross-process
 * locking). A second ettin on the same DB interleaves durable commits with
 * the live room and crashes it (observed 2026-10-16: a head-spawned test
 * instance reused the default ./data/ettin.sqlite). The pid lock file
 * turns that into a loud startup error; a stale lock from a crashed
 * process is taken over. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class EttinApp {
  rc!: RoomContext;
  heads!: HeadManager;
  turnTask!: ReturnType<typeof defineTurnTask>;
  governor: Governor = new MarkerGovernor();
  models!: ModelSource;
  /** Present when --avenor-socket is set (or a client is injected for
   * tests); lazily connects. */
  avenor: AvenorClient | null = null;
  /** Per-head live avenor runtime id, for prompt reuse across turns. */
  avenorSessions = new Map<string, string>();
  /** kind: "avenor" heads from the room config, by head name. These do not
   * participate in turns yet — coordinator activation wiring is the next
   * increment. Durable heads listed in the config ARE activated on open. */
  avenorHeads = new Map<string, AvenorHeadRegistration>();
  roomConfig: RoomConfig | null = null;
  /** Set while this process owns the storage lock (see acquireStorageLock). */
  private lockPath?: string;

  constructor(public options: AppOptions) {}

  /** pi-durable allows exactly one process per storage (no cross-process
   * locking). A second ettin on the same DB interleaves durable commits with
   * the live room and crashes it (observed 2026-10-16: a head-spawned test
   * instance reused the default ./data/ettin.sqlite). The pid lock file
   * turns that into a loud startup error; a stale lock from a crashed
   * process is taken over. */
  private acquireStorageLock(): void {
    if (this.options.dbPath === ":memory:") return;
    const lockPath = `${this.options.dbPath}.lock`;
    for (;;) {
      let fd: number;
      try {
        fd = openSync(lockPath, "wx");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const held = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (Number.isFinite(held) && held !== process.pid && pidAlive(held)) {
          throw new Error(
            `db ${this.options.dbPath} is owned by a running ettin (pid ${held}). ` +
              `Stop that process, or pass --db for a separate store.`,
            { cause: err },
          );
        }
        unlinkSync(lockPath); // stale: the owner is gone
        continue;
      }
      writeSync(fd, String(process.pid));
      closeSync(fd);
      this.lockPath = lockPath;
      process.on("exit", () => this.releaseStorageLock());
      return;
    }
  }

  private releaseStorageLock(): void {
    if (!this.lockPath) return;
    const path = this.lockPath;
    this.lockPath = undefined;
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }

  async open(ctx: Context = BACKGROUND_CONTEXT): Promise<void> {
    this.models =
      this.options.models ?? loadModels({ allowFauxFallback: true, prefer: this.options.prefer });
    if (this.options.governor) this.governor = this.options.governor;
    const registry = createRegistry();

    this.acquireStorageLock();
    const storage =
      this.options.dbPath === ":memory:"
        ? new MemoryStorage()
        : await openNodeSqliteStorage(this.options.dbPath);
    const harness = await Harness.open(
      storage,
      {
        models: this.models.models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.options.workspace }),
      },
      ctx,
    );

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

    // Avenor heads: present only when a control socket is configured (or a
    // client is injected for tests).
    this.avenor =
      this.options.avenorClient ??
      (this.options.avenorSocket
        ? new AvenorClient({ socketPath: this.options.avenorSocket, name: "avenor" })
        : null);

    // Registry: arbiter + room tools for heads, the turn task for the
    // coordinator. Extension objects are built against the live context.
    this.heads.installExtensions();
    for (const ext of this.heads.extensionList()) registry.install(ext);
    this.turnTask = defineTurnTask({
      rc: this.rc,
      governor: this.governor,
      avenor: this.avenor
        ? { client: this.avenor, heads: this.avenorHeads, sessions: this.avenorSessions }
        : undefined,
      maxDepth: this.options.maxDepth,
      maxAuto: this.options.maxAuto,
      excerptLimit: this.options.excerptLimit,
      roomRef: this.options.roomRef,
      turnTimeoutMs: this.options.turnTimeoutMs ?? 15 * 60_000,
      workspace: this.options.workspace,
    });
    registry.install(defineExtension({ name: "ettin-turn", tasks: [this.turnTask] }));

    // Reattach to any heads a previous process created.
    await this.heads.load(ctx);
    await this.applyRoomConfig(ctx);
    // Start the task scheduler: pending turn tasks resume immediately, and
    // reattached heads (no bootstrap turn) still get a running scheduler.
    harness.resume();
  }

  /** All heads — durable first, then avenor — with a kind discriminator for
   * the UI and targeting. */
  allHeads(): Array<{ name: string; model: string; provider: string; kind: "durable" | "avenor" }> {
    const durable = this.heads.list().map((h) => ({
      name: h.name,
      model: h.model,
      provider: h.provider,
      kind: "durable" as const,
    }));
    const avenor = [...this.avenorHeads.entries()].map(([name, reg]) => {
      const entry = reg.entry as { backend?: string; model?: string };
      return {
        name,
        model: entry.model ?? reg.def.roster_entry,
        provider: `avenor/${entry.backend ?? "pi"}`,
        kind: "avenor" as const,
      };
    });
    return [...durable, ...avenor];
  }

  /** Remove an avenor head registration (durable heads use removeHead). */
  removeAvenorHead(name: string): boolean {
    return this.avenorHeads.delete(name);
  }

  /** Resolve a roster file reference: absolute paths pass through; bare
   * names and relative paths resolve under the configured rosters dir. */
  private resolveRosterPath(ref: string): string {
    const dir = this.options.rostersDir;
    if (ref.startsWith("/")) return ref;
    if (!dir)
      throw new Error(`roster file "${ref}" is relative but no --rosters-dir is configured`);
    if (ref.startsWith("~")) return join(homedir(), ref.slice(1));
    return join(dir, ref.endsWith(".json") ? ref : `${ref}.json`);
  }

  /** Register an avenor-driven head: resolve its roster entry (identity
   * only) and announce it in the room log. Idempotent by name. */
  async registerAvenorHead(
    name: string,
    def: AvenorHeadDef,
    ctx: Context = BACKGROUND_CONTEXT,
  ): Promise<void> {
    if (this.avenorHeads.has(name)) return;
    if (!this.avenor) {
      throw new Error(`head "${name}" is kind "avenor" but no --avenor-socket is configured`);
    }
    let entry: Record<string, unknown> = {};
    if (def.roster_file) {
      try {
        entry = readRosterEntry(
          readFileSync(this.resolveRosterPath(def.roster_file), "utf8"),
          def.roster_entry,
        );
      } catch (err) {
        throw new Error(`roster for head "${name}": ${String(err)}`);
      }
    }
    this.avenorHeads.set(name, { def, entry });
    await appendRoomEvent(
      this.rc,
      {
        author: "room",
        kind: "system",
        body: `head ${name} joined via avenor (roster entry ${def.roster_entry}${
          def.paddock_profile ? `, paddock ${def.paddock_profile}` : ""
        })`,
        visibility: "room",
        depth: 0,
      },
      ctx,
    );
  }

  /** Apply the room head-definition file (if configured): durable heads are
   * ensured like UI-added ones; avenor heads are registered (identity from
   * the roster file) and announced. Absent config → no-op. */
  private async applyRoomConfig(ctx: Context): Promise<void> {
    if (!this.options.roomConfigPath) return;
    let raw: string;
    try {
      raw = readFileSync(this.options.roomConfigPath, "utf8");
    } catch (err) {
      throw new Error(`room config ${this.options.roomConfigPath} unreadable: ${String(err)}`);
    }
    this.roomConfig = parseRoomConfig(raw);
    for (const [name, def] of Object.entries(this.roomConfig.heads)) {
      if (this.heads.list().some((h) => h.name === name)) continue;
      if (def.kind === "durable") {
        if (!def.model) continue; // model required to create a durable head
        const provider = def.model.split("/")[0] ?? "";
        const modelId = def.model.split("/")[1] ?? def.model;
        await this.heads.ensureHead(name, { provider, modelId, label: def.model }, ctx);
      } else {
        if (!this.avenor) {
          throw new Error(`head "${name}" is kind "avenor" but no --avenor-socket is configured`);
        }
        await this.registerAvenorHead(
          name,
          {
            kind: "avenor",
            roster_entry: def.roster_entry,
            roster_file: def.roster_file,
            paddock_profile: def.paddock_profile,
            workspace: def.workspace,
            instructions: def.instructions,
          },
          ctx,
        );
      }
    }
  }

  /** Operator input → room log entry + durable turn task, in one commit.
   * While a turn is live the input is durably queued: the event is appended
   * with meta.queued and its turn is created when the live turn settles
   * (see drainPending). */
  async say(
    text: string,
    targets: string[] = [],
    ctx: Context = BACKGROUND_CONTEXT,
  ): Promise<{ eventId: string; taskId: number | null }> {
    const headNames = targets.length > 0 ? targets : this.allHeads().map((h) => h.name);
    if (headNames.length === 0) throw new Error("no heads in the room yet");
    const rc = this.rc;
    const turnTask = this.turnTask;
    const live = await this.rc.harness.inspect(ctx);
    const busy = live.tasks.some((t) => t.record.kind === "ettin.turn");
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
        meta: { targets: headNames.join(","), ...(busy ? { queued: "1" } : {}) },
      };
      await tx.appendEntry(RoomEventEntry, rc.room.id, { data: event });
      if (busy) return { eventId: event.id, taskId: null };
      const task = await tx.createTask(
        turnTask,
        { humanEventId: event.id, humanText: text, targets: headNames, turnNo },
        { ownership: { kind: "conversation" } },
      );
      return { eventId: event.id, taskId: task as unknown as number };
    }, ctx);
  }

  /** Start the turn for the oldest queued input that has none yet. Returns
   * true when a turn was created or nothing is queued; false when a turn is
   * live (retry later). Idempotent: inputs are matched to tasks by
   * humanEventId, so a restart never double-processes a queue. */
  async drainPending(ctx: Context = BACKGROUND_CONTEXT): Promise<boolean> {
    const live = await this.rc.harness.inspect(ctx);
    if (live.tasks.some((t) => t.record.kind === "ettin.turn")) return false;
    const events = await roomEvents(this.rc, ctx);
    const withTasks = new Set(
      live.tasks
        .map((t) => (t.record.input as { humanEventId?: string } | undefined)?.humanEventId)
        .filter((id): id is string => typeof id === "string"),
    );
    const rc = this.rc;
    const turnTask = this.turnTask;
    const targetsFor = (ev: RoomEvent) => {
      const parsed = String(ev.meta?.targets ?? "")
        .split(",")
        .filter(Boolean);
      return parsed.length > 0 ? parsed : this.heads.list().map((h) => h.name);
    };
    // The live-task set above cannot prove a queued input was processed: a
    // SETTLED turn is terminal and invisible to inspect(), so matching by
    // humanEventId re-creates the same turn forever (observed: 7 duplicate
    // turns for one input). The drainedSeq marker in the RoomDoc is the
    // durable processed-boundary, checked and advanced inside the same
    // atomic commit that creates the task.
    return rc.room.commit(async (tx) => {
      const doc = await tx.doc(RoomDoc, rc.room.id);
      const drained = doc.drainedSeq ?? 0;
      const next = events.find(
        (e) =>
          e.kind === "human_input" && e.meta?.queued && e.seq > drained && !withTasks.has(e.id),
      );
      if (!next) return true;
      const turnNo = doc.seq + 1;
      doc.seq += 1;
      doc.drainedSeq = next.seq;
      await tx.createTask(
        turnTask,
        { humanEventId: next.id, humanText: next.body, targets: targetsFor(next), turnNo },
        { ownership: { kind: "conversation" } },
      );
      return true;
    }, ctx);
  }

  async events(ctx: Context = BACKGROUND_CONTEXT): Promise<RoomEvent[]> {
    return roomEvents(this.rc, ctx);
  }

  async removeHead(name: string, ctx: Context = BACKGROUND_CONTEXT): Promise<boolean> {
    return this.heads.removeHead(name, ctx);
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
    this.releaseStorageLock();
  }
}
