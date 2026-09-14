# 4 — Shared and per-tenant

```mermaid
flowchart LR
  subgraph shared [Shared — one per system]
    CODE["service code + base thresholds"]
    PROMPT["VLM prompt templates"]
    POOL["hosted model pool — vendor weights<br/>no per-tenant weights anywhere"]
    PREG[("public rules registry")]:::proposed
  end

  subgraph tenant [Per-tenant — isolated by construction]
    KEYS["API keys, quotas, endpoints"]:::proposed
    TLOG[("event logs")]
    TSPEC[("private game specs")]:::proposed
    TCAL[("calibration — keyed tenant, game, player")]:::proposed
  end

  TCAL -- "one-way valve: aggregate,<br/>human-reviewed threshold defaults only" --> CODE

  classDef proposed stroke-dasharray: 6 4
```

**Shared across all games and all users:** the code, base confidence thresholds, VLM prompt templates, the public rules registry, and the vendor pool. All model weights are vendor-hosted commodities behind OpenRouter — there is deliberately no per-tenant fine-tune anywhere, because adaptation happens in the cheap layer (calibration), not the expensive one (weights).

**Scoped to one tenant:** API keys and quotas, per-tenant WebSocket endpoints, event logs, private game specs, and *all learned state*. Calibration is keyed (tenant, game, player) by construction — handwriting profiles are personal, so the key isn't an optimization, it's the semantics. Today's single-tenant stand-ins are `data/games/` and `data/calibration.json` in `packages/server/`.

**The one-way valve:** nothing learned from one tenant ever flows into another tenant's inference path. The only graduation route is aggregate, human-reviewed threshold defaults being promoted into shared base config — a config change with review, not a data flow.
