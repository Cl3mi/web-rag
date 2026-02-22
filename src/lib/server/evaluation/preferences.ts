/**
 * Preference Dataset Service
 *
 * Populates rag_preferences from judged data.
 * Exports training data as JSONL for LoRA fine-tuning.
 */

import { sql } from '$lib/server/db/client';

/**
 * Populate preferences from judged evaluation data.
 *
 * Labelling uses judge_mean (avg of groundedness + completeness + correctness):
 *   chosen   = judge_mean >= 3.5 AND hallucination = false AND failure_type != 'retrieval_failure'
 *   rejected = judge_mean <  2.5 OR  hallucination = true
 *   neutral  = everything else
 *
 * retrieval_failure rows are explicitly excluded from chosen even when they score
 * highly — the judge gives high scores to correct refusals ("not in context"), but
 * those answers provide no training value as positive examples.
 *
 * Also re-labels any existing rows whose label is inconsistent with the
 * current thresholds.
 */
export async function populatePreferences(): Promise<{
  inserted: number;
  chosen: number;
  rejected: number;
  relabeled: number;
}> {
  // --- Step 1: Re-label existing rows that are wrong under the current thresholds ---
  // Join rag_judge_results to use jr.judge_mean as the authoritative score (not the
  // stale quality_score stored at insertion time). Also sync quality_score so future
  // reads are consistent. Refusal rows repaired by repairRefusalScores() have
  // jr.judge_mean=0 and failure_type='retrieval_failure', so they will be un-chosen here.
  const relabelResult = await sql`
    UPDATE rag_preferences rp
    SET
      quality_score = jr.judge_mean,
      chosen   = (jr.judge_mean >= 3.5 AND NOT rp.hallucination AND COALESCE(jr.failure_type, '') != 'retrieval_failure'),
      rejected = (jr.judge_mean <  2.5 OR  rp.hallucination)
    FROM rag_runs_evaluation re
    JOIN rag_judge_results jr ON jr.evaluation_id = re.id
    WHERE rp.evaluation_id = re.id
      AND (
        rp.quality_score IS DISTINCT FROM jr.judge_mean
        OR (rp.chosen = true  AND (jr.judge_mean < 3.5 OR rp.hallucination OR jr.failure_type = 'retrieval_failure'))
        OR (rp.rejected = true AND jr.judge_mean >= 2.5 AND NOT rp.hallucination AND COALESCE(jr.failure_type, '') != 'retrieval_failure')
        OR (rp.chosen = false AND rp.rejected = false AND jr.judge_mean >= 3.5 AND NOT rp.hallucination AND COALESCE(jr.failure_type, '') != 'retrieval_failure')
      )
    RETURNING rp.id
  `;
  const relabeled = relabelResult.length;

  // --- Step 2: Insert new rows not yet in preferences ---
  const judged = await sql`
    SELECT
      re.id as evaluation_id,
      re.question,
      re.retrieved_context,
      re.generated_answer,
      jr.judge_mean,
      jr.hallucination,
      jr.failure_type
    FROM rag_judge_results jr
    JOIN rag_runs_evaluation re ON jr.evaluation_id = re.id
    LEFT JOIN rag_preferences rp ON rp.evaluation_id = re.id
    WHERE rp.id IS NULL
    ORDER BY re.created_at ASC
  `;

  let insertedCount = 0;
  let chosenCount = 0;
  let rejectedCount = 0;

  for (const row of judged) {
    const qualityScore = Number(row.judge_mean);
    const hallucination = row.hallucination as boolean;
    const failureType = row.failure_type as string | null;

    // Correct refusals (retrieval_failure with high judge_mean) must not be chosen:
    // they score highly because the judge rewards correct abstention when context
    // lacks the answer, but they provide no value as training positive examples.
    const chosen   = qualityScore >= 3.5 && !hallucination && failureType !== 'retrieval_failure';
    const rejected = qualityScore <  2.5 || hallucination;

    await sql`
      INSERT INTO rag_preferences (
        question, context, answer,
        quality_score, hallucination, chosen, rejected,
        source, evaluation_id
      ) VALUES (
        ${row.question as string},
        ${(row.retrieved_context as string).slice(0, 10000)},
        ${row.generated_answer as string},
        ${qualityScore},
        ${hallucination},
        ${chosen},
        ${rejected},
        'llm_judge',
        ${row.evaluation_id as string}
      )
    `;

    insertedCount++;
    if (chosen) chosenCount++;
    if (rejected) rejectedCount++;
  }

  return { inserted: insertedCount, chosen: chosenCount, rejected: rejectedCount, relabeled };
}

/**
 * Export chosen preferences as JSONL training data.
 * Format compatible with Ollama/OpenAI fine-tuning.
 */
export async function exportTrainingData(options: {
  onlyChosen?: boolean;
  maxRows?: number;
} = {}): Promise<string> {
  const { onlyChosen = true, maxRows = 10000 } = options;

  const whereClause = onlyChosen ? sql`WHERE chosen = true` : sql`WHERE 1=1`;

  const rows = await sql`
    SELECT question, context, answer, quality_score
    FROM rag_preferences
    ${whereClause}
    ORDER BY quality_score DESC NULLS LAST
    LIMIT ${maxRows}
  `;

  const lines: string[] = [];

  for (const row of rows) {
    const entry = {
      messages: [
        {
          role: 'system',
          content: 'Answer only using the provided context.',
        },
        {
          role: 'user',
          content: `Question: ${row.question}\nContext: ${(row.context as string).slice(0, 6000)}`,
        },
        {
          role: 'assistant',
          content: row.answer as string,
        },
      ],
    };

    lines.push(JSON.stringify(entry));
  }

  return lines.join('\n');
}

