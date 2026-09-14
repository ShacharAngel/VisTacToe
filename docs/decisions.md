# Design decisions

Every non-obvious pick, what it cost, and why it won. (Assignment: "we would rather see a defended pick than a fashionable default.")

## The loop

**The agent's move is committed by ink, not by announcement.** "The human is the only hand" means every round has *two* perception events: the human's mark, then the human drawing the agent's announced mark. The session machine has an explicit `awaiting_agent_mark` phase that verifies the right symbol landed in the right cell. If the human draws the agent's mark in the *wrong empty cell*, the agent adopts the drawn cell as its actual move and says so — ink can't be erased, and "a mark the agent has not seen drawn does not exist" cuts both ways. Wrong symbol in the announced cell, marks that mutate, or two marks by the same player: unrecoverable, and the agent asks for a fresh grid.

**Ink is truth, state is cache.** On every stable observation all 9 cells are re-read and reconciled against the committed board. This makes recovery free: the page can leave the frame mid-game, the process can restart, and the agent re-adopts any legal board it sees (it even announces a finished game if you show it one). No drift is possible because there is no incremental-only path.

**Detection is unprompted.** No button, no "done". A motion gate (raw-frame differencing) holds while a hand is in frame; ~1s of stillness triggers one full-board read. A hand crossing the paper edge breaks quad detection for a few frames — that is treated as motion, not "page lost"; only a sustained absence (~2.5s) re-prompts.

**Turn order / strength / modality.** Human is X and starts (config + one flag to flip). The opponent is memoized negamax — perfect play. Tic-tac-toe is solved; shipping a deliberately beatable bot would be an artificial dial with no honest metric behind it. The exhaustive test proves the agent never loses from any legal human line. Output is both on-screen and spoken (browser `speechSynthesis`) — the player's eyes are on the paper, not the screen.

## Perception: tiered, expensive-inference-last

- **T0 (every frame, <1ms):** raw-frame motion gate + stability window. Nothing else runs until the scene is still *and* the ink actually changed (compared with 5px spatial tolerance, so quad jitter is silent).
- **T1 (once per move, ~15–40ms):** classical features on binarized cell crops — enclosed-hole count (an O encloses a region; flood fill from the border finds it), ring deviation (O ink sits at a consistent radius), center ink and diagonal hugging (an X crosses in the middle along the diagonals). Confidence is the margin between the two shape scores; grid-line bleed is masked by a 15% cell inset plus a border-ink heuristic.
- **T2 (0–3 calls/game, optional):** a VLM via OpenRouter — **only when T1's answer contradicts the expected board at low confidence**.
- **T3:** ask the human, spoken and on-screen. Their answer is ground truth and feeds the learner.

Cost/latency targets, measured in tests: cheap path well inside a 200ms frame budget at 5fps; move acknowledged ≈1–1.5s after pen-up (stability window dominates); $0/game default, ≤$0.002/game with the VLM on.

**Why not "just use a VLM for everything"?** That's the fashionable default. It puts 1–2s and a network dependency in *every* observation, and — decisively — VLMs are weak at exactly the part this task needs: *where* things are. A Feb-2026 study ([arXiv 2602.15950](https://arxiv.org/html/2602.15950v2)) shows frontier VLMs collapse to 29–39% F1 locating non-textual marks in grids, while remaining strong at *what* a mark is. So the fallback sends **one cell crop** and asks a pure 3-way classification — the spatial question never reaches the model. That's also why speed-tier models suffice: **`google/gemini-3.1-flash-lite`** (latency-optimized, enforced JSON schema, flat 258-token image cost, ≈$0.0004/call) with **`openai/gpt-5.6-luna`** as a cross-vendor failover in the same request via OpenRouter's `models[]` array. A flagship reasoning model would cost ~200× more per call and burn seconds on hidden reasoning tokens to answer "X, O, or empty".

**No trained/fine-tuned model anywhere.** The assignment says it shouldn't be needed; it wasn't. The classical tier plus the escalation ladder handles messy handwriting by *asking* rather than guessing.

## Stack

