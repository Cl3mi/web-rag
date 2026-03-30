# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
bun run dev          # Start dev server (port 5173)
bun run build        # Production build
bun run preview      # Preview production build
bun run check        # TypeScript + Svelte type checking
bun run check:watch  # Type checking in watch mode

# Database (Drizzle ORM)
bun run db:push      # Push schema to DB (no migration file)
bun run db:generate  # Generate migration files from schema changes
bun run db:studio    # Open Drizzle Studio in browser

# Infrastructure
docker compose up postgres ollama            # Start DB + Ollama (CPU)
docker compose --profile gpu up ollama-gpu   # Start Ollama with NVIDIA GPU
```

### Environment variables (`.env`)
```
DATABASE_HOST / DATABASE_PORT / DATABASE_NAME / DATABASE_USER / DATABASE_PASSWORD
OLLAMA_URL          # default: http://localhost:11434
OLLAMA_MODEL        # generation model, default: llama3.2
OLLAMA_JUDGE_MODEL  # judge model, default: qwen2.5:7b
```
Restart the dev server after changing `.env`.

## Architecture

This is a **SvelteKit** research app that compares three RAG pipeline strategies for web document retrieval. It uses **Drizzle ORM** with **PostgreSQL + pgvector** for storage, **BGE-M3** (`@xenova/transformers`) for local embeddings, and **Ollama** for LLM generation and judging.

### Three RAG Pipelines

All three pipelines ingest from the same `documents` table but store to separate tables and use different retrieval strategies:

| Pipeline | Storage table | Retrieval strategy | Embedding target |
|---|---|---|---|
| **chunk** | `traditional_chunks` | Hybrid BM25 + dense (`alpha=0.7`) | Raw text chunk |
| **fact** | `facts_chunks` | Pure dense (hybrid in evaluate) | Atomic sentence (content) |
| **llm** | `llm_chunks` | Pure dense | LLM-generated summary |

**Ingestion flow** (`shared/ingest.ts`): URL → fetch → extract (Mozilla Readability + Turndown markdown) → hash → upsert document → run all 3 pipelines in parallel (LLM pipeline skipped if Ollama unavailable).

**Reindexing** (`POST /api/reindex`): Re-processes stored `raw_html` without re-fetching. Accepts `{ pipelines: ["chunk", "fact", "llm"] }` body to reindex selectively.

### Fact Pipeline specifics (`pipeline/facts/`)

- **extractor.ts**: Uses `natural` sentence tokenizer with custom German/academic abbreviation list. Pre-processes checkmark/bullet chars and date ranges before tokenization. Extracts facts into categories (SPEC, PROC, DEF, REL, OTHER) with confidence scores. `minConfidence: 0.3` is used in ingestion — below this, facts are dropped.
- **embedder.ts**: Dense embedding uses `fact.content` (atomic sentence); sparse embedding uses `sourceContext` (±1 surrounding sentence). Do NOT swap these — using sourceContext for dense drops MRR significantly.
- **retriever.ts**: `searchFacts()` does hybrid BM25+dense search (same as chunk pipeline).

### Embeddings (`embeddings/bge-m3.ts`)

Singleton lazy-loaded `Xenova/bge-m3` model (1024d dense + BM25-style sparse). First request triggers model load; subsequent requests reuse it. `embed()` returns `{ dense, sparse, tokenCount }`.

### Evaluation system

**Two-phase evaluation:**

1. **Retrieval metrics** (`POST /api/evaluate`): Runs all 3 pipelines against `test_queries`, calculates IR metrics (Recall@K, MRR, nDCG, Hit@K), stores to `evaluation_runs` + `evaluation_results` + `rag_runs_evaluation`.

2. **LLM-as-judge** (`POST /api/judge`): Calls `qwen2.5:7b` 3× per row (majority vote), scores groundedness/completeness/correctness (1–5) + hallucination (bool) + answerableFromContext (bool). Classifies each result into one of: `normal`, `generation_failure`, `retrieval_failure`, `robust_generation`, `hallucination_failure`.

**`classifyFailureType()` priority order** (in `judge.ts`):
1. `answerableFromContext=false` + `hallucination=true` + good recall → `hallucination_failure`
2. `answerableFromContext=false` → `retrieval_failure` (regardless of recallAtK)
3. `hallucination=true` + good recall → `hallucination_failure`
4. good recall + good judge mean → `normal`
5. good recall + bad judge mean → `generation_failure`
6. bad recall + bad judge mean → `retrieval_failure`
7. bad recall + good judge mean → `robust_generation`

**`repairFailureTypes()`** fixes NULL and known-wrong classifications in `rag_judge_results` — it does NOT reclassify old `retrieval_failure` rows.

Unanswerable rows (where judge says context lacks the answer) have all scores stored as 0 to prevent inflation of averages. `NULLIF(..., 0)` in quality queries excludes these rows.

### Key configuration constants

- `EMBEDDING_DIMENSION = 1024` — BGE-M3 output size
- `VECTOR_SEARCH_DEFAULTS.hybridAlpha = 0.7` — dense weight in hybrid search
- `VECTOR_SEARCH_DEFAULTS.similarityThreshold = 0.1` — minimum score filter
- `CHUNKING_CONFIG.maxTokens = 512`, `overlap = 128`
- `JUDGE_CONTEXT_LENGTH = 8000` — must match `MAX_CONTEXT_LENGTH` in evaluate server
- `RECALL_THRESHOLD = 0.5`, `JUDGE_MEAN_THRESHOLD = 3.0` — classification thresholds

### Database schema highlights

- `documents`: source documents with `raw_html` stored for reindexing without re-fetching
- `traditional_chunks`: dense + sparse vectors; `content_markdown` used in generation
- `facts_chunks`: `content` = atomic sentence (embedded dense), `source_context` = ±1 surrounding sentence (embedded sparse); `factIndex` needed for downstream sorting
- `rag_runs_evaluation`: generation log per pipeline per query; `recall_at_k` may be NULL and is backfilled by the judge
- `rag_judge_results`: judge scores; `answerable_from_context` stored so `repairFailureTypes()` can re-classify without re-calling the LLM

### Dynamic SQL caveat

Drizzle ORM dynamic fragment interpolation in WHERE clauses returns 0 rows despite valid data. Use `sql.unsafe(query, params)` with explicit `$1`-style parameter arrays for filtered queries (see `getJudgeDetails()` in `judge.ts`).

### UI routes

| Route | Purpose |
|---|---|
| `/` | Chat interface — query with any pipeline |
| `/crawl` | Scrape URLs / import sitemaps |
| `/evaluate` | Run retrieval evaluations, view metrics |
| `/quality` | LLM judge results, failure breakdown |
| `/knowledge` | Browse ingested documents |
