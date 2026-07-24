# Partner-Comparable RAG Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `eval-dist/` into a single, judge-free collector container that both us and a partner run to produce identical `report.json` files, and add a `/compare` feature to the main app that judges and scores the two reports side-by-side.

**Architecture:** The collector reuses the existing pure IR-metric functions in `metrics.ts`, stores rows in a `better-sqlite3` file behind `EVAL_SERVER_MODE`, bundles the ground-truth question set as `seed/questions.json`, and exports a self-contained JSON report. The main app gains a `/compare` route that runs the existing `judgeAnswer` + `classifyFailureType` over both reports, persists the judged comparison in Postgres, and renders it.

**Tech Stack:** SvelteKit (Svelte 5 runes), TypeScript, `adapter-node`, `better-sqlite3`, PostgreSQL (`postgres` client), Ollama judge (`qwen2.5:7b`), Docker Compose, Vitest (new, for pure-logic tests).

**Reference spec:** `docs/superpowers/specs/2026-07-23-partner-eval-comparison-design.md`

---

## File Structure

**New — collector (loaded only in `EVAL_SERVER_MODE`):**
- `src/lib/server/collector/questions.ts` — loads/serves the bundled question set + ground-truth lookup
- `src/lib/server/collector/scoring.ts` — pure: build one row's retrieval metrics + summarise a report
- `src/lib/server/collector/store.ts` — `better-sqlite3` store (insert/list rows, list sessions)
- `src/routes/api/external/run/+server.ts` — the single collect endpoint

**New — compare (main app):**
- `src/lib/server/compare/aggregate.ts` — pure: aggregate judged rows into per-system summary + failure histogram
- `src/lib/server/compare/judge-report.ts` — runs the LLM-judge over a report's rows
- `src/lib/server/compare/store.ts` — Postgres persistence of judged comparisons
- `src/routes/api/compare/+server.ts` — POST: judge two reports, persist, return
- `src/routes/api/compare/[id]/+server.ts` — GET a stored comparison
- `src/routes/compare/+page.svelte` — upload + side-by-side UI
- `src/routes/compare/+page.server.ts` — list existing comparisons

**New — packaging / data:**
- `eval-dist/seed/questions.json` — the shared ground-truth set
- `eval-dist/scripts/export-questions.ts` — regenerate `questions.json` from `test_queries`

**Modified:**
- `src/hooks.server.ts` — gate startup by mode (SQLite collector init vs Postgres init)
- `src/routes/api/external/queries/+server.ts` — read from `questions.ts`, not Postgres
- `src/routes/api/external/report/+server.ts` — assemble report from SQLite store + `scoring.ts`
- `src/lib/server/evaluation/metrics.ts` — export a helper reused by both sides (only if needed; see Task 3)
- `eval-dist/Dockerfile` — copy `seed/questions.json`, ensure `better-sqlite3` binary present
- `eval-dist/docker-compose.yml` — single service, SQLite volume, no Postgres/Ollama
- `eval-dist/.env.example`, `eval-dist/README.md`
- `package.json` — add `better-sqlite3`, `vitest`, `test` script

**Deleted:**
- `src/routes/api/external/evaluate/+server.ts`
- `src/routes/api/external/judge/+server.ts`
- `src/lib/server/external/storage.ts` (Postgres external store; replaced by `collector/store.ts`)
- `src/lib/server/external/auth.ts` → **kept** (reused by collector routes)
- `eval-dist/seed/queries.sql`
- `eval-dist/scripts/ollama-entrypoint.sh`
- `eval-dist/scripts/export-queries.ts` (replaced by `export-questions.ts`)

---

## Phase 0 — Test harness

### Task 0: Add Vitest

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [x] **Step 1: Add dev deps and a test script**

Run:
```bash
cd /home/dev/workspace
bun add -d vitest@^2.1.0
bun add better-sqlite3@^11.8.0
bun add -d @types/better-sqlite3@^7.6.11
```

- [x] **Step 2: Add the `test` script to `package.json`**

In `package.json` `"scripts"`, add:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [x] **Step 3: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      $lib: new URL('./src/lib', import.meta.url).pathname,
    },
  },
});
```

- [x] **Step 4: Verify the runner works with no tests yet**

Run: `bun run test`
Expected: exits 0 with "No test files found" (or similar). If it errors on config, fix before continuing.

- [x] **Step 5: Commit**

```bash
git add package.json bun.lock vitest.config.ts
git commit -m "chore: add vitest and better-sqlite3 for eval collector"
```

---

## Phase 1 — Collector pure logic

### Task 1: Report scoring (`scoring.ts`)

Pure functions: normalise URLs, compute one row's retrieval metrics, and
summarise a set of rows. Reuses `metrics.ts`.

**Files:**
- Create: `src/lib/server/collector/scoring.ts`
- Test: `src/lib/server/collector/scoring.test.ts`

- [x] **Step 1: Write the failing test**

```typescript
// src/lib/server/collector/scoring.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeUrl, scoreRow, summarizeRows, type CollectorRow } from './scoring';

describe('normalizeUrl', () => {
  it('lowercases and strips trailing slashes', () => {
    expect(normalizeUrl('HTTPS://Example.com/Page/')).toBe('https://example.com/page');
    expect(normalizeUrl('  https://x.com  ')).toBe('https://x.com');
  });
});

describe('scoreRow', () => {
  it('computes retrieval metrics with normalized URL matching', () => {
    const m = scoreRow(
      ['https://A.com/', 'https://b.com'], // retrieved
      ['https://a.com'],                    // expected
    );
    expect(m.recallAt5).toBe(1);
    expect(m.recallAt10).toBe(1);
    expect(m.mrr).toBe(1);       // relevant at rank 1
    expect(m.hitAt1).toBe(1);
  });

  it('reports zero when nothing relevant retrieved', () => {
    const m = scoreRow(['https://x.com'], ['https://a.com']);
    expect(m.recallAt5).toBe(0);
    expect(m.mrr).toBe(0);
    expect(m.hitAt1).toBe(0);
  });
});

