/**
 * Avenor control-socket client — the conversation plane for `kind: "avenor"`
 * heads (Stage 3 of the sandboxed-agent-rooms plan).
 *
 * Avenor's stable supervisor speaks JSON-RPC 2.0 over a Unix domain socket,
 * newline-delimited JSON in both directions (see avenor docs/control-protocol.md).
 * This client is deliberately thin: connect, request/response with id
 * matching, event subscription, and runtime-scoped methods (spawn, prompt,
 * cancel, answer_permission, status, result). It owns no policy — the
 * coordinator decides when to spawn, prompt, or treat a session end as a
 * turn boundary.
 *
 * The client never spawns a process itself and knows nothing about
 * sandboxes: an optional launch wrapper (e.g. paddock) is an opaque argv
 * prefix supplied by the caller at spawn time.
 */
import { connect as netConnect, type Socket } from "node:net";

/** One JSON-RPC request to the supervisor. */
interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/** Successful response (id-matched). */
interface RpcResult<T = Record<string, unknown>> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

/** Error response. */
interface RpcError {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}

type RpcMessage = RpcResult | RpcError | (Notification & Record<string, unknown>);

/** A server-push notification (no id). */
interface Notification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

/** Runtime summary, as returned by `list`/`status`. */
export interface RuntimeStatus {
  runtime_id: string;
  label?: string;
  phase?: string;
  session_id?: string;
  [key: string]: unknown;
}

/** Spawn response. */
export interface Spawned {
  runtime_id: string;
  session_id?: string;
  on_event?: string;
  sentinel_file?: string;
  [key: string]: unknown;
}

/** Spawn parameters (subset; pass-through for the rest). */
export interface SpawnParams {
  prompt?: string;
  prompt_file?: string;
  dir?: string;
  agent?: string;
  label?: string;
  model?: string;
  backend?: string;
  server_url?: string;
  on_event?: string;
  sentinel_file?: string;
  permission_handler?: string;
  auto_approve?: boolean;
  timeout?: string;
  max_retries?: number;
  session_id?: string;
  [key: string]: unknown;
}

/** One avenor runtime event (NDJSON --on-event shape; opaque here). */
export interface AvenorEvent {
  [key: string]: unknown;
}

export interface AvenorClientOptions {
  socketPath: string;
  /** Optional label used in error messages. */
  name?: string;
}

export class AvenorClient {
  private socketPath: string;
  private name: string;
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(ev: AvenorEvent) => void>();

  constructor(opts: AvenorClientOptions) {
    this.socketPath = opts.socketPath;
    this.name = opts.name ?? "avenor";
  }

  /** Connected and the supervisor answered a request. */
  async ensureConnected(): Promise<void> {
    if (this.socket) return;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = netConnect(this.socketPath, () => resolve(s));
      s.on("error", (err) => reject(err));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("error", (err) => this.died(err));
    socket.on("close", () => this.died(new Error("connection closed")));
    this.socket = socket;
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  /** Tear down the connection (does not cancel remote runtimes). */
  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  /** Subscribe to runtime events. Notifications arrive via onEvent listeners. */
  async subscribe(): Promise<void> {
    await this.ensureConnected();
    await this.request("subscribe", {});
  }

  /** Register a listener for event notifications. Returns an unsubscribe fn. */
  onEvent(fn: (ev: AvenorEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Spawn a child runtime. */
  async spawn(params: SpawnParams): Promise<Spawned> {
    await this.ensureConnected();
    return (await this.request("spawn", params as Record<string, unknown>)) as Spawned;
  }

  /** All active and recently-completed child runtimes. */
  async list(): Promise<RuntimeStatus[]> {
    await this.ensureConnected();
    return (await this.request("list", {})) as unknown as RuntimeStatus[];
  }

  /** Runtime-scoped status. */
  async status(runtimeId: string): Promise<RuntimeStatus> {
    return (await this.request("status", { runtime_id: runtimeId })) as RuntimeStatus;
  }

  /** Complete terminal reply for one runtime. */
  async result(runtimeId: string): Promise<Record<string, unknown>> {
    return this.request("result", { runtime_id: runtimeId });
  }

  /** Queue a follow-up prompt (never preempts an active turn). */
  async prompt(runtimeId: string, text: string): Promise<void> {
    await this.request("prompt", { runtime_id: runtimeId, text });
  }

  /** Cancel one runtime. */
  async cancel(runtimeId: string): Promise<void> {
    await this.request("cancel", { runtime_id: runtimeId });
  }

  /** Answer a pending permission request. */
  async answerPermission(
    runtimeId: string,
    requestId: string,
    optionId: string,
    message?: string,
  ): Promise<void> {
    await this.request("answer_permission", {
      runtime_id: runtimeId,
      request_id: requestId,
      option_id: optionId,
      ...(message !== undefined ? { message } : {}),
    });
  }

  /** One request/response round trip with id matching. */
  private request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(JSON.stringify(req) + "\n");
    });
  }

  private write(line: string): void {
    if (!this.socket) throw new Error(`${this.name}: not connected`);
    this.socket.write(line);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue; // tolerate malformed lines; the supervisor speaks NDJSON
      }
      if ("id" in msg && msg.id !== undefined) {
        const p = this.pending.get(msg.id as number);
        if (!p) continue;
        this.pending.delete(msg.id as number);
        const err = (msg as RpcError).error;
        if (err) p.reject(new Error(`${this.name}: ${err.message} (code ${err.code})`));
        else p.resolve(((msg as RpcResult).result ?? {}) as Record<string, unknown>);
      } else if ("method" in msg && msg.method === "event") {
        const ev = (msg.params ?? {}) as AvenorEvent;
        for (const fn of this.listeners) fn(ev);
      }
    }
  }

  private died(err: Error): void {
    this.socket = null;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}
