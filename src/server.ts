/**
 * Ettin web server: static UI + JSON API + SSE stream.
 *
 * The UI renders the room log (structured: causation, visibility, depth) and
 * subscribes to live streams: new room events as they commit, and per-head
 * agent events (streaming partials, tool calls) while a head works. Native
 * head transcripts are never mirrored — the room log is the record, head
 * streams are live decoration that ends when the head_output event lands.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { watchEvents } from "@earendil-works/pi-durable";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EttinApp } from "./app.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ApprovalDoc, RoomDoc, RoomEventEntry, type RoomEvent } from "./room/room.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export interface ServeOptions {
  port: number;
  uiDir: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface SseClient {
  id: number;
  res: ServerResponse;
}

export function serve(app: EttinApp, opts: ServeOptions): { close: () => Promise<void> } {
  const clients = new Map<number, SseClient>();
  let nextClientId = 0;
  const streamControllers = new Set<() => void>();

  function broadcast(type: string, payload: object): void {
    const frame = `event: message\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    for (const c of clients.values()) {
      try {
        c.res.write(frame);
      } catch {
        clients.delete(c.id);
      }
    }
  }

  async function watchRoom(ctx: Context): Promise<void> {
    // The room view: every commit to the room conversation broadcasts.
    const view = await app.rc.room.viewState(ctx);
    let lastSeq = 0;
    for (const e of view.value?.entries ?? []) {
      const ev = e.data as RoomEvent | undefined;
      if (e.kind === "ettin.event" && ev && ev.seq > lastSeq) lastSeq = ev.seq;
    }
    view.subscribe(async (value) => {
      for (const e of value.entries) {
        const ev = e.data as RoomEvent | undefined;
        if (e.kind !== "ettin.event" || !ev || ev.seq <= lastSeq) continue;
        lastSeq = ev.seq;
        broadcast("room_event", { event: ev });
      }
    });
  }

  async function watchHead(
    headName: string,
    conversationId: ConversationId,
    ctx: Context,
  ): Promise<void> {
    const stream = await watchEvents(app.rc.harness, conversationId, ctx);
    void stream.start(async (events) => {
      for (const ev of events) {
        switch (ev.type) {
          case "message_update": {
            for (const ch of ev.changes) {
              if (ch.type === "text_delta")
                broadcast("head_stream", { head: headName, delta: ch.delta });
            }
            break;
          }
          case "tool_execution_start":
            broadcast("head_tool", {
              head: headName,
              state: "start",
              tool: ev.toolName,
              callId: ev.toolCallId,
            });
            break;
          case "tool_execution_end":
            broadcast("head_tool", {
              head: headName,
              state: "end",
              tool: ev.toolName,
              callId: ev.toolCallId,
            });
            break;
          case "run_start":
            broadcast("head_status", { head: headName, running: true });
            break;
          case "run_end":
            broadcast("head_status", { head: headName, running: false });
            break;
        }
      }
    });
    streamControllers.add(() => void stream.stop());
  }

  async function watchApprovals(ctx: Context): Promise<void> {
    const doc = await app.rc.harness.watchDoc(ApprovalDoc, ctx);
    if (!doc) return;
    broadcast("approval_update", { approvals: doc.value });
    await doc.start(async (value) => {
      broadcast("approval_update", { approvals: value });
    });
  }

  async function startStreams(ctx: Context): Promise<void> {
    await watchRoom(ctx);
    await watchApprovals(ctx);
    for (const h of app.heads.list()) await watchHead(h.name, h.conversationId, ctx);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`event: message\ndata: ${JSON.stringify({ type: "hello" })}\n\n`);
        const client: SseClient = { id: ++nextClientId, res };
        clients.set(client.id, client);
        req.on("close", () => clients.delete(client.id));
        return;
      }
      if (url.pathname === "/api/state" && req.method === "GET") {
        json(res, 200, {
          heads: app.heads.list(),
          events: await app.events(),
          workspace: app.options.workspace,
        });
        return;
      }
      if (url.pathname === "/api/models" && req.method === "GET") {
        json(res, 200, { models: app.models.choices, kind: app.models.kind });
        return;
      }
      if (url.pathname === "/api/say" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          text?: string;
          targets?: string[];
        };
        if (!body.text?.trim()) {
          json(res, 400, { error: "text is required" });
          return;
        }
        // One operator turn at a time: a second fan-out during a live turn
        // would break the arbiter's same-snapshot assumption.
        const live = await app.rc.harness.inspect(BACKGROUND_CONTEXT);
        if (live.tasks.some((t) => t.record.kind === "ettin.turn")) {
          json(res, 409, { error: "the room is still working on the previous turn" });
          return;
        }
        const { eventId } = await app.say(body.text.trim(), body.targets ?? []);
        json(res, 200, { eventId });
        return;
      }
      if (url.pathname === "/api/turn/abort" && req.method === "POST") {
        const live = await app.rc.harness.inspect(BACKGROUND_CONTEXT);
        const turn = live.tasks.find((t) => t.record.kind === "ettin.turn");
        if (!turn) {
          json(res, 409, { error: "no turn is running" });
          return;
        }
        await app.rc.harness.abortTask(turn.record.id, BACKGROUND_CONTEXT);
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/approvals" && req.method === "GET") {
        const current = await app.rc.harness.snapshot(ApprovalDoc, BACKGROUND_CONTEXT);
        json(res, 200, { approvals: current ?? { mode: "off", requests: [] } });
        return;
      }
      if (url.pathname === "/api/approvals" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          id?: string;
          decision?: string;
        };
        if (!body.id || (body.decision !== "allow" && body.decision !== "deny")) {
          json(res, 400, { error: "id and decision (allow|deny) required" });
          return;
        }
        const result = await app.rc.harness.commit(async (tx) => {
          const d = await tx.doc(ApprovalDoc);
          const request = d.requests.find((r) => r.id === body.id);
          if (!request) return { error: "unknown approval request" };
          if (request.state !== "pending") return { error: "already resolved" };
          request.state = body.decision === "allow" ? "allowed" : "denied";
          request.resolvedAt = Date.now();
          const counter = await tx.doc(RoomDoc, app.rc.room.id);
          counter.seq += 1;
          counter.counts.room = (counter.counts.room ?? 0) + 1;
          const event: RoomEvent = {
            id: `room${counter.counts.room}`,
            seq: counter.seq,
            ts: Date.now(),
            author: "room",
            kind: "system",
            body: `operator ${request.state} ${request.head}'s write to ${request.path}`,
            visibility: "room",
            depth: 0,
          };
          await tx.appendEntry(RoomEventEntry, app.rc.room.id, { data: event });
          return { ok: true };
        }, BACKGROUND_CONTEXT);
        if ((result as { error?: string }).error) {
          json(res, 409, result);
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/approvals/mode" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { mode?: string };
        if (body.mode !== "off" && body.mode !== "writes") {
          json(res, 400, { error: "mode must be off|writes" });
          return;
        }
        const mode = body.mode as "off" | "writes";
        await app.rc.harness.commit(async (tx) => {
          const d = await tx.doc(ApprovalDoc);
          d.mode = mode;
          return undefined;
        }, BACKGROUND_CONTEXT);
        json(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/heads" && req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}") as { name?: string; model?: string };
        if (!body.name?.trim()) {
          json(res, 400, { error: "name is required" });
          return;
        }
        const record = await app.addHead(body.name.trim().toLowerCase(), body.model);
        await watchHead(record.name, record.conversationId, BACKGROUND_CONTEXT);
        json(res, 200, { head: record });
        return;
      }
      // Static UI.
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(opts.uiDir, rel.replace(/\/\.\./g, ""));
      try {
        const data = readFileSync(file);
        res.writeHead(200, {
          "content-type": MIME[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
        });
        res.end(data);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (err) {
      json(res, 500, { error: String(err instanceof Error ? err.message : err) });
    }
  });

  void startStreams(BACKGROUND_CONTEXT);
  server.listen(opts.port);
  return {
    close: () =>
      new Promise((resolve) => {
        for (const stop of streamControllers) stop();
        server.close(() => resolve());
      }),
  };
}
