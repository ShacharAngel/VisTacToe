# 1 — End-to-end flow

One move, from a frame arriving to the move being communicated. Solid participants are built today; the offline lane at the right is the learning path.

```mermaid
sequenceDiagram
  autonumber
  participant H as Human + paper
  participant C as Capture client
  participant P as Perception worker (stateless, CPU)
  participant V as Hosted VLM (OpenRouter)
  participant D as Decision service (stateful)
  participant L as Event log + learner (offline)

  H->>C: draws a mark
  C->>P: JPEG frame over WebSocket, 5 fps
  note over P: T0 gate — motion / lock / ink-diff, ~1 ms.<br/>~99% of frames end here.
  P->>P: rectify (homography) + T1 classify (features + calibration)
  alt every cell confident
    P->>D: typed observation — per-cell label + confidence
  else a cell below the ask threshold
    P->>V: single cell crop + strict json_schema
    V-->>P: label + confidence, or null on timeout / refusal
    P->>D: observation with VLM verdicts merged
  end
  D->>D: resolver — reconcile ink vs committed board
  D->>D: FSM turn protocol → rules engine returns reply move
  D-->>C: announce move — TTS + overlay on the live video
  opt still ambiguous (T3)
    D-->>C: ask the human to confirm
    H->>C: taps an answer
  end
  H->>C: draws the agent's mark — perception verifies the ink appeared
  D--)L: append session events (async)
  note over L: offline — learner folds confirmed marks into a new calibration<br/>snapshot, applied at the next session start, never mid-game
```

**Where inference runs.** The capture client runs no inference — it ships JPEGs and renders overlays. T0–T1 are CPU-only classical CV on stateless perception workers (`packages/vision/`), so per-stream cost is milliseconds, not GPU-seconds. The only online model is T2: a hosted VLM reached through OpenRouter (`packages/server/src/vlm.ts`) — speed-tier models (`google/gemini-3.1-flash-lite` with `openai/gpt-5.6-luna` as in-request cross-vendor failover), because the task is a single-cell classification crop with a strict `json_schema`, not scene understanding. Two offline model uses: rules compilation (Claude Opus 5, once per new game — see [`03-rules-ingestion.md`](03-rules-ingestion.md)) and, for games too large to solve, an LLM move proposer behind a legality validator (see the main diagram).

**The offline path.** Every session appends to the event log (`packages/server/src/feedback/store.ts`). The learner folds confirmed marks and escalation outcomes into per-(tenant, game, player) calibration snapshots; a snapshot activates only at session start and only after passing the replay-eval gate ([`05-feedback-at-scale.md`](05-feedback-at-scale.md)). Nothing learned ever changes behavior mid-game.
