# Tuning & configuration

How to change the system's behavior, what each knob trades away, and where each piece of logic lives.

## How configuration is loaded

Precedence: **built-in defaults ← optional JSON file ← environment** (`packages/server/src/config.ts`).

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` | Server port; applied only when a positive integer |
| `VISTACTOE_CONFIG` | `config.json` | Path to a JSON file with any subset of `AppConfig` (below); a missing file is the normal case |
| `VLM_ENABLED` | `false` | Exactly `true` enables the VLM tier |
| `OPENROUTER_API_KEY` | — | Absent ⇒ the VLM tier is force-disabled regardless of other settings — offline by default |
| `VISTACTOE_DATA` | `data` | Root for `games/<id>/events.jsonl`, `summary.json`, and `calibration.json` |
| `VISTACTOE_DEBUG` | — | Directory for periodic PNG dumps of the raw frame, rectified board, and ink mask |

A note on lifecycle: each WebSocket connection gets its own session with a config snapshot taken at connect time (`packages/server/src/pipeline.ts`), so config or learned-threshold changes apply from the *next* connection, not mid-game.

## Config-file knobs (`AppConfig`, defaults in `packages/shared/src/config.ts`)

| Key | Default | What it does | Raising it | Lowering it |
|---|---|---|---|---|
| `humanFirst` | `true` | Who opens each game | — | `false`: the agent announces its first move as soon as the grid locks |
| `humanSymbol` | `"X"` | The human's mark; the agent takes the other | — | — |
| `confidence.ask` | `0.6` | **The master escalation threshold** (see below) | More questions, fewer misreads | Quieter agent, more risk of committing a wrong read |
| `stability.stillFrames` | `5` | Consecutive still frames (at 5 fps) before the board is read | Slower move acknowledgement (+200 ms each), fewer mid-draw reads | Snappier, but may read a half-drawn mark |
| `stability.motionThreshold` | `0.02` | Fraction of changed pixels that counts as motion | Tolerates camera shake, may read past a moving hand | Hypersensitive — sensor noise can keep it from ever settling |
| `vlm.enabled` | `false` | Whether the VLM tier runs at all | — | — |
| `vlm.models` | `gemini-3.1-flash-lite`, `gpt-5.6-luna` | OpenRouter `models[]` routing array — the order **is** the failover order, cross-vendor, in a single request | — | — |
| `vlm.timeoutMs` | `4000` | Abort deadline per VLM call | The human waits longer before getting the question | More timeouts → more questions reach the human |

### One knob, three gates

`confidence.ask` deliberately governs the whole ask/guess frontier — one number moves all three decisions in lockstep:

1. **Escalate** — a cell reading that contradicts the committed board below this confidence escalates instead of resolving (`packages/server/src/session/resolver.ts`).
2. **Accept the VLM's verdict** — a VLM answer below it is discarded and the question goes to the human (`packages/server/src/pipeline.ts`).
3. **Self-resolve** — while a question is pending, a fresh reading of the same cell at or above it answers the question without the human (`packages/server/src/session/machine.ts`).

It is also the value the feedback loop tunes: confirmed asks lower it (bounded at 0.45), real misreads raise it (bounded at 0.8), one 0.05 step per game (`packages/server/src/feedback/calibration.ts`).

## Code-level constants

These are deliberately *not* config: they are coupled to the CV pipeline's geometry and were tuned against the synthetic + real-photo test corpus. Change them in code, and the tests around them say whether the change holds.

### Temporal gates — `packages/vision/src/watch.ts`

| Constant | Value | Meaning |
|---|---|---|
| `pageLostFrames` | `12` (~2.4 s) | Grid-less frames before announcing a lost page (a hand crossing the edge stays "motion") |
| `pageChangeFrames` | `12` | Debounce before switching between "show me the paper" and "draw a grid" prompts |
| `changedInkPixels` | `250` | Ink-mask pixel delta required to re-report a board (a real pen mark is >1000; jitter is low hundreds) |
| `inkTolerancePx` | `5` | Spatial tolerance in the ink diff, so a few pixels of quad jitter stay silent |
| `agreeFrames` | `2` | Consecutive identical classifications required before a board is reported — a one-frame misread (shadow, hand blur) can never commit. Starts classifying early, so the happy path reports on the same frame as a single read |
| `PIXEL_DELTA` | `28` | Gray-level delta at which a pixel counts as changed in the motion gate |

### Paper & grid detection — `packages/vision/src/acquire.ts`

| Constant | Value | Meaning |
|---|---|---|
| `MIN_PAPER_AREA` | `0.12` | Minimum fraction of the frame a paper candidate must cover |
| `MIN_PAPER_CONTRAST` | `25` | Gray levels the sheet's interior must exceed its surround (rejects gradients posing as paper) |
| `RECT_SIZE` (`types.ts`) | `600` | Side of the rectified canonical board; every downstream pixel constant is relative to it |
| Adaptive threshold | block `35`, C `12` | Ink binarization; larger block tolerates shading but misses thin strokes, higher C erases faint ink |
| Hough | threshold `45`, minLen `0.28·h`, gap `30` | minLen keeps X/O strokes out of the line set; gap lets one wavy stroke read as a single line |
| `ORIENTATION_TOLERANCE` | `28°` | How tilted a stroke may be and still count as a grid line (X diagonals sit at ~45°) |
| Cluster merge / weight | `0.08·dim` / `≥0.3·dim` | Merge wavy segments into one line; discard weak clusters |

### Cell classification — `packages/vision/src/classify.ts`

| Constant | Value | Meaning |
|---|---|---|
| `CELL_INSET` | `0.15` | Fraction trimmed per side so grid-line ink stays out of the crop |
| `EMPTY_INK_FRACTION` | `0.01` | Below this, the cell is empty |
| Border-bleed rule | `>0.85` border ink & `<0.05` total | Residual grid-line ink reads as empty (confidence 0.7) |
| Spanning-ink strip | span `>1.6` cells; strip if `<0.05` of crop or `>0.6` border-hugging | Ink connected to a board-spanning component (a wavy grid line's tail curving into a cell) is erased before classification — unless it crosses the crop's center like a mark merged into a line, which is left for escalation. Guards against phantom marks (see `real-grid-hash-empty.png` fixture) |
| Shape score weights | `0.45 / 0.30 / 0.25` | O: enclosed hole / ring consistency / hollow center; X: diagonal hugging / center ink / no hole |
| Confidence | `0.5 + margin·0.9`, cap `0.99` | Margin between the two shape scores; faint marks (<0.025 ink) scaled ×0.8 |

### Web client — `packages/web/src/main.ts`

| Constant | Value | Meaning |
|---|---|---|
| `GEOMETRY_TTL_MS` | `1500` | How long the on-video move marker survives without fresh geometry (bridges hand occlusions; hides when the paper leaves) |
| Placement guide | 65% of frame, centered | Dashed rectangle shown while no paper is detected — comfortably above the 12% minimum paper area |
| localStorage keys | `vistactoe.clearLogOnNewGame`, `vistactoe.rotateView` | Persisted UI toggles (clear-log defaults on, rotate defaults off) |

### VLM tier — `packages/server/src/vlm.ts`, `pipeline.ts`

| Constant | Value | Meaning |
|---|---|---|
| Crop inset | `0.04` | Looser than T1's 0.15 — a little context, never a spatial question |
| `temperature` | `0` | Deterministic classification |
| `max_tokens` | `200` | The schema'd answer needs no more |
| `require_parameters` | `true` | Only route to endpoints that actually enforce the JSON schema |

### Feedback & calibration — `packages/server/src/feedback/calibration.ts`

| Constant | Value | Meaning |
|---|---|---|
| `MIN_EXAMPLES` | `3` | Verified marks needed before a handwriting profile boosts anything |
| `FEATURE_SCALE` | holes `1`, ring `0.25`, center `0.25`, diag `0.2` | Normalizes the profile distance metric |
| Distance cutoff | `1` | Beyond this normalized distance, no boost |
| Boost target | `0.97` | Ceiling a boosted confidence approaches — always below an answered question's `1.0` |
| `ASK_FLOOR` / `ASK_CEIL` / `ASK_STEP` | `0.45` / `0.8` / `0.05` | Bounds and step of the self-tuned ask threshold |

Boosts only ever *raise* confidence toward a label the classifier already chose, never touch `empty`, and require verified examples — a bad profile can cost extra questions, never silent misreads.

### Decision engine — `packages/engine/src/minimax.ts`

| Constant | Value | Meaning |
|---|---|---|
| `PREFERENCE` | `[4, 0, 2, 6, 8, 1, 3, 5, 7]` | Move ordering and the deterministic tie-break: center → corners → edges |
| Win score / decay | `10`, `±1` per ply | Prefers faster wins and slower losses |

## Where things live

| Logic | File |
|---|---|
| Board rules, win/draw, reachability check (`isConsistent`) | `packages/engine/src/board.ts` |
| Perfect-play negamax + memo | `packages/engine/src/minimax.ts` |
| WebSocket protocol (3 client + 4 server message types) | `packages/shared/src/protocol.ts` |
| Session phases, effects, snapshot types | `packages/shared/src/session.ts` |
| Config schema + defaults | `packages/shared/src/config.ts` |
| Paper detection, rectification, grid detection, ink mask | `packages/vision/src/acquire.ts` |
| Homography math, cell → frame-pixel projection for overlays | `packages/vision/src/homography.ts` |
| Motion / stability / ink-change gates (T0) | `packages/vision/src/watch.ts` |
| X/O/empty classifier + confidence (T1) | `packages/vision/src/classify.ts` |
| Synthetic scene renderer (all test fixtures) | `packages/vision/src/synthetic.ts` |
| Env + config-file loading | `packages/server/src/config.ts` |
| HTTP/WS wiring, one session per socket | `packages/server/src/app.ts` |
| Frame → observation → effects orchestration, VLM escalation | `packages/server/src/pipeline.ts` |
| Session state machine (turns, asks, adoption, corruption) | `packages/server/src/session/machine.ts` |
| Ink-vs-committed-board reconciliation | `packages/server/src/session/resolver.ts` |
| OpenRouter client (schema-enforced, failover, degrade-to-null) | `packages/server/src/vlm.ts` |
| Event log, summaries, learning extraction | `packages/server/src/feedback/store.ts` |
| Handwriting profiles + threshold self-tuning | `packages/server/src/feedback/calibration.ts` |
| Trend report CLI (`npm run feedback:report`) | `packages/server/src/feedback/report.ts` |
| Camera capture, board UI, video overlay (paper guide + move marker), view/log controls, ask buttons, speech | `packages/web/src/main.ts` |
| Full-loop e2e with a synthetic camera | `e2e/test/game.e2e.test.ts` |

## Raising the read-success rate, in order of cost

1. **Physics first**: more light, a thicker darker pen, the page filling the frame. Most "misreads" are faint-ink problems the classifier correctly reports as low confidence.
2. **Warm up the profile**: play a game or two answering the questions truthfully — after 3 verified examples per symbol, marks that look like *yours* get boosted and the questions stop.
3. **Let the threshold tune itself** (or set `confidence.ask` lower in `config.json` once your profile is warm).
4. **Enable the VLM tier** — it absorbs most remaining ambiguity for ≈$0.0004 a call before any question reaches you.
