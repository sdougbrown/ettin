# Turn-governor comparison: Jev vs local /decisions

Record of the experiment that picked and validated the typed decision APIs
behind Ettin's turn governor. Everything here replays with:

```bash
npm run compare          # synthetic states, side by side
# live rooms:
npm start -- --governor decisions --port 7971
npm start -- --governor jev      --port 7972
```

## What was compared

Both governors share one decision core (`decideFromAnswers` in
`src/room/governor_jev.ts`); only the transport differs.

| | TypeSafeGovernor | LocalDecisionsGovernor |
|---|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone` | `POST http://localhost:8081/v1/decisions` (tabbyAPI) |
| Model | `jev-latest` (System One) | `gemma-4-26B-A4B-it-exl3` (current loaded model) |
| Question form | map keyed by name; `criteria` as name→description | array with `id`; choice `options` as `{name, description}` |
| Answers | `choice` + `confidence` + `probabilities` by option name; `noul` as a bare number | `probabilities` keyed by letter labels (A = first option), mapped back to names; `yes`/`no` probability pairs |
| Calibration | spreads probability across alternatives | near-1.00 mass on one label |

## Synthetic scenarios (npm run compare)

Six bounded room states; both transports, one request each. Values from the
2026-10-06 run (they replay on demand; transport latency is the only
variable).

| Scenario | jev-latest | gemma4 /decisions |
|---|---|---|
| S1 marker asks all peers | activate a, answer_peer (next=a p=0.68) | activate a, answer_peer (requests_peer=1.00) |
| S2 converged after an agreed react round | stop (p=0.56) | stop (p=1.00) |
| S3 head blocked (unanswered error) | activate b, recover_blocked (p=0.72) | needs_human=0.98 → operator |
| S4 ambiguous request | needs_human=0.84 → operator | needs_human=1.00 → operator |
| S5 clean completion, no markers | stop (p=0.50) | stop (p=1.00) |
| S6 directed marker → b | honor, targets=b | honor, targets=b |

## Live comparison (same scenario, two rooms)

Setup for both runs: two sparky/qwen heads, thinking off, unqualified
question ("best rate-limiting approach for a small HTTP API?"), marker
taught in the orientation header.

**gemma4 /decisions** — both heads emitted `<|room: ask-peer|>` in their
fan-out answers; the governor honored each request (requests_peer=1.00) and
ran two react rounds to the depth cap:

```text
[room3] activate a mode=answer_peer: peer request honored (requests_peer=1.00) targets=a (next=a p=0.99)
[room4] activate b mode=answer_peer: peer request honored (requests_peer=1.00) targets=b (next=stop p=1.00)
[room5] return to human: envelope: budget/depth
```

**jev-latest** — first marker honored (requests_peer=0.88); after a's
reaction agreed with b, the governor judged `stop p=0.77` and returned one
round earlier:

```text
[room3] activate a mode=answer_peer: peer request honored (requests_peer=0.88) (next=stop p=0.39)
[room4] return to human: next=stop (p=0.77)
```

## Findings

1. The envelope is the load-bearing part. `needs_human ≥ 0.8`,
   `requests_peer ≥ 0.8`, budget, and the depth cap produced correct,
   terminating behavior under both models. The blocked-head short-circuit in
   the coordinator runs before the governor, so scenario S3 resolves
   identically in a live room regardless of the model's choice.
2. The models differ in reading convergence. jev-latest returned a round
   earlier than gemma4 on the live run: it read a's agreement as "work
   done" (stop p=0.77) where gemma4 honored the second marker literally.
   Neither behavior is wrong; jev spends fewer turns on agreement rounds.
3. gemma4's distributions are near-1.00 on every label mass. Confidence
   thresholds (the 0.35 deadband) therefore never trip for gemma4, and the
   choice itself carries the decision. Treat its probabilities as
   argmax-with-noise, not calibrated spread.
4. Directed markers work under both transports: the `requests_peer` honor
   path reads the speaker's marker and narrows targets (`S6`, and live:
   `targets=a`, `targets=b`).
5. Latency is small at turn scale: one request per activation boundary
   (four questions), roughly 1–3 s against both endpoints.

## Known limitations

- One run per scenario; the distributions are single samples, not
  statistics. `npm run compare` re-runs cheaply.
- The state sent to the governor bounds each output to 800 characters;
  longer outputs are elided before the model sees them.
- gemma4's near-1.00 confidence makes the deadband ineffective for the
  local endpoint. A temperature change (default 1.0) or a calibration pass
  would spread the mass; the envelope does not depend on it.
- The TypeSafe API's `noul` answer is a single number; the yes/no wording
  of the question decides its polarity, and the decision core assumes
  "yes = needs human" / "yes = requests peer".

## Follow-ups

- Log the full answer distributions as structured governor-event meta (the
  room log currently carries the reason string with a compact distribution).
- Re-run the comparison after each gemma4/jev model update; the script is
  the regression check for governor behavior.
