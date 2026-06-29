# web-rag eval-server

A self-contained Docker bundle that scores **your** RAG system on the same
test queries and with the same LLM-as-judge methodology used by the
operator's reference system. You run it locally, point your retrieval +
generation code at it, and send back the resulting JSON report. The
operator runs the equivalent evaluation on their side and compares the two
reports.

The container only exposes four HTTP endpoints under `/api/external/*`.
There is no UI, no shell, and no access to the operator's source code,
prompts, or pipelines.

---

## 1. Prerequisites

- Docker 24+ and `docker compose`
- ~12 GB free disk (image + judge model weights)
- NVIDIA GPU recommended (CPU works but is ~10× slower for the judge step)
- A `read:packages` PAT for `ghcr.io` — see [`LICENSE`](./LICENSE)

---

## 2. Pull and start

```bash
# Authenticate against GHCR using the credentials in LICENSE
echo "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USERNAME" --password-stdin

# Configure
cp .env.example .env
# → edit .env and set EVAL_API_KEY to a long random string

# Boot (CPU)
docker compose up -d
# …or with NVIDIA GPU
docker compose --profile gpu up -d

# Wait for the judge model to download (first run only, ~5 min)
docker compose logs -f ollama
```

The eval-server listens on `127.0.0.1:3000`. Verify it is up:

```bash
curl -H "Authorization: Bearer $EVAL_API_KEY" \
     http://127.0.0.1:3000/api/external/queries | jq '.queries | length'
```

---

## 3. The four endpoints

All endpoints require `Authorization: Bearer $EVAL_API_KEY`.

### `GET /api/external/queries`
Returns the shared test query set. Every query carries the ground-truth
URLs the operator's documents resolve to. **You must ingest the same URLs
into your own system before evaluating** so retrieval can be compared.

```json
{ "queries": [
    { "id": "…", "query": "…", "category": "…", "difficulty": "easy",
      "expectedUrls": ["https://…", "https://…"] }
]}
```

### `POST /api/external/evaluate`
Computes retrieval metrics for one query from the document URLs your
retriever returned.

```json
{
  "sessionId":     "client-run-2026-06-29",
  "queryId":       "<id from /queries>",
  "query":         "<text from /queries>",
  "expectedUrls":  ["https://…"],
  "retrievedUrls": ["https://…", "https://…", "…"],
  "k":             10
}
```
Returns Recall@5/10, MRR, nDCG, Hit@1/5/10. URLs are normalised
(lowercased, trailing slash stripped) before matching, so trivial
differences are fine.

### `POST /api/external/judge`
Runs the LLM-as-judge (3× with majority vote) over your generated answer.

```json
{
  "sessionId":  "client-run-2026-06-29",
  "queryId":    "<id from /queries>",
  "query":      "<question>",
  "context":    "<context your retriever passed to the LLM>",
  "answer":     "<your model's answer>",
  "judgeRuns":  3,
  "recallAtK":  0.8
}
```
Returns groundedness, completeness, correctness, hallucination,
answerable-from-context, judgeMean, and an overall failureType
(`normal | generation_failure | retrieval_failure | robust_generation |
hallucination_failure`).

### `GET /api/external/report?sessionId=…`
Downloads the full JSON report (per-query rows + aggregate summary).
Send this file back to the operator.

---

## 4. Minimal Python integration

Add this single module to your project. It is the only client code you
have to write.

```python
# eval_client.py
import os, requests, uuid

BASE = os.environ["EVAL_BASE", "http://127.0.0.1:3000"]
KEY  = os.environ["EVAL_API_KEY"]
HDR  = {"Authorization": f"Bearer {KEY}"}
SESSION = os.environ.get("EVAL_SESSION", f"client-{uuid.uuid4().hex[:8]}")

def queries():
    r = requests.get(f"{BASE}/api/external/queries", headers=HDR, timeout=30)
    r.raise_for_status()
    return r.json()["queries"]

def submit_retrieval(q, retrieved_urls, k=10):
    r = requests.post(f"{BASE}/api/external/evaluate", headers=HDR, json={
        "sessionId": SESSION,
        "queryId": q["id"],
        "query": q["query"],
        "expectedUrls": q["expectedUrls"],
        "retrievedUrls": retrieved_urls,
        "k": k,
    }, timeout=30)
    r.raise_for_status()
    return r.json()["metrics"]

def submit_judge(q, context, answer, recall_at_k):
    r = requests.post(f"{BASE}/api/external/judge", headers=HDR, json={
        "sessionId": SESSION,
        "queryId": q["id"],
        "query": q["query"],
        "context": context,
        "answer": answer,
        "recallAtK": recall_at_k,
    }, timeout=600)
    r.raise_for_status()
    return r.json()["scores"]

def fetch_report():
    r = requests.get(f"{BASE}/api/external/report",
                     headers=HDR, params={"sessionId": SESSION}, timeout=60)
    r.raise_for_status()
    return r.json()
```

Wire it into your existing run loop — typically a 5-line patch:

```python
from eval_client import queries, submit_retrieval, submit_judge, fetch_report

for q in queries():
    hits   = my_retriever(q["query"], top_k=10)            # <— your code
    ctx    = "\n\n".join(h["text"] for h in hits)
    answer = my_generator(q["query"], ctx)                 # <— your code

    metrics = submit_retrieval(q, [h["url"] for h in hits])
    scores  = submit_judge(q, ctx, answer, recall_at_k=metrics["recallAt10"])

report = fetch_report()
open("report.json", "w").write(__import__("json").dumps(report, indent=2))
```

That is the full client-side surface — no other code in your project needs
to change.

---

## 5. Sending the report back

When the loop finishes:

```bash
curl -H "Authorization: Bearer $EVAL_API_KEY" \
     "http://127.0.0.1:3000/api/external/report?sessionId=$EVAL_SESSION" \
     -o report.json
```

Send `report.json` to the operator (email, SFTP, signed S3 URL — whatever
was agreed). The operator runs the identical evaluation against the same
queries on their reference system and produces a side-by-side comparison.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 Unauthorized` | Wrong / missing bearer token | Re-export `EVAL_API_KEY` in your shell; it must match `.env` |
| `502` from `/api/external/judge` | Judge model not yet downloaded | `docker compose logs ollama` and wait for `Ollama ready` |
| All Recall@K = 0 | URL mismatch | Confirm `expectedUrls` and your `retrievedUrls` use the same canonical form (your system must ingest the same source URLs) |
| Slow judge calls | Running CPU profile | Use `docker compose --profile gpu up` if you have NVIDIA + nvidia-container-toolkit |

---

## 7. Tear-down

```bash
docker compose down -v   # stops containers AND deletes the eval Postgres
```

This wipes all locally-stored results. Do this after sending the report.