describe('summarizeRows', () => {
  it('averages retrieval metrics and computes latency stats', () => {
    const rows: CollectorRow[] = [
      {
        queryId: 'q1', query: 'a', answer: '', context: '',
        expectedUrls: ['https://a.com'], retrievedUrls: ['https://a.com'],
        retrieval: { recallAt5: 1, recallAt10: 1, mrr: 1, ndcg: 1, hitAt1: 1, hitAt5: 1, hitAt10: 1 },
        latency: { retrievalMs: 100, generationMs: 200, totalMs: 300 },
      },
      {
        queryId: 'q2', query: 'b', answer: '', context: '',
        expectedUrls: ['https://b.com'], retrievedUrls: ['https://x.com'],
        retrieval: { recallAt5: 0, recallAt10: 0, mrr: 0, ndcg: 0, hitAt1: 0, hitAt5: 0, hitAt10: 0 },
        latency: { retrievalMs: 300, generationMs: 400, totalMs: 700 },
      },
    ];
    const s = summarizeRows(rows);
    expect(s.total).toBe(2);
    expect(s.retrieval.recallAt5).toBe(0.5);
    expect(s.latency.totalMs.mean).toBe(500);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/server/collector/scoring.test.ts`
Expected: FAIL — cannot find module `./scoring`.

- [x] **Step 3: Write the implementation**

```typescript
// src/lib/server/collector/scoring.ts
import {
  calculateRecallAtK,
  calculateMRR,
  calculateNDCGBinary,
  calculateHitAtK,
  calculateLatencyStats,
} from '$lib/server/evaluation/metrics';

export interface RetrievalMetrics {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
}

export interface LatencyBreakdown {
  retrievalMs: number;
  generationMs: number;
  totalMs: number;
}

export interface CollectorRow {
  queryId: string;
  query: string;
  answer: string;
  context: string;
  expectedUrls: string[];
  retrievedUrls: string[];
  retrieval: RetrievalMetrics;
  latency: LatencyBreakdown;
}

export function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase();
}

/** Compute retrieval metrics for one query. URLs normalised before matching. */
export function scoreRow(retrievedUrls: string[], expectedUrls: string[], k = 10): RetrievalMetrics {
  const retrieved = retrievedUrls.map(normalizeUrl);
  const expected = expectedUrls.map(normalizeUrl);
  return {
    recallAt5: calculateRecallAtK(retrieved, expected, 5),
    recallAt10: calculateRecallAtK(retrieved, expected, 10),
    mrr: calculateMRR(retrieved, expected),
    ndcg: calculateNDCGBinary(retrieved, expected, k),
    hitAt1: calculateHitAtK(retrieved, expected, 1),
    hitAt5: calculateHitAtK(retrieved, expected, 5),
    hitAt10: calculateHitAtK(retrieved, expected, 10),
  };
}

type LatencyStats = ReturnType<typeof calculateLatencyStats>;

export interface ReportSummary {
  total: number;
  retrieval: RetrievalMetrics;
  latency: { retrievalMs: LatencyStats; generationMs: LatencyStats; totalMs: LatencyStats };
}

function mean(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

export function summarizeRows(rows: CollectorRow[]): ReportSummary {
  const keys: (keyof RetrievalMetrics)[] = [
    'recallAt5', 'recallAt10', 'mrr', 'ndcg', 'hitAt1', 'hitAt5', 'hitAt10',
  ];
  const retrieval = {} as RetrievalMetrics;
  for (const key of keys) retrieval[key] = mean(rows.map((r) => r.retrieval[key]));
  return {
    total: rows.length,
    retrieval,
    latency: {
      retrievalMs: calculateLatencyStats(rows.map((r) => r.latency.retrievalMs)),
      generationMs: calculateLatencyStats(rows.map((r) => r.latency.generationMs)),
      totalMs: calculateLatencyStats(rows.map((r) => r.latency.totalMs)),
    },
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/server/collector/scoring.test.ts`
Expected: PASS (3 files/describe blocks green).

- [x] **Step 5: Commit**

```bash
git add src/lib/server/collector/scoring.ts src/lib/server/collector/scoring.test.ts
git commit -m "feat(collector): pure report scoring and summary"
```

---

### Task 2: Question set loader (`questions.ts`)

Loads `questions.json` and answers `getQueries()` / `getExpectedUrls(queryId)` /
`getQuestionSetVersion()`.

**Files:**
- Create: `src/lib/server/collector/questions.ts`
- Test: `src/lib/server/collector/questions.test.ts`
- Create (fixture used by both test and runtime default): `eval-dist/seed/questions.json`

- [x] **Step 1: Create the seed fixture `eval-dist/seed/questions.json`**

```json
{
  "version": "v1",
  "queries": [
    {
      "id": "q1",
      "query": "What are the tuition fees for the master's program?",
      "category": "pricing",
      "difficulty": "easy",
      "expectedUrls": ["https://www.mci.edu/en/study/master"]
    },
    {
      "id": "q2",
      "query": "When is the application deadline?",
      "category": "dates",
      "difficulty": "medium",
      "expectedUrls": ["https://www.mci.edu/en/application"]
    }
  ]
}
```

- [x] **Step 2: Write the failing test**

```typescript
// src/lib/server/collector/questions.test.ts
import { describe, it, expect } from 'vitest';
import { QuestionSet } from './questions';

const FIXTURE = {
  version: 'v1',
  queries: [
    { id: 'q1', query: 'a', category: 'c', difficulty: 'easy', expectedUrls: ['https://a.com'] },
    { id: 'q2', query: 'b', category: null, difficulty: null, expectedUrls: [] },
  ],
};

describe('QuestionSet', () => {
  it('exposes the version and public query list (no leaking internals)', () => {
    const qs = QuestionSet.fromObject(FIXTURE);
    expect(qs.version).toBe('v1');
    expect(qs.list()).toEqual([
      { id: 'q1', query: 'a', category: 'c', difficulty: 'easy', expectedUrls: ['https://a.com'] },
      { id: 'q2', query: 'b', category: null, difficulty: null, expectedUrls: [] },
    ]);
  });

  it('resolves expected URLs by id and throws on unknown id', () => {
    const qs = QuestionSet.fromObject(FIXTURE);
    expect(qs.expectedUrls('q1')).toEqual(['https://a.com']);
    expect(() => qs.expectedUrls('nope')).toThrow(/unknown queryId/i);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `bun run test src/lib/server/collector/questions.test.ts`
Expected: FAIL — cannot find module `./questions`.

- [x] **Step 4: Write the implementation**

```typescript
// src/lib/server/collector/questions.ts
import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';

export interface PublicQuery {
  id: string;
  query: string;
  category: string | null;
  difficulty: string | null;
  expectedUrls: string[];
}

interface QuestionSetFile {
  version: string;
  queries: PublicQuery[];
}

export class QuestionSet {
  private constructor(
    public readonly version: string,
    private readonly queries: PublicQuery[],
  ) {}

  static fromObject(obj: QuestionSetFile): QuestionSet {
    if (!obj || typeof obj.version !== 'string' || !Array.isArray(obj.queries)) {
      throw new Error('Invalid question set: expected { version, queries[] }');
    }
    const queries = obj.queries.map((q) => ({
      id: q.id,
      query: q.query,
      category: q.category ?? null,
      difficulty: q.difficulty ?? null,
      expectedUrls: q.expectedUrls ?? [],
    }));
    return new QuestionSet(obj.version, queries);
  }

  static fromFile(path: string): QuestionSet {
    return QuestionSet.fromObject(JSON.parse(readFileSync(path, 'utf8')));
  }

  list(): PublicQuery[] {
    return this.queries.map((q) => ({ ...q, expectedUrls: [...q.expectedUrls] }));
  }

  expectedUrls(queryId: string): string[] {
    const q = this.queries.find((x) => x.id === queryId);
    if (!q) throw new Error(`unknown queryId: ${queryId}`);
    return [...q.expectedUrls];
  }
}

let cached: QuestionSet | null = null;

/** Runtime singleton, loaded from QUESTIONS_PATH (default: bundled seed). */
export function getQuestionSet(): QuestionSet {
  if (cached) return cached;
  const path = env.QUESTIONS_PATH || '/app/seed/questions.json';
  cached = QuestionSet.fromFile(path);
  return cached;
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `bun run test src/lib/server/collector/questions.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/lib/server/collector/questions.ts src/lib/server/collector/questions.test.ts eval-dist/seed/questions.json
git commit -m "feat(collector): bundled question set loader"
```

---

### Task 3: SQLite collector store (`store.ts`)

**Files:**
- Create: `src/lib/server/collector/store.ts`
- Test: `src/lib/server/collector/store.test.ts`

- [x] **Step 1: Write the failing test (uses a temp DB file)**

```typescript
// src/lib/server/collector/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorStore } from './store';
import type { CollectorRow } from './scoring';

let dir: string;
let store: CollectorStore;

const row = (queryId: string): CollectorRow => ({
  queryId, query: 'q', answer: 'a', context: 'c',
  expectedUrls: ['https://a.com'], retrievedUrls: ['https://a.com'],
  retrieval: { recallAt5: 1, recallAt10: 1, mrr: 1, ndcg: 1, hitAt1: 1, hitAt5: 1, hitAt10: 1 },
  latency: { retrievalMs: 10, generationMs: 20, totalMs: 30 },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'collector-'));
  store = new CollectorStore(join(dir, 'test.db'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CollectorStore', () => {
  it('inserts rows and reads them back by session', () => {
    store.insert('s1', 'my-system', row('q1'));
    store.insert('s1', 'my-system', row('q2'));
    store.insert('s2', 'my-system', row('q1'));
    const s1 = store.rowsForSession('s1');
    expect(s1.map((r) => r.queryId)).toEqual(['q1', 'q2']);
    expect(store.rowsForSession('s2')).toHaveLength(1);
  });

  it('records systemLabel per session', () => {
    store.insert('s1', 'partner-org', row('q1'));
    expect(store.systemLabel('s1')).toBe('partner-org');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun run test src/lib/server/collector/store.test.ts`
Expected: FAIL — cannot find module `./store`.

- [x] **Step 3: Write the implementation**

```typescript
// src/lib/server/collector/store.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CollectorRow } from './scoring';

export class CollectorStore {
  private db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id   TEXT NOT NULL,
        system_label TEXT NOT NULL,
        query_id     TEXT NOT NULL,
        row_json     TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id);
    `);
  }

  insert(sessionId: string, systemLabel: string, row: CollectorRow): void {
    this.db
      .prepare('INSERT INTO runs (session_id, system_label, query_id, row_json) VALUES (?, ?, ?, ?)')
      .run(sessionId, systemLabel, row.queryId, JSON.stringify(row));
  }

  rowsForSession(sessionId: string): CollectorRow[] {
    const rows = this.db
      .prepare('SELECT row_json FROM runs WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as { row_json: string }[];
    return rows.map((r) => JSON.parse(r.row_json) as CollectorRow);
  }

  systemLabel(sessionId: string): string | null {
    const r = this.db
      .prepare('SELECT system_label FROM runs WHERE session_id = ? ORDER BY id ASC LIMIT 1')
      .get(sessionId) as { system_label: string } | undefined;
    return r?.system_label ?? null;
  }

  sessions(): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT session_id FROM runs ORDER BY session_id ASC')
      .all() as { session_id: string }[];
    return rows.map((r) => r.session_id);
  }
}

let cached: CollectorStore | null = null;

export function getCollectorStore(dbPath: string): CollectorStore {
  if (!cached) cached = new CollectorStore(dbPath);
  return cached;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `bun run test src/lib/server/collector/store.test.ts`
Expected: PASS. (If `better-sqlite3` fails to load its native binary, run `bun pm trust better-sqlite3` then re-run.)

- [x] **Step 5: Commit**

```bash
git add src/lib/server/collector/store.ts src/lib/server/collector/store.test.ts
git commit -m "feat(collector): sqlite store for collected runs"
```

---

## Phase 2 — Collector endpoints

### Task 4: Rework `GET /api/external/queries` to read the bundled set

**Files:**
- Modify (replace whole file): `src/routes/api/external/queries/+server.ts`

- [x] **Step 1: Replace the file**

```typescript
// src/routes/api/external/queries/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { getQuestionSet } from '$lib/server/collector/questions';

export const GET: RequestHandler = async ({ request }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const qs = getQuestionSet();
  return json({ questionSetVersion: qs.version, queries: qs.list() });
};
```

- [x] **Step 2: Type-check**

Run: `bun run check`
Expected: no errors introduced by this file.

- [x] **Step 3: Commit**

```bash
git add src/routes/api/external/queries/+server.ts
git commit -m "feat(collector): serve bundled question set from /queries"
```

---

### Task 5: Create `POST /api/external/run`

**Files:**
- Create: `src/routes/api/external/run/+server.ts`

- [x] **Step 1: Write the handler**

```typescript
// src/routes/api/external/run/+server.ts
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { getQuestionSet } from '$lib/server/collector/questions';
import { getCollectorStore } from '$lib/server/collector/store';
import { scoreRow, type CollectorRow } from '$lib/server/collector/scoring';

interface Body {
  sessionId?: string;
  systemLabel?: string;
  queryId: string;
  answer: string;
  context: string;
  retrievedUrls: string[];
  latency?: { retrievalMs?: number; generationMs?: number; totalMs?: number };
}

const DB_PATH = env.COLLECTOR_DB_PATH || '/app/data/collector.db';

export const POST: RequestHandler = async ({ request }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const body = (await request.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.queryId !== 'string' ||
    typeof body.answer !== 'string' ||
    typeof body.context !== 'string' ||
    !Array.isArray(body.retrievedUrls)
  ) {
    return json(
      { error: 'Required: { queryId, answer, context, retrievedUrls[] } (+ optional latency)' },
      { status: 400 },
    );
  }

  let expectedUrls: string[];
  try {
    expectedUrls = getQuestionSet().expectedUrls(body.queryId);
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }

  const query = getQuestionSet().list().find((q) => q.id === body.queryId)?.query ?? '';
  const retrieval = scoreRow(body.retrievedUrls, expectedUrls);
  const retrievalMs = body.latency?.retrievalMs ?? 0;
  const generationMs = body.latency?.generationMs ?? 0;
  const totalMs = body.latency?.totalMs ?? retrievalMs + generationMs;

  const row: CollectorRow = {
    queryId: body.queryId,
    query,
    answer: body.answer,
    context: body.context,
    expectedUrls,
    retrievedUrls: body.retrievedUrls,
    retrieval,
    latency: { retrievalMs, generationMs, totalMs },
  };

  const sessionId = body.sessionId ?? 'default';
  const systemLabel = body.systemLabel ?? 'unknown';
  getCollectorStore(DB_PATH).insert(sessionId, systemLabel, row);

  return json({ queryId: row.queryId, retrieval, latency: row.latency });
};
```

- [x] **Step 2: Type-check**

Run: `bun run check`
Expected: no new errors.

- [x] **Step 3: Commit**

```bash
git add src/routes/api/external/run/+server.ts
git commit -m "feat(collector): POST /run endpoint computes and stores metrics"
```

---

### Task 6: Rework `GET /api/external/report` to assemble from the store

**Files:**
- Modify (replace whole file): `src/routes/api/external/report/+server.ts`

- [x] **Step 1: Replace the file**

```typescript
// src/routes/api/external/report/+server.ts
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { getCollectorStore } from '$lib/server/collector/store';
import { summarizeRows } from '$lib/server/collector/scoring';
import { getQuestionSet } from '$lib/server/collector/questions';

const DB_PATH = env.COLLECTOR_DB_PATH || '/app/data/collector.db';

export const GET: RequestHandler = async ({ request, url }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return json({ error: 'sessionId query param required' }, { status: 400 });

  const store = getCollectorStore(DB_PATH);
  const rows = store.rowsForSession(sessionId);
  const report = {
    systemLabel: store.systemLabel(sessionId) ?? 'unknown',
    sessionId,
    questionSetVersion: getQuestionSet().version,
    generatedAt: new Date().toISOString(),
    rows,
    summary: summarizeRows(rows),
  };

  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="eval-report-${sessionId}.json"`,
    },
  });
};
```

- [x] **Step 2: Type-check**

Run: `bun run check`
Expected: no new errors.

- [x] **Step 3: Commit**

```bash
git add src/routes/api/external/report/+server.ts
git commit -m "feat(collector): assemble self-contained report.json from store"
```

---

### Task 7: Delete the obsolete collector endpoints and Postgres external store

**Files:**
- Delete: `src/routes/api/external/evaluate/+server.ts`
- Delete: `src/routes/api/external/judge/+server.ts`
- Delete: `src/lib/server/external/storage.ts`

- [x] **Step 1: Remove the files**

Run:
```bash
cd /home/dev/workspace
git rm src/routes/api/external/evaluate/+server.ts \
       src/routes/api/external/judge/+server.ts \
       src/lib/server/external/storage.ts
rmdir src/routes/api/external/evaluate src/routes/api/external/judge 2>/dev/null || true
```

- [x] **Step 2: Confirm nothing else imports the deleted modules**

Run: `grep -rn "external/storage\|external/evaluate\|external/judge" src/ || echo "clean"`
Expected: `clean` (Task 8 removes the last `storage.ts` import in `hooks.server.ts`; if it still shows there, that is expected and fixed next task).

- [x] **Step 3: Commit**

```bash
git commit -m "chore(collector): remove judge/evaluate endpoints and pg external store"
```

---

### Task 8: Gate server startup by mode in `hooks.server.ts`

In `EVAL_SERVER_MODE` the collector must NOT touch Postgres or preload the
embedding model; it must initialise the SQLite store and the question set. In
normal mode, behaviour is unchanged except the removed `ensureExternalSchema`
call.

**Files:**
- Modify (replace whole file): `src/hooks.server.ts`

- [x] **Step 1: Replace the file**

```typescript
// src/hooks.server.ts
/**
 * Server Hooks
 *
 * Normal mode: initialise Postgres + preload embedding model.
 * EVAL_SERVER_MODE: initialise the SQLite collector store + question set only,
 * and gate routing to /api/external/*.
 */
import { error, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { initializeDatabase } from '$lib/server/db/client';
import { preloadModel } from '$lib/server/embeddings/bge-m3';

const EVAL_SERVER_MODE = env.EVAL_SERVER_MODE === '1' || env.EVAL_SERVER_MODE === 'true';

let initialized = false;

async function initialize() {
  if (initialized) return;
  console.log('Initializing server...');

  if (EVAL_SERVER_MODE) {
    // Collector: no Postgres, no Ollama, no embedding model.
    const { getQuestionSet } = await import('$lib/server/collector/questions');
    const { getCollectorStore } = await import('$lib/server/collector/store');
    const dbPath = env.COLLECTOR_DB_PATH || '/app/data/collector.db';
    getQuestionSet();          // fail fast if questions.json is missing/invalid
    getCollectorStore(dbPath); // create schema
    initialized = true;
    console.log('Collector initialization complete');
    return;
  }

  try {
    await initializeDatabase();
    console.log('Database initialized');
    preloadModel().catch((err) => console.warn('Failed to preload embedding model:', err));
    initialized = true;
    console.log('Server initialization complete');
  } catch (err) {
    console.error('Server initialization failed:', err);
    throw err;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  await initialize();

  if (EVAL_SERVER_MODE) {
    const p = event.url.pathname;
    const allowed = p === '/' || p.startsWith('/api/external/') || p.startsWith('/_app/');
    if (!allowed) throw error(404, 'Not found');
  }

  return resolve(event);
};
```

- [x] **Step 2: Type-check + full test run**

Run: `bun run check && bun run test`
Expected: no type errors; all collector tests pass.

- [x] **Step 3: Manual smoke test of the collector locally (Node runtime path)** _(skipped in sandbox: Node 18 < Vite 20)_

Run (in one shell):
```bash
cd /home/dev/workspace
EVAL_SERVER_MODE=1 EVAL_API_KEY=testkey \
  QUESTIONS_PATH="$PWD/eval-dist/seed/questions.json" \
  COLLECTOR_DB_PATH="$PWD/.tmp/collector.db" \
  bun run dev
```
In another shell:
```bash
curl -s -H "Authorization: Bearer testkey" http://localhost:5173/api/external/queries | head
curl -s -X POST -H "Authorization: Bearer testkey" -H "content-type: application/json" \
  -d '{"sessionId":"smoke","systemLabel":"me","queryId":"q1","answer":"x","context":"y","retrievedUrls":["https://www.mci.edu/en/study/master"],"latency":{"retrievalMs":10,"generationMs":20}}' \
  http://localhost:5173/api/external/run
curl -s -H "Authorization: Bearer testkey" "http://localhost:5173/api/external/report?sessionId=smoke"
```
Expected: `/queries` lists q1/q2; `/run` returns `recallAt5:1`; `/report` returns a full report with one row and a summary. Stop the dev server and `rm -rf .tmp` after.

- [x] **Step 4: Commit**

```bash
git add src/hooks.server.ts
git commit -m "feat(collector): mode-gated startup (sqlite collector vs postgres)"
```

---

## Phase 3 — Collector packaging

### Task 9: Question export script

Regenerates `eval-dist/seed/questions.json` from the operator's `test_queries`
table (resolving `expected_document_ids` → document URLs).

**Files:**
- Create: `eval-dist/scripts/export-questions.ts`
- Delete: `eval-dist/scripts/export-queries.ts`

- [x] **Step 1: Write the script (mirror the resolution logic from the old /queries SQL)**

```typescript
// eval-dist/scripts/export-questions.ts
// Run from repo root: bun run eval-dist/scripts/export-questions.ts
// Reads DATABASE_* from .env, writes eval-dist/seed/questions.json.
import { writeFileSync } from 'node:fs';
import { sql } from '../../src/lib/server/db/client';

const VERSION = process.env.QUESTION_SET_VERSION || 'v1';

interface Row {
  id: string;
  query: string;
  category: string | null;
  difficulty: string | null;
  expected_urls: string[];
}

const rows = await sql<Row[]>`
  SELECT tq.id, tq.query, tq.category, tq.difficulty,
    COALESCE(
      (SELECT jsonb_agg(d.url ORDER BY d.url)
       FROM documents d
       WHERE d.id::text = ANY(SELECT jsonb_array_elements_text(tq.expected_document_ids))),
      '[]'::jsonb
    ) AS expected_urls
  FROM test_queries tq
  ORDER BY tq.created_at ASC
`;

const out = {
  version: VERSION,
  queries: rows.map((r) => ({
    id: r.id,
    query: r.query,
    category: r.category,
    difficulty: r.difficulty,
    expectedUrls: r.expected_urls ?? [],
  })),
};

writeFileSync(new URL('../seed/questions.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`Wrote ${out.queries.length} queries (version ${VERSION}) to eval-dist/seed/questions.json`);
process.exit(0);
```

- [x] **Step 2: Remove the old script**

Run: `git rm eval-dist/scripts/export-queries.ts`

- [x] **Step 3: Type-check the script compiles (import path resolves)**

Run: `bun build eval-dist/scripts/export-questions.ts --target=node --outdir /tmp/ebuild >/dev/null && echo OK`
Expected: `OK` (this only checks it bundles; DB connection is not exercised here).

- [x] **Step 4: Commit**

```bash
git add eval-dist/scripts/export-questions.ts
git commit -m "feat(collector): export-questions script replaces queries.sql exporter"
```

---

### Task 10: Slim the compose stack to a single service

**Files:**
- Modify (replace whole file): `eval-dist/docker-compose.yml`
- Delete: `eval-dist/scripts/ollama-entrypoint.sh`
- Delete: `eval-dist/seed/queries.sql`

- [x] **Step 1: Replace `eval-dist/docker-compose.yml`**

```yaml
services:
  # Vendor-supplied evaluation collector.
  # Judge-free, Postgres-free, Ollama-free. All routes other than
  # /api/external/* return 404 (EVAL_SERVER_MODE=1).
  eval-server:
    image: ghcr.io/cl3mi/web-rag-eval:latest
    container_name: web-rag-eval-server
    pull_policy: always
    restart: unless-stopped
    ports:
      - "127.0.0.1:3000:3000"
    environment:
      EVAL_SERVER_MODE: "1"
      EVAL_API_KEY: ${EVAL_API_KEY:?Set EVAL_API_KEY in .env}
      SYSTEM_LABEL: ${SYSTEM_LABEL:-partner-org}
      COLLECTOR_DB_PATH: /app/data/collector.db
      QUESTIONS_PATH: /app/seed/questions.json
    volumes:
      # Persist collected runs across restarts (SQLite scratch — never sent).
      - eval_data:/app/data
      # Override the bundled question set without rebuilding the image (optional).
      - ./seed/questions.json:/app/seed/questions.json:ro

volumes:
  eval_data:
```

- [x] **Step 2: Remove obsolete files**

Run:
```bash
git rm eval-dist/scripts/ollama-entrypoint.sh eval-dist/seed/queries.sql
```

- [x] **Step 3: Commit**

```bash
git add eval-dist/docker-compose.yml
git commit -m "feat(collector): single-service compose, no postgres/ollama"
```

---

### Task 11: Update the Dockerfile to ship the question set and SQLite binary

**Files:**
- Modify: `eval-dist/Dockerfile`

- [x] **Step 1: Ship `seed/questions.json` into the runtime image**

In `eval-dist/Dockerfile`, in the `runtime` stage, after the existing
`COPY --from=build /app/package.json ./package.json` line, add:
```dockerfile
COPY --from=build /app/eval-dist/seed/questions.json ./seed/questions.json
RUN mkdir -p /app/data
```

- [x] **Step 2: Ensure the native `better-sqlite3` binary survives into runtime**

The `deps` stage runs `bun install --no-progress --production`, which fetches
the prebuilt `better-sqlite3` binary for linux. The runtime stage already does
`COPY --from=deps /app/node_modules ./node_modules`, so the binary is present.
Confirm the source-strip step does not delete it — the existing
`find . -name '*.ts' ... -delete` excludes `node_modules`, and `better-sqlite3`
ships `.node`/`.js` only, so no change is needed. Add a build-time assertion
right before `EXPOSE 3000`:
```dockerfile
RUN node -e "require('better-sqlite3'); console.log('better-sqlite3 OK')"
```

- [x] **Step 3: Build the image locally and verify it boots** _(skipped in sandbox: nested build no-network)_

Run (from repo root — build context is the repo so `eval-dist/seed` is reachable):
```bash
cd /home/dev/workspace
docker build -f eval-dist/Dockerfile -t web-rag-eval:local .
docker run --rm -d --name eval-smoke -p 3001:3000 \
  -e EVAL_API_KEY=testkey web-rag-eval:local
sleep 5
curl -s -H "Authorization: Bearer testkey" http://localhost:3001/api/external/queries | head
docker logs eval-smoke | tail -20
docker rm -f eval-smoke
```
Expected: build prints `better-sqlite3 OK`; `/queries` returns the bundled set;
logs show "Collector initialization complete".

- [x] **Step 4: Commit**

```bash
git add eval-dist/Dockerfile
git commit -m "feat(collector): bundle questions.json + verify sqlite in image"
```

---

### Task 12: Rewrite `.env.example` and README for the single-container flow

**Files:**
- Modify (replace whole file): `eval-dist/.env.example`
- Modify (replace whole file): `eval-dist/README.md`

- [x] **Step 1: Replace `eval-dist/.env.example`**

```dotenv
# Shared secret. Must match the Authorization: Bearer token your app sends.
EVAL_API_KEY=change-me-to-a-long-random-string

# Label written into the report so the two systems are distinguishable.
SYSTEM_LABEL=partner-org
```

- [ ] **Step 2: Replace `eval-dist/README.md`**

````markdown
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
````

- [ ] **Step 3: Commit**

```bash
git add eval-dist/.env.example eval-dist/README.md
git commit -m "docs(collector): rewrite env + README for single-container flow"
```

---

## Phase 4 — Compare feature (main app)

### Task 13: Report type + pure judged aggregation (`aggregate.ts`)

**Files:**
- Create: `src/lib/server/compare/types.ts`
- Create: `src/lib/server/compare/aggregate.ts`
- Test: `src/lib/server/compare/aggregate.test.ts`

- [ ] **Step 1: Create the shared report/judged types**

```typescript
// src/lib/server/compare/types.ts
import type { CollectorRow, ReportSummary } from '$lib/server/collector/scoring';

export interface EvalReport {
  systemLabel: string;
  sessionId: string;
  questionSetVersion: string;
  generatedAt: string;
  rows: CollectorRow[];
  summary: ReportSummary;
}

export interface JudgedRow {
  queryId: string;
  query: string;
  groundedness: number;
  completeness: number;
  correctness: number;
  hallucination: boolean;
  answerableFromContext: boolean;
  judgeMean: number;
  failureType: string | null;
  recallAt10: number;
  totalMs: number;
}

export interface SystemAggregate {
  systemLabel: string;
  total: number;
  judge: { groundedness: number | null; completeness: number | null; correctness: number | null; judgeMean: number | null };
  hallucinationRate: number;
  failureTypeCounts: Record<string, number>;
  answerableRate: number;
}

// Persisted comparison payload. Pure interface (no runtime imports) so the
// client `/compare` page can `import type` it without pulling server code.
export interface ComparisonPayload {
  reportA: { systemLabel: string; questionSetVersion: string; sessionId: string };
  reportB: { systemLabel: string; questionSetVersion: string; sessionId: string };
  versionMismatch: boolean;
  aggregates: { a: SystemAggregate; b: SystemAggregate };
  judgedRows: { a: JudgedRow[]; b: JudgedRow[] };
  latency: {
    a: { retrievalMs: number; generationMs: number; totalMs: number };
    b: { retrievalMs: number; generationMs: number; totalMs: number };
  };
}
```

- [ ] **Step 2: Write the failing test for aggregation**

```typescript
// src/lib/server/compare/aggregate.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateJudged } from './aggregate';
import type { JudgedRow } from './types';

const jr = (over: Partial<JudgedRow>): JudgedRow => ({
  queryId: 'q', query: 'x', groundedness: 4, completeness: 4, correctness: 4,
  hallucination: false, answerableFromContext: true, judgeMean: 4,
  failureType: 'normal', recallAt10: 1, totalMs: 100, ...over,
});

describe('aggregateJudged', () => {
  it('excludes unanswerable rows (scores 0) from judge averages', () => {
    const rows = [
      jr({ groundedness: 4, completeness: 4, correctness: 4, judgeMean: 4 }),
      jr({ answerableFromContext: false, groundedness: 0, completeness: 0, correctness: 0,
           judgeMean: 0, failureType: 'retrieval_failure' }),
    ];
    const agg = aggregateJudged('sys', rows);
    // Only the answerable row counts toward the judge means.
    expect(agg.judge.groundedness).toBe(4);
    expect(agg.judge.judgeMean).toBe(4);
    expect(agg.answerableRate).toBe(0.5);
  });

  it('counts failure types and hallucination rate', () => {
    const rows = [
      jr({ failureType: 'normal' }),
      jr({ failureType: 'normal' }),
      jr({ failureType: 'hallucination_failure', hallucination: true }),
    ];
    const agg = aggregateJudged('sys', rows);
    expect(agg.failureTypeCounts).toEqual({ normal: 2, hallucination_failure: 1 });
    expect(agg.hallucinationRate).toBeCloseTo(1 / 3);
    expect(agg.total).toBe(3);
  });

  it('returns null judge means when every row is unanswerable', () => {
    const rows = [jr({ answerableFromContext: false, groundedness: 0, completeness: 0, correctness: 0, judgeMean: 0 })];
    const agg = aggregateJudged('sys', rows);
    expect(agg.judge.groundedness).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run test src/lib/server/compare/aggregate.test.ts`
Expected: FAIL — cannot find module `./aggregate`.

- [ ] **Step 4: Write the implementation**

```typescript
// src/lib/server/compare/aggregate.ts
import type { JudgedRow, SystemAggregate } from './types';

function meanExcludingUnanswerable(rows: JudgedRow[], pick: (r: JudgedRow) => number): number | null {
  const vals = rows.filter((r) => r.answerableFromContext).map(pick);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function aggregateJudged(systemLabel: string, rows: JudgedRow[]): SystemAggregate {
  const failureTypeCounts: Record<string, number> = {};
  for (const r of rows) {
    const key = r.failureType ?? 'unclassified';
    failureTypeCounts[key] = (failureTypeCounts[key] ?? 0) + 1;
  }
  const hallucinationCount = rows.filter((r) => r.hallucination).length;
  const answerableCount = rows.filter((r) => r.answerableFromContext).length;

  return {
    systemLabel,
    total: rows.length,
    judge: {
      groundedness: meanExcludingUnanswerable(rows, (r) => r.groundedness),
      completeness: meanExcludingUnanswerable(rows, (r) => r.completeness),
      correctness: meanExcludingUnanswerable(rows, (r) => r.correctness),
      judgeMean: meanExcludingUnanswerable(rows, (r) => r.judgeMean),
    },
    hallucinationRate: rows.length ? hallucinationCount / rows.length : 0,
    failureTypeCounts,
    answerableRate: rows.length ? answerableCount / rows.length : 0,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun run test src/lib/server/compare/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/compare/types.ts src/lib/server/compare/aggregate.ts src/lib/server/compare/aggregate.test.ts
git commit -m "feat(compare): judged-row aggregation with unanswerable exclusion"
```

---

### Task 14: Judge a report's rows (`judge-report.ts`)

Wraps the existing `judgeAnswer` + `classifyFailureType`. Unanswerable rows get
their judge scores zeroed (matching internal `/quality` storage) so
`aggregateJudged` excludes them.

**Files:**
- Create: `src/lib/server/compare/judge-report.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// src/lib/server/compare/judge-report.ts
import { judgeAnswer, classifyFailureType } from '$lib/server/evaluation/judge';
import type { EvalReport, JudgedRow } from './types';

/** Judge every row of a report. Returns judged rows aligned to report.rows. */
export async function judgeReport(report: EvalReport): Promise<JudgedRow[]> {
  const out: JudgedRow[] = [];
  for (const row of report.rows) {
    const scores = await judgeAnswer({
      question: row.query,
      context: row.context,
      answer: row.answer,
      runs: 3,
    });

    if (!scores) {
      out.push({
        queryId: row.queryId, query: row.query,
        groundedness: 0, completeness: 0, correctness: 0,
        hallucination: false, answerableFromContext: false,
        judgeMean: 0, failureType: null,
        recallAt10: row.retrieval.recallAt10, totalMs: row.latency.totalMs,
      });
      continue;
    }

    const answerable = scores.answerableFromContext ?? true;
    // Zero out unanswerable rows to match internal quality methodology.
    const groundedness = answerable ? scores.groundedness : 0;
    const completeness = answerable ? scores.completeness : 0;
    const correctness = answerable ? scores.answerQuality : 0;
    const judgeMean = answerable
      ? (scores.groundedness + scores.completeness + scores.answerQuality) / 3
      : 0;
    const failureType = classifyFailureType(
      row.retrieval.recallAt10,
      (scores.groundedness + scores.completeness + scores.answerQuality) / 3,
      scores.hallucination,
      scores.answerableFromContext,
    );

    out.push({
      queryId: row.queryId, query: row.query,
      groundedness, completeness, correctness,
      hallucination: scores.hallucination,
      answerableFromContext: answerable,
      judgeMean, failureType,
      recallAt10: row.retrieval.recallAt10, totalMs: row.latency.totalMs,
    });
  }
  return out;
}
```

- [ ] **Step 2: Type-check**

Run: `bun run check`
Expected: no new errors. (Confirms `JudgeScores` fields `groundedness/completeness/answerQuality/hallucination/answerableFromContext` used here match `judge.ts`.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/compare/judge-report.ts
git commit -m "feat(compare): run the LLM-judge over a report's rows"
```

---

### Task 15: Persist judged comparisons (`compare/store.ts`)

**Files:**
- Create: `src/lib/server/compare/store.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// src/lib/server/compare/store.ts
import { sql } from '$lib/server/db/client';
import type { ComparisonPayload } from './types';

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS comparison_runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label_a     text NOT NULL,
      label_b     text NOT NULL,
      payload     jsonb NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
  ensured = true;
}

export async function saveComparison(payload: ComparisonPayload): Promise<string> {
  await ensureSchema();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO comparison_runs (label_a, label_b, payload)
    VALUES (${payload.aggregates.a.systemLabel}, ${payload.aggregates.b.systemLabel},
            ${JSON.stringify(payload)}::jsonb)
    RETURNING id
  `;
  return rows[0].id;
}

export async function getComparison(id: string): Promise<ComparisonPayload | null> {
  await ensureSchema();
  const rows = await sql<{ payload: ComparisonPayload }[]>`
    SELECT payload FROM comparison_runs WHERE id = ${id}
  `;
  return rows[0]?.payload ?? null;
}

export async function listComparisons(): Promise<{ id: string; labelA: string; labelB: string; createdAt: string }[]> {
  await ensureSchema();
  const rows = await sql<{ id: string; label_a: string; label_b: string; created_at: string }[]>`
    SELECT id, label_a, label_b, created_at FROM comparison_runs ORDER BY created_at DESC
  `;
  return rows.map((r) => ({ id: r.id, labelA: r.label_a, labelB: r.label_b, createdAt: r.created_at }));
}
```

- [ ] **Step 2: Type-check**

Run: `bun run check`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/server/compare/store.ts
git commit -m "feat(compare): persist judged comparisons in postgres"
```

---

### Task 16: `POST /api/compare` and `GET /api/compare/[id]`

**Files:**
- Create: `src/routes/api/compare/+server.ts`
- Create: `src/routes/api/compare/[id]/+server.ts`

- [ ] **Step 1: Write `POST /api/compare`**

```typescript
// src/routes/api/compare/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { EvalReport } from '$lib/server/compare/types';
import { judgeReport } from '$lib/server/compare/judge-report';
import { aggregateJudged } from '$lib/server/compare/aggregate';
import { saveComparison } from '$lib/server/compare/store';
import type { ComparisonPayload } from '$lib/server/compare/types';

function isReport(x: unknown): x is EvalReport {
  const r = x as EvalReport;
  return !!r && typeof r.systemLabel === 'string' && Array.isArray(r.rows) &&
    typeof r.questionSetVersion === 'string';
}

function meanLatency(report: EvalReport, key: 'retrievalMs' | 'generationMs' | 'totalMs'): number {
  const rows = report.rows;
  if (!rows.length) return 0;
  return rows.reduce((s, r) => s + r.latency[key], 0) / rows.length;
}

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as { reportA?: unknown; reportB?: unknown } | null;
  if (!body || !isReport(body.reportA) || !isReport(body.reportB)) {
    return json({ error: 'Required: { reportA, reportB } — two eval reports' }, { status: 400 });
  }
  const reportA = body.reportA;
  const reportB = body.reportB;

  const [judgedA, judgedB] = await Promise.all([judgeReport(reportA), judgeReport(reportB)]);

  const payload: ComparisonPayload = {
    reportA: { systemLabel: reportA.systemLabel, questionSetVersion: reportA.questionSetVersion, sessionId: reportA.sessionId },
    reportB: { systemLabel: reportB.systemLabel, questionSetVersion: reportB.questionSetVersion, sessionId: reportB.sessionId },
    versionMismatch: reportA.questionSetVersion !== reportB.questionSetVersion,
    aggregates: {
      a: aggregateJudged(reportA.systemLabel, judgedA),
      b: aggregateJudged(reportB.systemLabel, judgedB),
    },
    judgedRows: { a: judgedA, b: judgedB },
    latency: {
      a: { retrievalMs: meanLatency(reportA, 'retrievalMs'), generationMs: meanLatency(reportA, 'generationMs'), totalMs: meanLatency(reportA, 'totalMs') },
      b: { retrievalMs: meanLatency(reportB, 'retrievalMs'), generationMs: meanLatency(reportB, 'generationMs'), totalMs: meanLatency(reportB, 'totalMs') },
    },
  };

  const id = await saveComparison(payload);
  return json({ id, ...payload });
};
```

- [ ] **Step 2: Write `GET /api/compare/[id]`**

```typescript
// src/routes/api/compare/[id]/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getComparison } from '$lib/server/compare/store';

export const GET: RequestHandler = async ({ params }) => {
  const payload = await getComparison(params.id);
  if (!payload) return json({ error: 'Not found' }, { status: 404 });
  return json({ id: params.id, ...payload });
};
```

- [ ] **Step 3: Type-check**

Run: `bun run check`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/api/compare/+server.ts "src/routes/api/compare/[id]/+server.ts"
git commit -m "feat(compare): POST /api/compare judges two reports, GET by id"
```

---

### Task 17: `/compare` UI page

Upload two report JSONs, POST to `/api/compare`, render side-by-side. Uses
Svelte 5 runes.

**Files:**
- Create: `src/routes/compare/+page.server.ts`
- Create: `src/routes/compare/+page.svelte`

- [ ] **Step 1: Write `+page.server.ts` (list prior comparisons)**

```typescript
// src/routes/compare/+page.server.ts
import type { PageServerLoad } from './$types';
import { listComparisons } from '$lib/server/compare/store';

export const load: PageServerLoad = async () => {
  return { comparisons: await listComparisons() };
};
```

- [ ] **Step 2: Write `+page.svelte`**

```svelte
<!-- src/routes/compare/+page.svelte -->
<script lang="ts">
  import type { PageData } from './$types';
  import type { ComparisonPayload } from '$lib/server/compare/types';

  let { data }: { data: PageData } = $props();

  let fileA = $state<File | null>(null);
  let fileB = $state<File | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let result = $state<(ComparisonPayload & { id: string }) | null>(null);

  async function readJson(f: File): Promise<unknown> {
    return JSON.parse(await f.text());
  }

  async function run() {
    error = null;
    if (!fileA || !fileB) { error = 'Select both report files.'; return; }
    loading = true;
    try {
      const [reportA, reportB] = await Promise.all([readJson(fileA), readJson(fileB)]);
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportA, reportB }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Compare failed');
      result = json;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  const fmt = (n: number | null, d = 3) => (n == null ? '—' : n.toFixed(d));
  const failureTypes = ['normal', 'generation_failure', 'retrieval_failure', 'robust_generation', 'hallucination_failure', 'unclassified'];
</script>

<h1>Compare two RAG reports</h1>

<section class="upload">
  <label>Report A <input type="file" accept="application/json"
    onchange={(e) => (fileA = e.currentTarget.files?.[0] ?? null)} /></label>
  <label>Report B <input type="file" accept="application/json"
    onchange={(e) => (fileB = e.currentTarget.files?.[0] ?? null)} /></label>
  <button onclick={run} disabled={loading}>{loading ? 'Judging…' : 'Compare'}</button>
</section>

{#if error}<p class="error">{error}</p>{/if}

{#if result}
  {#if result.versionMismatch}
    <p class="warn">⚠ Question-set versions differ
      ({result.reportA.questionSetVersion} vs {result.reportB.questionSetVersion}).
      Metrics may not be comparable.</p>
  {/if}

  <h2>Summary</h2>
  <table>
    <thead><tr><th>Metric</th><th>{result.aggregates.a.systemLabel}</th><th>{result.aggregates.b.systemLabel}</th></tr></thead>
    <tbody>
      <tr><td>Groundedness</td><td>{fmt(result.aggregates.a.judge.groundedness)}</td><td>{fmt(result.aggregates.b.judge.groundedness)}</td></tr>
      <tr><td>Completeness</td><td>{fmt(result.aggregates.a.judge.completeness)}</td><td>{fmt(result.aggregates.b.judge.completeness)}</td></tr>
      <tr><td>Correctness</td><td>{fmt(result.aggregates.a.judge.correctness)}</td><td>{fmt(result.aggregates.b.judge.correctness)}</td></tr>
      <tr><td>Judge mean</td><td>{fmt(result.aggregates.a.judge.judgeMean)}</td><td>{fmt(result.aggregates.b.judge.judgeMean)}</td></tr>
      <tr><td>Hallucination rate</td><td>{fmt(result.aggregates.a.hallucinationRate)}</td><td>{fmt(result.aggregates.b.hallucinationRate)}</td></tr>
      <tr><td>Answerable rate</td><td>{fmt(result.aggregates.a.answerableRate)}</td><td>{fmt(result.aggregates.b.answerableRate)}</td></tr>
      <tr><td>Avg total latency (ms)</td><td>{fmt(result.latency.a.totalMs, 0)}</td><td>{fmt(result.latency.b.totalMs, 0)}</td></tr>
      <tr><td>Avg retrieval latency (ms)</td><td>{fmt(result.latency.a.retrievalMs, 0)}</td><td>{fmt(result.latency.b.retrievalMs, 0)}</td></tr>
      <tr><td>Avg generation latency (ms)</td><td>{fmt(result.latency.a.generationMs, 0)}</td><td>{fmt(result.latency.b.generationMs, 0)}</td></tr>
    </tbody>
  </table>

  <h2>Failure types</h2>
  <table>
    <thead><tr><th>Type</th><th>{result.aggregates.a.systemLabel}</th><th>{result.aggregates.b.systemLabel}</th></tr></thead>
    <tbody>
      {#each failureTypes as ft}
        <tr><td>{ft}</td>
          <td>{result.aggregates.a.failureTypeCounts[ft] ?? 0}</td>
          <td>{result.aggregates.b.failureTypeCounts[ft] ?? 0}</td></tr>
      {/each}
    </tbody>
  </table>

  <p class="saved">Saved as comparison <code>{result.id}</code></p>
{/if}

{#if data.comparisons.length}
  <h2>Previous comparisons</h2>
  <ul>
    {#each data.comparisons as c}
      <li><a href={`/api/compare/${c.id}`}>{c.labelA} vs {c.labelB}</a> — {new Date(c.createdAt).toLocaleString()}</li>
    {/each}
  </ul>
{/if}

<style>
  .upload { display: flex; gap: 1rem; align-items: end; margin: 1rem 0; flex-wrap: wrap; }
  table { border-collapse: collapse; margin: 0.5rem 0 1.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.35rem 0.75rem; text-align: left; }
  .error { color: #b00; }
  .warn { color: #a60; }
  .saved { color: #555; font-size: 0.9rem; }
</style>
```

- [ ] **Step 3: Type-check**

Run: `bun run check`
Expected: no new errors.

- [ ] **Step 4: Manual UI smoke test** [manual]

Prereq: Postgres + Ollama running (`docker compose --profile gpu up -d`), main
app dev server up (`bun run dev`), and two `report.json` files produced by the
collector (from Task 8 Step 3, run twice with different `sessionId`/`systemLabel`).

Steps: open `http://localhost:5173/compare`, upload both files, click Compare.
Expected: after judging, the summary + failure-type tables render with both
system labels; a comparison id is shown; reloading the page lists it under
"Previous comparisons".

- [ ] **Step 5: Commit**

```bash
git add src/routes/compare/+page.server.ts src/routes/compare/+page.svelte
git commit -m "feat(compare): /compare upload + side-by-side UI"
```

---

### Task 18: Add a nav link to `/compare`

**Files:**
- Modify: the app's main navigation component (find it first)

- [ ] **Step 1: Locate the nav**

Run: `grep -rln "/evaluate\|/quality" src/routes/**/+layout.svelte src/lib/components 2>/dev/null`
Expected: prints the file that contains the existing nav links (e.g. a
`+layout.svelte` or a `Nav.svelte`).

- [ ] **Step 2: Add the link next to the existing `/quality` link**

In that file, alongside the existing `<a href="/quality">…</a>` entry, add:
```svelte
<a href="/compare">Compare</a>
```
Match the surrounding markup/classes exactly (copy the format of the adjacent link).

- [ ] **Step 3: Type-check**

Run: `bun run check`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(compare): add /compare to navigation"
```

---

## Phase 5 — Final verification

### Task 19: Full-suite check + end-to-end dry run

- [ ] **Step 1: Type-check and unit tests**

Run: `bun run check && bun run test`
Expected: no type errors; all `*.test.ts` pass.

- [ ] **Step 2: End-to-end dry run** [manual]

1. Build + boot the collector image (Task 11 Step 3), produce `report-a.json`
   with `systemLabel=system-a sessionId=a` and `report-b.json` with
   `systemLabel=system-b sessionId=b` by POSTing a couple of `/run` calls each,
   then `GET /report` for each session.
2. Start the main app with Postgres + Ollama, open `/compare`, upload both.
3. Confirm: judged summary renders, failure-type histogram populates, latency
   rows show, comparison persists and reappears on reload.

Expected: full flow works; numbers are plausible (recall 0/1 per URL match,
judge means in 1–5).

- [ ] **Step 3: Update CLAUDE.md architecture notes**

In `/home/dev/workspace/CLAUDE.md`, under "Evaluation system", add a short
subsection documenting: the collector (`eval-dist/`, `/api/external/{queries,run,report}`,
SQLite, bundled `questions.json`), the `report.json` schema, and the `/compare`
flow (judges two reports with the same judge, persists to `comparison_runs`).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document collector + compare flow in CLAUDE.md"
```

---

## Self-Review Notes (for the implementer)

- **Reused, not reinvented:** retrieval metrics come from `metrics.ts`
  (`calculateRecallAtK/MRR/NDCGBinary/HitAtK`, `calculateLatencyStats`); judging
  from `judge.ts` (`judgeAnswer`, `classifyFailureType`). Do not fork them.
- **`JudgeScores` field name:** the judge returns `answerQuality` (not
  `correctness`); Task 14 maps `answerQuality → correctness`. Keep that mapping.
- **Mode isolation:** `better-sqlite3` and the collector modules are only ever
  imported behind `EVAL_SERVER_MODE` (dynamic import in `hooks.server.ts`; the
  `/api/external/*` routes are only reachable in that mode). The main app never
  loads them, so the Node-20 main image is unaffected.
- **Unanswerable handling matches internal:** Task 14 zeroes unanswerable rows
  and Task 13 excludes them from judge means — same as `/quality`'s
  `NULLIF(...,0)`.
