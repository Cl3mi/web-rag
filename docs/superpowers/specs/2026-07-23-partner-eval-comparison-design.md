# Partner-Comparable RAG Evaluation — Design

**Date:** 2026-07-23
**Status:** Approved

## Problem

We want to compare our RAG implementation against a partner organisation's RAG
on the *same* website questions with the *same* metrics and the *same* judge, so
the two systems can be scored side-by-side. The partner must be able to drop a
container into their application with minimal effort — no GPU, no model weights,
no database of their own.

## Solution overview

Split the work into two artifacts:

1. **Collector container** (`eval-dist/`) — shipped to the partner *and* run by
   us. It is judge-free, Postgres-free, Ollama-free: a single container. At
   answer-generation time the host application POSTs
   `query + response + used-context + retrievedUrls + latency` to it. The
   container computes **retrieval metrics** against a bundled ground-truth
   question set and records **latency**, then exports one **`report.json`**.

2. **Compare view** — a new route in our existing `web-rag` app. We upload the
   two `report.json` files (ours + theirs), it runs our existing LLM-judge over
   every row of both, and renders a side-by-side comparison using the same
   failure taxonomy and averaging methodology as `/quality`.

```
partner app ──POST /run──▶ collector (SQLite scratch) ──GET /report──▶ report-partner.json
our app     ──POST /run──▶ collector (SQLite scratch) ──GET /report──▶ report-mine.json
                                                                              │
                       web-rag  /compare  ◀──── upload both JSONs ────────────┘
                       (judges each row, renders side-by-side)
```

Both parties run the **identical** collector, so their reports are structurally
identical. Judging happens only on our machine, afterward.

## Collector container

- **Runtime:** SvelteKit `adapter-node` bundle on `node:20-slim`.
  `EVAL_SERVER_MODE=1` gates the server to `/api/external/*` (existing
  mechanism in `src/hooks.server.ts`).
- **Storage:** embedded SQLite file (`better-sqlite3`) on a mounted volume.
  Internal scratch only — never transmitted. The synchronous API serialises
  concurrent writes. Imported only behind `EVAL_SERVER_MODE`.
- **Ground truth:** `eval-dist/seed/questions.json` bundled into the image and
  loaded at startup. Travels with the directory, so both machines are identical.
  The host app cannot alter what "correct retrieval" means.

### Endpoints (bearer-auth via `EVAL_API_KEY`, unchanged auth module)

| Endpoint | Purpose |
|---|---|
| `GET /api/external/queries` | Shared set: `{id, query, category, difficulty, expectedUrls}` |
| `POST /api/external/run` | Body `{sessionId, systemLabel, queryId, answer, context, retrievedUrls, latency:{retrievalMs, generationMs}}`. Looks up `expectedUrls` by `queryId`, computes retrieval metrics, records row, returns the metrics. **Replaces** the old `/evaluate` + `/judge`. |
| `GET /api/external/report?sessionId=…` | Emits `report.json` (rows + summary). No judge fields. |

Retrieval metric functions are reused verbatim from
`src/lib/server/evaluation/metrics.ts` → identical math on both machines.

### `report.json` schema

```jsonc
{
  "systemLabel": "partner-org",
  "sessionId": "run-2026-07-23",
  "questionSetVersion": "v1",
  "generatedAt": "2026-07-23T10:00:00.000Z",
  "rows": [{
    "queryId": "q1",
    "query": "…",
    "answer": "…",
    "context": "…",
    "expectedUrls": ["https://…"],
    "retrievedUrls": ["https://…", "…"],
    "retrieval": { "recallAt5": 1, "recallAt10": 1, "mrr": 1, "ndcg": 1,
                   "hitAt1": 1, "hitAt5": 1, "hitAt10": 1 },
    "latency": { "retrievalMs": 120, "generationMs": 800, "totalMs": 920 }
  }],
  "summary": {
    "total": 20,
    "retrieval": { "recallAt5": …, "recallAt10": …, "mrr": …, "ndcg": …,
                   "hitAt1": …, "hitAt5": …, "hitAt10": … },
    "latency": { "retrievalMs": {mean,median,p95,p99,min,max},
                 "generationMs": {…}, "totalMs": {…} }
  }
}
```

No judge fields — groundedness/completeness/correctness/failureType are added by
the compare step.

## Compare view (in `web-rag`)

- Route `/compare` + `POST /api/compare` accepting two uploaded report JSONs.
- For each row of each report: `judgeAnswer(query, context, answer, runs=3)` +
  `classifyFailureType(row.retrieval.recallAt10, judgeMean, hallucination,
  answerableFromContext)` — the same judge, model, and failure taxonomy as
  `/quality`.
- Unanswerable rows (judge says context lacks the answer) have their judge
  scores zeroed and excluded from quality averages via the same `NULLIF`-style
  exclusion used internally, so averages match our methodology.
- Judged comparison persisted in Postgres (`comparison_runs`, one row holding
  the assembled comparison JSON keyed by uuid) so re-viewing does not re-judge.
- UI renders side-by-side: retrieval metrics, judge scores, **failure-type
  histogram per system**, latency (retrieval/generation/total, mean + p95), and
  a per-question drill-down.
- **Version guard:** differing `questionSetVersion` between the two reports
  produces a warning rather than a silent comparison.

## Changes to existing `eval-dist`

- Remove Ollama service + judge-model download and Postgres service from
  `docker-compose.yml` — single `eval-server` service.
- Delete `src/routes/api/external/judge/` and `src/routes/api/external/evaluate/`
  from the collector build (replaced by `/run`).
- Replace Postgres `storage.ts` with a SQLite collector store.
- Replace `seed/queries.sql` with `seed/questions.json` + an export script.
- Judge code stays in the main app only.
- Rewrite README for the single-container flow.

## Out of scope

- Automatic transmission of reports between parties (email/SFTP as agreed).
- Generation itself — each party uses their own retriever + LLM; we only score.