| Pick | Why (and what was rejected) |
|---|---|
| Browser capture ↔ Node server over WebSocket | `getUserMedia` is the least-fragile camera path on any OS (rejected: native camera bindings). The split also mirrors the perception/decision boundary of the Section 3 design. |
| `@techstark/opencv-js` (wasm OpenCV 5) | Plain `npm install`, no native toolchain — the previous native `opencv4nodejs` setup needed a conda-compiled OpenCV and would have blown the "stranger in 10 minutes" budget. Wasm costs ~2–3× native CPU; at 5fps 640×480 that's irrelevant. |
| Grid detection: probabilistic Hough + orientation clustering (a mid-build pivot) | The first cut used row/column projection profiles — simpler, but they assume axis-aligned lines and broke on the tilt and waviness of a real hand-drawn grid. `HoughLinesP` finds the strokes at whatever angle they were drawn; a minimum line length (~28% of the board) keeps X/O strokes out of the line set, a 30px max gap lets one wavy stroke read as a single line, and length-weighted clustering merges its segments into grid lines. Handles borderless (2 interior lines, outer bounds extrapolated) and bordered (4-line) grids; a checked-in real-photo fixture regression-guards the path. |
| Minimax + depth-aware memoized scores | Solved game; also gives "prefers faster wins / slower losses" for better-looking play. Deterministic tie-break (center → corners → edges). |
| npm workspaces monorepo, Vitest, Fastify, Vite + vanilla TS | Zero extra orchestration tooling; every package's `exports` points at TS source so tests and dev need no build step. No frontend framework — one page, one board, a log. |
| JSON files for persistence (`data/`) | Section 2 requires state that is "inspectable by us". `events.jsonl` + `summary.json` + `calibration.json` open in any editor and diff cleanly. A database adds a dependency to inspect the same ~kilobytes. |

## Feedback loop (Section 2)

**"Smarter" = fewer human interventions at equal correctness**, on two coupled axes: (1) *accuracy* — per-player handwriting profiles: feature centroids of confirmed X's and O's boost T1 confidence for marks that match how *this* player actually draws (e.g. open O's); (2) *self-tuned escalation* — asks whose answers merely confirm the classifier lower the ask threshold (bounded at 0.45); real misreads raise it (bounded at 0.8). Boosts only ever vouch *for* a label the classifier already chose, never override it, and require ≥3 verified examples — a bad profile can make the agent ask more, never misread more.

**Improvement vs variance at small N:** the replay harness plays the *identical* deterministic frame sequence against a cold store and a warmed one; the intervention delta is attributable to learned state alone. This is a CI test, not a claim.

## Known limits & open ends (deliberate, time-boxed — each with its fix)

- CV fixtures are almost entirely synthetic (perspective, pen wobble, sensor noise, occlusion — all seeded), plus two checked-in real webcam photos: `real-grid-empty.png` regression-guards paper detection and rectification, and `real-grid-hash-empty.png` — captured from a live failure — guards classification against grid-line bleed (a wavy line's tail once read as a phantom X). With more time: a recorded real-video fixture replayed in CI.
- One session per WebSocket connection; multi-tenant concerns are design-only (Section 3).
- Latency is measured coarsely (event timestamps), not per-stage histograms.
- The wrong-*symbol*-in-announced-cell case forfeits the game rather than negotiating repair — defensible, but a "cross it into an X and I'll take the next cell" repair flow would be kinder.
- No timeout on an unanswered question: the session waits in `awaiting_answer` until an answer, a confident re-read of the cell, or a new game. The game is human-paced by design; production would re-prompt.
- One ambiguous cell escalates per observation, so N ambiguous cells resolve over N round trips. Batching the asks was cut for simplicity.
- No hard budget cap on VLM calls — the escalation ladder keeps it to 0–3 per game in practice; a per-game counter would make that a guarantee.
- Localhost trust boundary: no auth, origin checks, or rate limiting on `/ws`. This is a desk tool; isolation is Section 3's concern.
- A single feedback store serves all connections — two simultaneous clients would interleave their events into one game log and race the calibration file. Fine for a single-player tool; per-session stores is the fix.
- The per-socket message queue already serializes frame handling, so the pipeline's own drop-while-busy guard never engages; if CV ever ran slower than the frame rate, stale frames would queue instead of being dropped. Fix: drop frames at the queue head.
- Frame-decode errors reach the console log but are not persisted to `events.jsonl`.
- If the wasm OpenCV module fails to load, startup fails outright — no retry or fallback.
- Games abandoned without a `game_end` never get a `summary.json`, and pre-game prompts can open orphan single-event game directories. A retention/compaction pass would tidy `data/`.
- A board adopted mid-game (fresh process, page re-appeared) carries no move history, so its snapshot and summary under-report moves.