/**
 * Repair preferences with NULL evaluation_id.
 * 1. Try to re-link by matching question + answer text
 * 2. Delete truly orphaned rows where no source evaluation exists
 */
export async function repairPreferenceLinks(): Promise<{ repaired: number; deleted: number }> {
  // Step 1: Try to re-link by matching question + answer text
  const repaired = await sql`
    UPDATE rag_preferences rp
    SET evaluation_id = sub.eval_id
    FROM (
      SELECT DISTINCT ON (rp2.id) rp2.id as pref_id, re.id as eval_id
      FROM rag_preferences rp2
      JOIN rag_runs_evaluation re ON re.question = rp2.question AND re.generated_answer = rp2.answer
      WHERE rp2.evaluation_id IS NULL
      ORDER BY rp2.id, re.created_at DESC
    ) sub
    WHERE rp.id = sub.pref_id
    RETURNING rp.id
  `;

  // Step 2: Delete orphans that have no evaluation_id AND no matching rag_runs_evaluation row
  const deleted = await sql`
    DELETE FROM rag_preferences rp
    WHERE rp.evaluation_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM rag_runs_evaluation re
        WHERE re.question = rp.question
      )
    RETURNING rp.id
  `;

  return { repaired: repaired.length, deleted: deleted.length };
}

/**
 * Get preference samples for display
 */
export async function getPreferenceSamples(options: {
  limit?: number;
  filter?: 'all' | 'chosen' | 'rejected';
} = {}): Promise<Array<{
  id: string;
  question: string;
  answer: string;
  qualityScore: number | null;
  hallucination: boolean;
  chosen: boolean;
  rejected: boolean;
  source: string;
  pipelineName: string | null;
  failureType: string | null;
  createdAt: string;
}>> {
  const { limit = 50, filter = 'all' } = options;

  const filterClause = filter === 'chosen'
    ? sql`WHERE rp.chosen = true`
    : filter === 'rejected'
      ? sql`WHERE rp.rejected = true`
      : sql`WHERE 1=1`;

  const rows = await sql`
    SELECT rp.id, rp.question, rp.answer, rp.quality_score, rp.hallucination,
           rp.chosen, rp.rejected, rp.source, rp.created_at,
           COALESCE(re.pipeline_name, (
             SELECT re2.pipeline_name FROM rag_runs_evaluation re2
             WHERE re2.question = rp.question
             ORDER BY re2.created_at DESC LIMIT 1
           )) as pipeline_name,
           COALESCE(jr.failure_type, (
             SELECT jr2.failure_type FROM rag_runs_evaluation re2
             JOIN rag_judge_results jr2 ON jr2.evaluation_id = re2.id
             WHERE re2.question = rp.question
             ORDER BY re2.created_at DESC LIMIT 1
           )) as failure_type
    FROM rag_preferences rp
    LEFT JOIN rag_runs_evaluation re ON rp.evaluation_id = re.id
    LEFT JOIN rag_judge_results jr ON jr.evaluation_id = re.id
    ${filterClause}
    ORDER BY rp.created_at DESC
    LIMIT ${limit}
  `;

  return rows.map(r => ({
    id: r.id as string,
    question: r.question as string,
    answer: (r.answer as string).slice(0, 300),
    qualityScore: r.quality_score !== null ? Number(r.quality_score) : null,
    hallucination: r.hallucination as boolean,
    chosen: r.chosen as boolean,
    rejected: r.rejected as boolean,
    source: r.source as string,
    pipelineName: (r.pipeline_name as string | null) || null,
    failureType: (r.failure_type as string | null) || null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/**
 * Get preference dataset statistics
 */
export async function getPreferenceStats(): Promise<{
  total: number;
  chosen: number;
  rejected: number;
  neutral: number;
  avgQualityScore: number;
  bySource: Record<string, number>;
}> {
  const stats = await sql`
    SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN chosen THEN 1 END) as chosen,
      COUNT(CASE WHEN rejected THEN 1 END) as rejected,
      COUNT(CASE WHEN NOT chosen AND NOT rejected THEN 1 END) as neutral,
      AVG(quality_score) as avg_quality_score
    FROM rag_preferences
  `;

  const sources = await sql`
    SELECT source, COUNT(*) as count
    FROM rag_preferences
    GROUP BY source
  `;

  const bySource: Record<string, number> = {};
  for (const s of sources) {
    bySource[s.source as string] = Number(s.count);
  }

  return {
    total: Number(stats[0].total) || 0,
    chosen: Number(stats[0].chosen) || 0,
    rejected: Number(stats[0].rejected) || 0,
    neutral: Number(stats[0].neutral) || 0,
    avgQualityScore: Number(stats[0].avg_quality_score) || 0,
    bySource,
  };
}
