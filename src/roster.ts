/**
 * Head definition schema — Stage 3 of the sandboxed-agent-rooms plan.
 *
 * A room's `room.json` (or per-room config) declares its heads. References
 * to an Avenor roster entry stay identity-only (backend + agent/model; the
 * roster file is the single source of head identity). Room-only fields —
 * instructions overlay, paddock profile, workspace policy — live here, never
 * in the roster.
 *
 * Strict decoding: unknown fields are rejected so a typo'd config fails fast
 * at load instead of silently misrouting turns.
 */

export type HeadKind = "durable" | "avenor";

export interface AvenorHeadDef {
  kind: "avenor";
  /** Roster entry name — identity only (backend + agent/model live there). */
  roster_entry: string;
  /** Roster file location; defaults to ~/.botfiles/config/roster.json. */
  roster_file?: string;
  /** Paddock profile for sandboxing; absent = run unwrapped. */
  paddock_profile?: string;
  /** Workspace policy: "shared" (the room workspace) or "worktree" (ettin#8
   * phase 1: a git worktree + branch per head). */
  workspace?: "shared" | "worktree";
  /** Instructions overlay appended to the room projection. */
  instructions?: string;
}

export interface DurableHeadDef {
  kind: "durable";
  /** Model as provider/modelId (same shape as the add-head UI). */
  model?: string;
  instructions?: string;
}

export type HeadDef = AvenorHeadDef | DurableHeadDef;

export interface RoomHeadConfig {
  [headName: string]: HeadDef;
}

export interface RoomConfig {
  heads: RoomHeadConfig;
}

export class ConfigError extends Error {}

function fail(path: string, msg: string): never {
  throw new ConfigError(`room config: ${path}: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const AVENOR_KEYS = new Set([
  "kind",
  "roster_entry",
  "roster_file",
  "paddock_profile",
  "workspace",
  "instructions",
]);
const DURABLE_KEYS = new Set(["kind", "model", "instructions"]);

function decodeHead(name: string, raw: unknown): HeadDef {
  if (!isObject(raw)) fail(name, "expected an object");
  const kind = raw.kind;
  if (kind !== "durable" && kind !== "avenor") {
    fail(name, `kind must be "durable" or "avenor", got ${JSON.stringify(kind)}`);
  }
  if (kind === "avenor") {
    if (typeof raw.roster_entry !== "string" || raw.roster_entry.trim() === "")
      fail(name, `"avenor" heads require roster_entry (identity-only reference)`);
    for (const key of Object.keys(raw)) {
      if (!AVENOR_KEYS.has(key)) fail(name, `unknown field "${key}"`);
    }
    const def: AvenorHeadDef = {
      kind: "avenor",
      roster_entry: raw.roster_entry,
    };
    if (raw.roster_file !== undefined) {
      if (typeof raw.roster_file !== "string") fail(name, "roster_file must be a string");
      def.roster_file = raw.roster_file;
    }
    if (raw.paddock_profile !== undefined) {
      if (typeof raw.paddock_profile !== "string") fail(name, "paddock_profile must be a string");
      def.paddock_profile = raw.paddock_profile;
    }
    if (raw.workspace !== undefined) {
      if (raw.workspace !== "shared" && raw.workspace !== "worktree")
        fail(name, 'workspace must be "shared" or "worktree"');
      def.workspace = raw.workspace;
    }
    if (raw.instructions !== undefined) {
      if (typeof raw.instructions !== "string") fail(name, "instructions must be a string");
      def.instructions = raw.instructions;
    }
    return def;
  }
  for (const key of Object.keys(raw)) {
    if (!DURABLE_KEYS.has(key)) fail(name, `unknown field "${key}"`);
  }
  const def: DurableHeadDef = { kind: "durable" };
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string") fail(name, "model must be a string");
    def.model = raw.model;
  }
  if (raw.instructions !== undefined) {
    if (typeof raw.instructions !== "string") fail(name, "instructions must be a string");
    def.instructions = raw.instructions;
  }
  return def;
}

export function decodeRoomConfig(raw: unknown): RoomConfig {
  if (!isObject(raw)) fail("/", "expected an object");
  if (!isObject(raw.heads)) fail("heads", "expected an object of head name → definition");
  const heads: RoomHeadConfig = {};
  for (const [name, def] of Object.entries(raw.heads)) {
    if (!/^[a-z][\w-]*$/i.test(name)) fail(name, "head names must be alphanumeric with - or _");
    heads[name] = decodeHead(name, def);
  }
  return { heads };
}

/**
 * Parse a room config from text (JSON). Absent file → empty config (the
 * room runs with durable heads only, added via the UI as today).
 */
export function parseRoomConfig(text: string): RoomConfig {
  return decodeRoomConfig(JSON.parse(text));
}

/**
 * Read an Avenor roster file and return the named entry. Identity-only:
 * backend + agent/model. Strict about extras — roster entries must not grow
 * room concerns (sandbox, instructions).
 */
export function readRosterEntry(text: string, entryName: string): Record<string, unknown> {
  const roster = JSON.parse(text) as Record<string, unknown>;
  const entries = isObject(roster.entries) ? roster.entries : roster;
  if (!isObject(entries)) throw new ConfigError("roster: expected an object of entries");
  const entry = entries[entryName];
  if (!isObject(entry)) throw new ConfigError(`roster: no entry "${entryName}"`);
  const allowed = new Set(["backend", "agent", "model", "thinking"]);
  for (const key of Object.keys(entry)) {
    if (!allowed.has(key))
      throw new ConfigError(
        `roster entry "${entryName}": unexpected field "${key}" (identity-only)`,
      );
  }
  return entry;
}
