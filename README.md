# Ettin

A two-headed room for persistent coding agents — the pi-durable port of the
avenor room spike (`~/Code/avenor`, branch `room-spike`).

Two persistent agent heads and a human operator share one room record. The
operator speaks; the room fans the input out to every head; a deterministic
turn governor runs bounded peer rounds; a mutation arbiter serializes
workspace writes during parallel windows. Everything — the room log, head
transcripts, the turn loop itself — is durable and survives restarts.

```
operator (web UI)
    │
    ├─ room conversation ── ettin.event entries: the room log
    │                          (author, kind, visibility, parents, depth)
    ├─ head conversations ── native durable transcripts per head
    │                          (model, tools, cwd, instructions per agent)
    └─ ettin.turn task ────── durable coordinator state machine
                               (fanout → decide → react → …)
```

**Conversation plane** is pi-durable (`@earendil-works/pi-durable`): SQLite
storage, atomic commits, resumable tasks. **The control plane** is the
`ettin.turn` task in `src/room/coordinator.ts`, the direct port of the
avenor reference implementation's `HumanTurn`.

## Ported from the avenor spike

| Concern | Where |
|---|---|
| Room log (visibility, causation, depth) | `src/room/room.ts` — custom `ettin.event` entries + counter doc |
| Turn governor (marker stub) | `src/room/governor.ts` — `MarkerGovernor`, same envelope |
| Projection + peer injection | `src/room/projection.ts` — channel-wrap convention, verbatim |
| Mutation arbiter | `src/room/arbiter.ts` — tool wrappers, atomic holder claims |
| Turn loop (HumanTurn) | `src/room/coordinator.ts` — durable `ettin.turn` task |
| Head roster | `src/heads.ts` — one durable conversation per head |

What changed relative to the Go reference:

- **Arbiter enforcement** moved from the permission layer to wrapped
  write/edit tools whose claims run in atomic Session commits (a
  session-scoped doc holds the write holder). Same policy: first writer wins,
  one deny-with-nudge per head per window, bash deliberately ungated.
- **Turn completion** is submissions + task checkpoints, not event pumps.
  Re-submits are keyed by requestId, so a restarted task never double-prompts
  a head.
- **The room log** lives in durable storage instead of a workspace NDJSON
  file; heads reach it through a `room_log` tool (`replay: "safe"`).
- **Workspace cwd** is a per-conversation agent field — the working-directory
  question solved natively.

## Run

```bash
npm install
npm start          # http://localhost:7947
```

Options: `--db ./data/ettin.sqlite --workspace /path/to/repo --port 7947
--heads a,b --thinking off --max-depth 2 --max-auto 8`.

Models come from `~/.pi/agent/models.json` (the `sparky` LiteLLM provider,
same as the avenor spike). When sparky is unreachable the scripted faux
provider takes over so the room runs end to end offline.

## Checks

```bash
npm run typecheck  # tsc --noEmit
npm run lint       # oxlint
npm run fmt        # oxfmt --write
npm run smoke      # full room loop on scripted faux providers
```

## Deliberate limitations (per the spike)

- Private asides (fork-based) not wired yet — the data model has the place.
- Jev governor not ported; `MarkerGovernor` is the floor and the interface is
  the slot.
- `bash` is not gated by the arbiter; mutation detection is advisory.
- One process owns the storage (pi-durable constraint).
