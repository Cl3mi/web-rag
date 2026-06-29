import { sql } from '$lib/server/db/client';

let ensured = false;

export async function ensureExternalSchema(): Promise<void> {
  if (ensured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS external_runs (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id      text NOT NULL,
      query_id        uuid,
      query_text      text NOT NULL,
      expected_urls   jsonb NOT NULL DEFAULT '[]'::jsonb,
      retrieved_urls  jsonb NOT NULL DEFAULT '[]'::jsonb,
      retrieved_context text,
      generated_answer  text,
      client_meta     jsonb NOT NULL DEFAULT '{}'::jsonb,
      recall_at_5     real,
      recall_at_10    real,
      mrr             real,
      ndcg            real,
      hit_at_1        real,
      hit_at_5        real,
      hit_at_10       real,
      groundedness    real,
      completeness    real,
      correctness     real,
      hallucination   boolean,
      answerable_from_context boolean,
      judge_mean      real,
      failure_type    text,
      judge_model     text,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS external_runs_session_idx ON external_runs(session_id)`;
  await sql`CREATE INDEX IF NOT EXISTS external_runs_query_idx ON external_runs(query_id)`;
  ensured = true;
}

export interface RetrievalRecord {
  sessionId: string;
  queryId: string | null;
  queryText: string;
  expectedUrls: string[];
  retrievedUrls: string[];
  clientMeta: Record<string, unknown>;
  metrics: {
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    ndcg: number;
    hitAt1: number;
    hitAt5: number;
    hitAt10: number;
  };
}

export async function recordRetrieval(rec: RetrievalRecord): Promise<string> {
  await ensureExternalSchema();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO external_runs (
      session_id, query_id, query_text, expected_urls, retrieved_urls, client_meta,
      recall_at_5, recall_at_10, mrr, ndcg, hit_at_1, hit_at_5, hit_at_10
    ) VALUES (
      ${rec.sessionId}, ${rec.queryId}, ${rec.queryText},
      ${JSON.stringify(rec.expectedUrls)}::jsonb,
      ${JSON.stringify(rec.retrievedUrls)}::jsonb,
      ${JSON.stringify(rec.clientMeta)}::jsonb,
      ${rec.metrics.recallAt5}, ${rec.metrics.recallAt10},
      ${rec.metrics.mrr}, ${rec.metrics.ndcg},
      ${rec.metrics.hitAt1}, ${rec.metrics.hitAt5}, ${rec.metrics.hitAt10}
    )
    RETURNING id
  `;
  return rows[0].id;
}

export interface JudgeRecord {
  sessionId: string;
  queryId: string | null;
  queryText: string;
  retrievedContext: string;
  generatedAnswer: string;
  clientMeta: Record<string, unknown>;
  scores: {
    groundedness: number;
    completeness: number;
    correctness: number;
    hallucination: boolean;
    judgeMean: number;
    answerableFromContext?: boolean;
    failureType: string | null;
    judgeModel: string;
  };
}

export async function recordJudge(rec: JudgeRecord): Promise<string> {
  await ensureExternalSchema();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO external_runs (
      session_id, query_id, query_text, retrieved_context, generated_answer, client_meta,
      groundedness, completeness, correctness, hallucination,
      answerable_from_context, judge_mean, failure_type, judge_model
    ) VALUES (
      ${rec.sessionId}, ${rec.queryId}, ${rec.queryText},
      ${rec.retrievedContext}, ${rec.generatedAnswer},
      ${JSON.stringify(rec.clientMeta)}::jsonb,
      ${rec.scores.groundedness}, ${rec.scores.completeness}, ${rec.scores.correctness},
      ${rec.scores.hallucination}, ${rec.scores.answerableFromContext ?? null},
      ${rec.scores.judgeMean}, ${rec.scores.failureType}, ${rec.scores.judgeModel}
    )
    RETURNING id
  `;
  return rows[0].id;
}

export async function exportReport(sessionId?: string): Promise<{
  sessionId: string | null;
  rows: Record<string, unknown>[];
  summary: Record<string, unknown>;
}> {
  await ensureExternalSchema();
  const rows = sessionId
    ? await sql`SELECT * FROM external_runs WHERE session_id = ${sessionId} ORDER BY created_at ASC`
    : await sql`SELECT * FROM external_runs ORDER BY session_id, created_at ASC`;

  const numeric = ['recall_at_5', 'recall_at_10', 'mrr', 'ndcg',
                   'hit_at_1', 'hit_at_5', 'hit_at_10',
                   'groundedness', 'completeness', 'correctness', 'judge_mean'] as const;
  const summary: Record<string, number | null> = {};
  for (const f of numeric) {
    const vals = rows.map(r => r[f] as number | null).filter((v): v is number => v != null);
    summary[f] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  const hallucinationCount = rows.filter(r => r.hallucination === true).length;
  return {
    sessionId: sessionId ?? null,
    rows: rows as Record<string, unknown>[],
    summary: {
      total: rows.length,
      hallucinationRate: rows.length ? hallucinationCount / rows.length : 0,
      ...summary,
    },
  };
}
