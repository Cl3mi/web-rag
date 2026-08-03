# web-rag eval collector

A single, self-contained container that scores **your** RAG system on a shared
set of website questions using the same retrieval metrics as the operator's
reference system. It needs **no GPU, no model download, and no database of its
own**. You run it locally, POST each answered question to it, then export one
`report.json` and send it back. The operator runs the LLM-as-judge over both
reports and produces the side-by-side comparison.

## 1. Prerequisites
- Docker 24+ and `docker compose`
- A `read:packages` PAT for `ghcr.io` — see [`LICENSE`](./LICENSE)

## 2. Start
```bash
echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin
cp .env.example .env          # set EVAL_API_KEY and SYSTEM_LABEL
docker compose up -d
```
The collector listens on `127.0.0.1:3000`. Verify:
```bash
curl -H "Authorization: Bearer $EVAL_API_KEY" \
     http://127.0.0.1:3000/api/external/queries | jq '.queries | length'
```

## 3. Endpoints
All require `Authorization: Bearer $EVAL_API_KEY`.

### `GET /api/external/queries`
Returns the shared question set + ground-truth URLs. Ingest the same source
URLs into your system so retrieval can be compared.
```json
{ "questionSetVersion": "v1",
  "queries": [{ "id": "q1", "query": "…", "category": "…",
                "difficulty": "easy", "expectedUrls": ["https://…"] }] }
```

### `POST /api/external/run`
Call once per answered question, at answer-generation time.
```json
{
  "sessionId":     "run-2026-07-23",
  "systemLabel":   "partner-org",
  "queryId":       "q1",
  "answer":        "<your model's answer>",
  "context":       "<context your retriever passed to the LLM>",
  "retrievedUrls": ["https://…", "…"],
  "latency":       { "retrievalMs": 120, "generationMs": 800 }
}
```
The container looks up the ground-truth URLs by `queryId`, computes
Recall@5/10, MRR, nDCG, Hit@1/5/10, records latency, and returns the metrics.

### `GET /api/external/report?sessionId=…`
Downloads the full `report.json` (per-query rows + aggregate summary incl.
latency p95). Send this file back to the operator.

## 4. Minimal Python integration
```python
import os, requests
BASE = os.environ.get("EVAL_BASE", "http://127.0.0.1:3000")
KEY  = os.environ["EVAL_API_KEY"]
HDR  = {"Authorization": f"Bearer {KEY}"}
SESSION = os.environ.get("EVAL_SESSION", "run-1")
LABEL   = os.environ.get("SYSTEM_LABEL", "partner-org")

def queries():
    r = requests.get(f"{BASE}/api/external/queries", headers=HDR, timeout=30)
    r.raise_for_status(); return r.json()["queries"]

def submit(q, answer, context, retrieved_urls, retrieval_ms, generation_ms):
    r = requests.post(f"{BASE}/api/external/run", headers=HDR, json={
        "sessionId": SESSION, "systemLabel": LABEL, "queryId": q["id"],
        "answer": answer, "context": context, "retrievedUrls": retrieved_urls,
        "latency": {"retrievalMs": retrieval_ms, "generationMs": generation_ms},
    }, timeout=60)
    r.raise_for_status(); return r.json()

for q in queries():
    import time
    t0 = time.time(); hits = my_retriever(q["query"], top_k=10); t1 = time.time()
    ctx = "\n\n".join(h["text"] for h in hits)
    answer = my_generator(q["query"], ctx); t2 = time.time()
    submit(q, answer, ctx, [h["url"] for h in hits],
           int((t1-t0)*1000), int((t2-t1)*1000))
```

Fetch and send the report:
```bash
curl -H "Authorization: Bearer $EVAL_API_KEY" \
     "http://127.0.0.1:3000/api/external/report?sessionId=$EVAL_SESSION" \
     -o report.json
```

## 5. Tear-down
```bash
docker compose down -v   # stops the container AND deletes the SQLite scratch data
```
