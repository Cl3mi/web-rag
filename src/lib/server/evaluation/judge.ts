/**
 * LLM-as-Judge Service
 *
 * Evaluates generated answers for groundedness, completeness, correctness,
 * and hallucination using a local LLM via Ollama.
 *
 * Manually triggered, processes in batches, rate-limit friendly.
 */

import { sql } from '$lib/server/db/client';
import { env } from '$env/dynamic/private';
import type { JudgeScores, FailureType } from '$lib/types';

// Patterns deliberately conservative: each one requires BOTH a negative/inability marker
// AND an explicit reference to the context/documents as the limiting factor.
// Overly broad patterns (e.g. matching "mentioned in context" or "no additional information")
// cause false positives that permanently zero good judge scores.
const REFUSAL_PATTERNS = [
  // "not in/within/part of the context/documents"
  /\bnot (in|within|part of|covered by)\b.{0,50}\b(context|documents?)\b/i,
  // "(the) context/documents does not/cannot contain/include/mention/have"
  /\b(provided |given |retrieved )?(context|documents?)\b.{0,30}\b(does?n'?t|do not|cannot|can'?t|lacks?|has no)\b.{0,25}\b(contain|include|mention|have|cover|answer|address)\b/i,
  // "cannot answer/find/determine ... context/documents"
  /\bcannot (answer|find|determine)\b.{0,60}\b(context|documents?)\b/i,
  // "no information/details in/from the context" (tight window — avoids "no additional info")
  /\bno (information|details?|data)\b.{0,20}\b(in|from|within)\b.{0,25}\b(the )?(context|documents?|provided|retrieved)\b/i,
  // "not available/found/mentioned in/from the context" (tight window after "not")
  /\b(not|n'?t)\b.{0,15}\b(available|present|found|mentioned)\b.{0,25}\b(in|from|within)\b.{0,25}\b(the )?(context|documents?|provided|retrieved)\b/i,
  // "I don't have enough information to answer"
  /\bI (don'?t|do not|cannot|can'?t) have (enough |sufficient |any )?(information|context|details?) (to |for )/i,
  // German: "nicht ... im/in dem/aus dem bereitgestell..." — covers "nicht direkt im bereitgestellten Text"
  /\bnicht\b.{0,60}\b(im|in (dem|diesem)|aus (dem|diesem))\b.{0,20}\bbereitgestell/i,
  // German: "bereitgestell... nicht ... abgeleitet/entnommen/gefunden/beantwortet" — covers
  // "aus dem bereitgestellten Kontext nicht direkt abgeleitet werden"
  /\bbereitgestell\w*.{0,80}\bnicht\b.{0,40}\b(abgeleitet|entnommen|gefunden|beantwortet|bestimmt)\b/i,
  // German: generic inability — "Es ist nicht möglich" / "kann nicht beantwortet werden"
  /\b(Es ist nicht möglich|kann nicht\b.{0,20}\b(beantwortet|abgeleitet|bestimmt) werden)\b/i,
  // German: "keine Informationen/Angaben in dem bereitgestellten Text/Kontext"
  /\b(keine?|nicht genug|nicht ausreichend).{0,20}(Informationen?|Angaben?|Details?).{0,30}(in (dem|den|diesem)|aus (dem|den)).{0,30}(Text|Kontext|Dokumenten?|bereitgestellt)/i,
];

function isRefusalAnswer(answer: string): boolean {
  return REFUSAL_PATTERNS.some(p => p.test(answer));
}

const OLLAMA_BASE_URL = env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_JUDGE_MODEL = env.OLLAMA_JUDGE_MODEL || env.OLLAMA_MODEL || 'llama3.2';

// Must match MAX_CONTEXT_LENGTH in evaluate/+server.ts so the judge sees the
// same context window the LLM used during generation.
const JUDGE_CONTEXT_LENGTH = 8000;

// Classification thresholds — named constants so the decision criteria are explicit
// and can be updated in one place.
const RECALL_THRESHOLD = 0.5;    // recallAtK >= this → retrieval is considered adequate
const JUDGE_MEAN_THRESHOLD = 3.0; // judgeMean >= this → generation is considered adequate
// Intentionally lower than the training "chosen" threshold (3.5):
// an answer can be "working" (normal) without being good enough
// for training positive examples.


const JUDGE_PROMPT = `You are a strict and deterministic evaluator for a Retrieval-Augmented Generation (RAG) system.

You will be given:
- a QUESTION
- a CONTEXT (retrieved documents)
- an ANSWER (model output)

Your task is to evaluate the ANSWER ONLY based on the provided CONTEXT.

==============================
GLOBAL RULES (VERY IMPORTANT)
==============================

1. CONTEXT IS THE ONLY SOURCE OF TRUTH
- Use ONLY the provided CONTEXT.
- Do NOT use your own knowledge.
- If something is true in the real world but NOT present in the CONTEXT, it MUST be treated as unsupported.

2. CLAIM TRACEABILITY
- Every factual statement in the ANSWER must be explicitly supported by the CONTEXT.
- Unsupported information = hallucination.

3. DETERMINE ANSWERABILITY FIRST
Before scoring anything, decide:

Can the QUESTION be answered using the provided CONTEXT?

Set:
answerable_from_context = true  → if sufficient information exists in the CONTEXT
answerable_from_context = false → if the CONTEXT does NOT contain the necessary information

This decision must be based strictly on the CONTEXT.

4. ABSTENTION HANDLING (CRITICAL FOR RAG)

If the ANSWER says or implies:
- information is not in the context
- cannot be determined
- not provided / not mentioned

Then:

IF answerable_from_context = true:
→ This is a failure to use retrieved information.
Set:
- completeness = 1
- answer_quality = 1

IF answerable_from_context = false:
→ This is correct behavior.
→ groundedness = 5 (no unsupported claims)
→ completeness = 1 (the task is not completed)
→ answer_quality = 1 (provides no value to the user)

Do NOT mark this as hallucination unless unsupported facts are added.

5. BE STRICT AND CONSISTENT
Prefer lower scores when uncertain.
Do not reward partially correct or vague answers.

==============================
METRICS
==============================

1. groundedness (1–5)
How well are the claims supported by the CONTEXT?

1 = Mostly unsupported or contradicts context  
2 = Many unsupported claims  
3 = Mix of supported and unsupported claims  
4 = Mostly supported with minor untraceable details  
5 = Every claim is directly supported by the context  

If hallucination = true, groundedness must be ≤ 3.

---

2. completeness (1–5)
How much relevant information from the CONTEXT (that answers the question) is used?

If answerable_from_context = true:
1 = Misses most key information or refuses despite available info  
3 = Uses some relevant information but misses important parts  
5 = Uses all key information needed to answer  

If answerable_from_context = false:
1 = Correctly states that the information is not available (or attempts to answer with invented content)
5 = (Not applicable — correct refusals score 1 on completeness)

---

3. answer_quality (1–5)
How well does the answer address the user's question?

1 = Does not answer the question, incorrect refusal, or misleading  
2 = Very weak or mostly irrelevant  
3 = Partially answers but incomplete or unclear  
4 = Good and mostly complete  
5 = Clear, direct, helpful, and appropriate  

If answerable_from_context = true and the model refuses → score = 1.

---

4. hallucination (true/false)
Does the answer contain ANY information not supported by the CONTEXT?

true  = Any unsupported factual content is present  
false = All information is traceable to the context  

Note:
If the model incorrectly claims "information not in context" while it actually is present,
this is NOT hallucination — it is a completeness/quality failure.

==============================
SCORING EDGE CASES
==============================

Case A — Context contains answer, model answers correctly:
→ High scores across all metrics

Case B — Context contains answer, model says "not in context":
→ answerable_from_context = true  
→ completeness = 1  
→ answer_quality = 1  
→ hallucination = false  

Case C — Context does NOT contain answer, model refuses:
→ answerable_from_context = false
→ groundedness = 5 (no unsupported claims are made)
→ completeness = 1 (the task is not completed — context lacks the answer)
→ answer_quality = 1 (provides no value to the user)
→ hallucination = false

Case D — Context does NOT contain answer, model invents:
→ answerable_from_context = false  
→ hallucination = true  
→ groundedness ≤ 2  
→ answer_quality ≤ 2  

==============================
OUTPUT FORMAT (STRICT)
==============================

Return ONLY valid JSON. No explanations.

QUESTION: {question}

CONTEXT:
{context}

ANSWER:
{answer}

Return EXACTLY:

{
  "answerable_from_context": <true|false>,
  "groundedness": <1-5>,
  "completeness": <1-5>,
  "answer_quality": <1-5>,
  "hallucination": <true|false>
}
`;

interface UnjudgedRow {
  id: string;
  question: string;
  retrieved_context: string;
  generated_answer: string;
  recall_at_k: number | null;
  retrieved_doc_ids: string[];
  query_id: string;
}

/**
 * Parse judge LLM response into structured scores
 */
function parseJudgeResponse(response: string): JudgeScores | null {
  // Try to extract JSON from the response
  const jsonPatterns = [
    // Direct JSON
    /^\s*\{[\s\S]*\}\s*$/,
    // JSON in code block
    /```(?:json)?\s*(\{[\s\S]*?\})\s*```/,
    // JSON somewhere in text
    /\{[^{}]*"groundedness"[^{}]*\}/,
  ];

  for (const pattern of jsonPatterns) {
    const match = response.match(pattern);
    if (match) {
      try {
        const jsonStr = match[1] || match[0];
        const parsed = JSON.parse(jsonStr);

        const groundedness = Number(parsed.groundedness);
        const completeness = Number(parsed.completeness);
        // Accept either field name — prompt was updated to use answer_quality
        const correctness = Number(parsed.correctness ?? parsed.answer_quality);
        const hallucination = parsed.hallucination === true || parsed.hallucination === 'true';
        const answerableFromContext =
          parsed.answerable_from_context === false ||
            parsed.answerable_from_context === 'false'
            ? false
            : parsed.answerable_from_context === true ||
              parsed.answerable_from_context === 'true'
              ? true
              : undefined;

        if (
          groundedness >= 1 && groundedness <= 5 &&
          completeness >= 1 && completeness <= 5 &&
          correctness >= 1 && correctness <= 5
        ) {
          return { groundedness, completeness, correctness, hallucination, answerableFromContext };
        }
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Classify failure type based on retrieval recall, judge mean score, hallucination,
 * and whether the judge determined the context actually contained the answer.
 *
 * Priority order (higher priority checked first):
 *
 * 0.5. answerableFromContext = false AND hallucination = true AND recallAtK >= RECALL_THRESHOLD
 *    → "hallucination_failure": retrieval was adequate, judge says the invented
 *    claim is not in the context (answerableFromContext=false for the hallucinated
 *    claim), but recall confirms the right docs were retrieved. Root cause is the
 *    model generating false content, not a retrieval gap.
 *
 * 1. answerableFromContext = false
 *    → "retrieval_failure": context never contained the answer.
 *    Note: this fires regardless of recallAtK. Even if the expected docs were
 *    retrieved (high recall), the judge determined they don't actually contain
 *    the answer — the ground-truth labels may be incomplete or the expected docs
 *    are insufficient. Either way the root cause is on the retrieval/data side.
 *
 * 2. hallucination = true AND recallAtK >= RECALL_THRESHOLD
 *    → "hallucination_failure": retrieval was adequate but the model invented
 *    content not present in the context. Distinct from generation_failure (low
 *    quality) — this is a faithfulness failure even when scores look acceptable.
 *
 * 3. recallAtK >= RECALL_THRESHOLD AND judgeMean >= JUDGE_MEAN_THRESHOLD
 *    → "normal": good retrieval and good answer.
 *
 * 4. recallAtK >= RECALL_THRESHOLD AND judgeMean < JUDGE_MEAN_THRESHOLD
 *    → "generation_failure": retrieved the right docs but produced a poor answer.
 *
 * 5. recallAtK < RECALL_THRESHOLD AND judgeMean < JUDGE_MEAN_THRESHOLD
 *    → "retrieval_failure": wrong docs and poor answer — root cause is retrieval.
 *
 * 6. recallAtK < RECALL_THRESHOLD AND judgeMean >= JUDGE_MEAN_THRESHOLD
 *    → "robust_generation": wrong docs but model still produced a decent answer.
 *
 * judgeMean (avg of groundedness + completeness + correctness) is used instead
 * of groundedness alone so that "I don't have information" refusals — which
 * score high on groundedness but low on completeness/correctness — are not
 * incorrectly classified as good generation.
 */
function classifyFailureType(
  recallAtK: number | null,
  judgeMean: number,
  hallucination: boolean = false,
  answerableFromContext?: boolean
): FailureType | null {
  if (recallAtK === null) return null;

  const goodRetrieval = recallAtK >= RECALL_THRESHOLD;

  // Priority 0.5: model hallucinated with adequate retrieval, and the judge
  // correctly flagged the invented claim as not in context. This looks like
  // Priority-1 (answerableFromContext=false) but the root cause is generation,
  // not retrieval — the right docs were retrieved, the model made up content.
  if (answerableFromContext === false && hallucination && goodRetrieval) return 'hallucination_failure';

  // Priority 1: judge explicitly determined the context didn't contain the answer.
  if (answerableFromContext === false) return 'retrieval_failure';

  // Priority 2: model hallucinated despite adequate retrieval — faithfulness failure.
  if (hallucination && goodRetrieval) return 'hallucination_failure';

  const goodGeneration = judgeMean >= JUDGE_MEAN_THRESHOLD;

  if (goodRetrieval && goodGeneration) return 'normal';
  if (goodRetrieval && !goodGeneration) return 'generation_failure';
  if (!goodRetrieval && !goodGeneration) return 'retrieval_failure';
  /* !goodRetrieval && goodGeneration */return 'robust_generation';
}

/**
 * Call the judge LLM once for a single evaluation row
 */
async function callJudgeOnce(
  prompt: string,
  judgeModel: string
): Promise<JudgeScores | null> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: judgeModel,
        prompt,
        stream: false,
        options: {
          temperature: 0,
          top_p: 1,
          num_predict: 200,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Judge LLM error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return parseJudgeResponse(data.response || '');
  } catch (error) {
    console.error('Judge LLM call failed:', error);
    return null;
  }
}

/**
 * Call the judge LLM runCount times and return aggregated scores.
 * Numeric scores are averaged; hallucination uses majority vote.
 */
async function judgeRow(
  row: UnjudgedRow,
  judgeModel: string,
  runCount: number = 3
): Promise<JudgeScores | null> {
  const prompt = JUDGE_PROMPT
    .replace('{question}', row.question)
    .replace('{context}', row.retrieved_context.slice(0, JUDGE_CONTEXT_LENGTH))
    .replace('{answer}', row.generated_answer);

  const results: JudgeScores[] = [];

  for (let i = 0; i < runCount; i++) {
    // Small delay between repeated calls to avoid overloading the model
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const scores = await callJudgeOnce(prompt, judgeModel);
    if (scores) {
      results.push(scores);
    }
  }

  if (results.length === 0) return null;

  // Average numeric scores across all valid runs
  const n = results.length;
  const groundedness = results.reduce((s, r) => s + r.groundedness, 0) / n;
  const completeness = results.reduce((s, r) => s + r.completeness, 0) / n;
  const correctness = results.reduce((s, r) => s + r.correctness, 0) / n;

  // Majority vote for hallucination
  const hallucinationVotes = results.filter((r) => r.hallucination).length;
  const hallucination = hallucinationVotes > n / 2;

  // Majority vote for answerableFromContext — only count runs that had an opinion
  const answerableWithOpinion = results.filter(r => r.answerableFromContext !== undefined);
  let answerableFromContext: boolean | undefined;
  if (answerableWithOpinion.length > 0) {
    const notAnswerableVotes = answerableWithOpinion.filter(r => r.answerableFromContext === false).length;
    answerableFromContext = notAnswerableVotes > answerableWithOpinion.length / 2 ? false : true;
  }

  return { groundedness, completeness, correctness, hallucination, answerableFromContext };
}

/**
 * Run the judge process on unjudged evaluation rows.
 * Returns the number of rows judged.
 */
export async function runJudge(options: {
  batchSize?: number;
  judgeModel?: string;
  maxRows?: number;
  judgeRuns?: number;
} = {}): Promise<{ judged: number; failed: number; total: number }> {
  const {
    batchSize = 20,
    judgeModel = DEFAULT_JUDGE_MODEL,
    maxRows = 200,
    judgeRuns = 3,
  } = options;

  // Select unjudged rows (include retrieved_doc_ids and query_id for recall computation)
  const unjudged = await sql`
    SELECT re.id, re.question, re.retrieved_context, re.generated_answer,
           re.recall_at_k, re.retrieved_doc_ids, re.query_id
    FROM rag_runs_evaluation re
    LEFT JOIN rag_judge_results jr ON jr.evaluation_id = re.id
    WHERE jr.id IS NULL
      AND re.generated_answer NOT LIKE '[Generation failed%'
    ORDER BY re.created_at ASC
    LIMIT ${maxRows}
  ` as UnjudgedRow[];

  if (unjudged.length === 0) {
    return { judged: 0, failed: 0, total: 0 };
  }

  let judged = 0;
  let failed = 0;

  // Process in batches
  for (let i = 0; i < unjudged.length; i += batchSize) {
    const batch = unjudged.slice(i, i + batchSize);

    for (const row of batch) {
      const scores = await judgeRow(row, judgeModel, judgeRuns);

      if (!scores) {
        failed++;
        continue;
      }

      const scoreValues = [scores.groundedness, scores.completeness, scores.correctness];
      const mean = scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length;
      const variance = scoreValues.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / scoreValues.length;
      const std = Math.sqrt(variance);

      // Compute recall if missing
      let recallAtK = row.recall_at_k;
      if (recallAtK === null && row.query_id) {
        const queryRows = await sql`
          SELECT expected_document_ids FROM test_queries WHERE id = ${row.query_id}
        `;
        if (queryRows.length > 0) {
          const expectedIds = queryRows[0].expected_document_ids as string[];
          const retrievedIds = row.retrieved_doc_ids || [];
          if (expectedIds.length > 0) {
            const expectedSet = new Set(expectedIds);
            const hits = retrievedIds.filter(id => expectedSet.has(id)).length;
            recallAtK = hits / expectedIds.length;
          } else {
            recallAtK = 0;
          }
          // Backfill the missing recall_at_k
          await sql`UPDATE rag_runs_evaluation SET recall_at_k = ${recallAtK} WHERE id = ${row.id}`;
        }
      }

      // Belt-and-suspenders: detect refusals by answer text even if LLM missed it.
      // Only override answerableFromContext when retrieval was also poor (low recall).
      // If recall is adequate but the model refused, that is a generation failure —
      // forcing answerableFromContext=false would misclassify it as retrieval_failure.
      if (isRefusalAnswer(row.generated_answer) && (recallAtK === null || recallAtK < RECALL_THRESHOLD)) {
        scores.answerableFromContext = false;
      }

      const failureType = classifyFailureType(recallAtK, mean, scores.hallucination, scores.answerableFromContext);

      // DB columns are integer — round averaged scores before storing.
      // Float precision is preserved in judge_mean (real column).
      // When the context can't answer the question and the model correctly abstained,
      // store all scores as 0 — they carry no generation-quality signal and the
      // judge's Case-C scores (5/5/5) would otherwise inflate metric averages.
      const unanswerable = scores.answerableFromContext === false;
      const gRounded = unanswerable ? 0 : Math.round(scores.groundedness);
      const cmRounded = unanswerable ? 0 : Math.round(scores.completeness);
      const crRounded = unanswerable ? 0 : Math.round(scores.correctness);
      const meanToStore = unanswerable ? 0 : mean;
      const stdToStore = unanswerable ? 0 : std;
      // Store answerableFromContext so repairFailureTypes() can use it without
      // re-calling the judge.
      const answerableToStore = scores.answerableFromContext ?? null;

      await sql`
        INSERT INTO rag_judge_results (
          evaluation_id, groundedness_score, completeness_score, correctness_score,
          hallucination, judge_mean, judge_std, failure_type, answerable_from_context, judge_model
        ) VALUES (
          ${row.id}, ${gRounded}, ${cmRounded}, ${crRounded},
          ${scores.hallucination}, ${meanToStore}, ${stdToStore}, ${failureType}, ${answerableToStore}, ${judgeModel}
        )
      `;

      judged++;
    }

    // Rate limit: small delay between batches
    if (i + batchSize < unjudged.length) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return { judged, failed, total: unjudged.length };
}

/**
 * Repair NULL or mis-classified failure_types in judge results.
 * Uses judge_mean (groundedness + completeness + correctness averaged) as the
 * generation quality signal, which correctly penalises "no information" refusals.
 *
 * Also reclassifies two known wrong patterns from the old groundedness-only logic:
 *   - "robust_generation" with low judge_mean → was a refusal, should be retrieval_failure
 *   - "generation_failure" with recall < 0.5  → root cause is retrieval, not generation
 */
export async function repairFailureTypes(): Promise<{ repaired: number }> {
  const rows = await sql`
    SELECT
      jr.id as judge_id,
      jr.judge_mean,
      jr.failure_type,
      jr.hallucination,
      jr.answerable_from_context,
      re.id as eval_id,
      re.recall_at_k,
      re.retrieved_doc_ids,
      re.query_id
    FROM rag_judge_results jr
    JOIN rag_runs_evaluation re ON jr.evaluation_id = re.id
    WHERE jr.failure_type IS NULL
       OR (jr.failure_type = 'robust_generation'  AND jr.judge_mean < ${JUDGE_MEAN_THRESHOLD})
       OR (jr.failure_type = 'generation_failure' AND re.recall_at_k IS NOT NULL AND re.recall_at_k < ${RECALL_THRESHOLD})
       OR (jr.failure_type IN ('normal', 'generation_failure') AND jr.hallucination = true AND re.recall_at_k >= ${RECALL_THRESHOLD})
       OR (jr.failure_type = 'retrieval_failure' AND jr.hallucination = true AND jr.answerable_from_context = false AND re.recall_at_k IS NOT NULL AND re.recall_at_k >= ${RECALL_THRESHOLD})
       -- Revert any content_gap rows created by the bad bulk reclassification — they are retrieval_failures
       OR jr.failure_type = 'content_gap'
  `;

  if (rows.length === 0) return { repaired: 0 };

  let repaired = 0;

  for (const row of rows) {
    let recallAtK = row.recall_at_k as number | null;

    // If recall_at_k is missing, compute it from stored data
    if (recallAtK === null && row.query_id) {
      const queryRows = await sql`
        SELECT expected_document_ids FROM test_queries WHERE id = ${row.query_id as string}
      `;

      if (queryRows.length > 0) {
        const expectedIds = queryRows[0].expected_document_ids as string[];
        const retrievedIds = row.retrieved_doc_ids as string[];

        if (expectedIds.length > 0 && retrievedIds.length > 0) {
          const expectedSet = new Set(expectedIds);
          const hits = retrievedIds.filter(id => expectedSet.has(id)).length;
          recallAtK = hits / expectedIds.length;

          // Backfill recall_at_k on the evaluation row
          await sql`
            UPDATE rag_runs_evaluation SET recall_at_k = ${recallAtK} WHERE id = ${row.eval_id as string}
          `;
        } else {
          recallAtK = 0;
        }
      }
    }

    // Re-classify using all available signals. answerableFromContext is now
    // stored in the DB; rows judged before that column existed will have NULL,
    // which is treated as undefined (falls through to recall-based logic).
    const answerableFromContext =
      row.answerable_from_context === null ? undefined : Boolean(row.answerable_from_context);
    const failureType = classifyFailureType(
      recallAtK,
      Number(row.judge_mean),
      Boolean(row.hallucination),
      answerableFromContext
    );

    if (failureType !== null && failureType !== (row.failure_type as string)) {
      await sql`
        UPDATE rag_judge_results SET failure_type = ${failureType} WHERE id = ${row.judge_id as string}
      `;
      repaired++;
    }
  }

  return { repaired };
}

/**
 * Get aggregated quality metrics per pipeline
 */
export async function getQualityMetrics(): Promise<Record<string, {
  meanGroundedness: number;
  meanCorrectness: number;
  meanCompleteness: number;
  hallucinationRate: number;
  judgeMean: number;
  totalJudged: number;
  failureBreakdown: Record<string, number>;
}>> {
  const rows = await sql`
    SELECT
      re.pipeline_name,
      -- NULLIF(..., 0) excludes unanswerable rows (score=0) from averages
      AVG(NULLIF(jr.groundedness_score, 0)) as mean_groundedness,
      AVG(NULLIF(jr.correctness_score, 0)) as mean_correctness,
      AVG(NULLIF(jr.completeness_score, 0)) as mean_completeness,
      AVG(CASE WHEN jr.hallucination THEN 1.0 ELSE 0.0 END) FILTER (WHERE jr.judge_mean > 0) as hallucination_rate,
      AVG(NULLIF(jr.judge_mean, 0)) as judge_mean,
      COUNT(*) FILTER (WHERE jr.judge_mean > 0) as total_judged,
      COUNT(CASE WHEN jr.failure_type = 'generation_failure'    THEN 1 END) as gen_failures,
      COUNT(CASE WHEN jr.failure_type = 'retrieval_failure'     THEN 1 END) as ret_failures,
      COUNT(CASE WHEN jr.failure_type = 'robust_generation'     THEN 1 END) as robust_gen,
      COUNT(CASE WHEN jr.failure_type = 'normal'                THEN 1 END) as normal,
      COUNT(CASE WHEN jr.failure_type = 'hallucination_failure' THEN 1 END) as halluc_failures,
      COUNT(CASE WHEN jr.failure_type IS NULL                   THEN 1 END) as unclassified
    FROM rag_judge_results jr
    JOIN rag_runs_evaluation re ON jr.evaluation_id = re.id
    GROUP BY re.pipeline_name
    ORDER BY re.pipeline_name
  `;

  const result: Record<string, {
    meanGroundedness: number;
    meanCorrectness: number;
    meanCompleteness: number;
    hallucinationRate: number;
    judgeMean: number;
    totalJudged: number;
    failureBreakdown: Record<string, number>;
  }> = {};

  for (const row of rows) {
    result[row.pipeline_name as string] = {
      meanGroundedness: Number(row.mean_groundedness) || 0,
      meanCorrectness: Number(row.mean_correctness) || 0,
      meanCompleteness: Number(row.mean_completeness) || 0,
      hallucinationRate: Number(row.hallucination_rate) || 0,
      judgeMean: Number(row.judge_mean) || 0,
      totalJudged: Number(row.total_judged) || 0,
      failureBreakdown: {
        normal: Number(row.normal) || 0,
        generation_failure: Number(row.gen_failures) || 0,
        retrieval_failure: Number(row.ret_failures) || 0,
        robust_generation: Number(row.robust_gen) || 0,
        hallucination_failure: Number(row.halluc_failures) || 0,
        unclassified: Number(row.unclassified) || 0,
      },
    };
  }

  return result;
}

/**
 * Get detailed judge results for a specific run
 */
export async function getJudgeResultsForRun(runId: string): Promise<Array<{
  question: string;
  pipelineName: string;
  generatedAnswer: string;
  groundedness: number;
  completeness: number;
  correctness: number;
  hallucination: boolean;
  failureType: string | null;
  recallAtK: number | null;
}>> {
  const rows = await sql`
    SELECT
      re.question,
      re.pipeline_name,
      re.generated_answer,
      re.recall_at_k,
      jr.groundedness_score,
      jr.completeness_score,
      jr.correctness_score,
      jr.hallucination,
      jr.failure_type
    FROM rag_judge_results jr
    JOIN rag_runs_evaluation re ON jr.evaluation_id = re.id
    WHERE re.run_id = ${runId}
    ORDER BY re.pipeline_name, re.question
  `;

  return rows.map(r => ({
    question: r.question as string,
    pipelineName: r.pipeline_name as string,
    generatedAnswer: r.generated_answer as string,
    groundedness: Number(r.groundedness_score),
    completeness: Number(r.completeness_score),
    correctness: Number(r.correctness_score),
    hallucination: r.hallucination as boolean,
    failureType: r.failure_type as string | null,
    recallAtK: r.recall_at_k as number | null,
  }));
}

export interface JudgeDetailRow {
  id: string;
  question: string;
  pipelineName: string;
  generatedAnswer: string;
  retrievedContext: string;
  groundedness: number;
  completeness: number;
  correctness: number;
  hallucination: boolean;
  failureType: string | null;
  recallAtK: number | null;
  judgeMean: number;
}

/**
 * Get all judged rows with failure details, optionally filtered.
 *
 * Uses sql.unsafe with explicit parameter arrays to avoid postgres.js dynamic
 * fragment interpolation issues (dynamic sql`...` fragments in WHERE clauses
 * return 0 rows despite valid data existing).
 */
export async function getJudgeDetails(options: {
  failureType?: string;
  pipeline?: string;
  runId?: string;
  limit?: number;
} = {}): Promise<JudgeDetailRow[]> {
  const { failureType, pipeline, runId, limit = 200 } = options;

  const whereParts: string[] = [];
  const params: (string | number)[] = [];

  if (failureType === 'unclassified') {
    whereParts.push('jr.failure_type IS NULL');
  } else if (failureType) {
    params.push(failureType);
    whereParts.push(`jr.failure_type = $${params.length}`);
  }

  if (pipeline) {
    params.push(pipeline);
    whereParts.push(`re.pipeline_name = $${params.length}`);
  }

  if (runId) {
    params.push(runId);
    whereParts.push(`re.run_id = $${params.length}`);
  }

  params.push(limit);
  const limitPlaceholder = `$${params.length}`;

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const query = `
    SELECT
      jr.id,
      re.question,
      re.pipeline_name,
      re.generated_answer,
      re.retrieved_context,
      re.recall_at_k,
      jr.groundedness_score,
      jr.completeness_score,
      jr.correctness_score,
      jr.hallucination,
      jr.failure_type,
      jr.judge_mean
    FROM rag_judge_results jr
    JOIN rag_runs_evaluation re ON jr.evaluation_id = re.id
    ${whereClause}
    ORDER BY re.pipeline_name, re.question
    LIMIT ${limitPlaceholder}
  `;

  const rows = await sql.unsafe(query, params);

  return rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    question: r.question as string,
    pipelineName: r.pipeline_name as string,
    generatedAnswer: (r.generated_answer as string).slice(0, 500),
    retrievedContext: r.retrieved_context as string,
    groundedness: Number(r.groundedness_score),
    completeness: Number(r.completeness_score),
    correctness: Number(r.correctness_score),
    hallucination: r.hallucination as boolean,
    failureType: r.failure_type as string | null,
    recallAtK: r.recall_at_k as number | null,
    judgeMean: Number(r.judge_mean),
  }));
}

export interface QualityMetrics {
  meanGroundedness: number;
  meanCorrectness: number;
  meanCompleteness: number;
  hallucinationRate: number;
  judgeMean: number;
  totalJudged: number;
  failureBreakdown: Record<string, number>;
}

/**
 * Get aggregated quality metrics per pipeline for a specific evaluation run
 */
export async function getQualityMetricsByRun(runId: string): Promise<Record<string, QualityMetrics>> {
  const rows = await sql`
    SELECT
      re.pipeline_name,
      -- NULLIF(..., 0) excludes unanswerable rows (score=0) from averages
      AVG(NULLIF(jr.groundedness_score, 0)) as mean_groundedness,
      AVG(NULLIF(jr.correctness_score, 0)) as mean_correctness,
      AVG(NULLIF(jr.completeness_score, 0)) as mean_completeness,
      AVG(CASE WHEN jr.hallucination THEN 1.0 ELSE 0.0 END) FILTER (WHERE jr.judge_mean > 0) as hallucination_rate,
      AVG(NULLIF(jr.judge_mean, 0)) as judge_mean,
      COUNT(*) FILTER (WHERE jr.judge_mean > 0) as total_judged,
      COUNT(CASE WHEN jr.failure_type = 'generation_failure'    THEN 1 END) as gen_failures,
      COUNT(CASE WHEN jr.failure_type = 'retrieval_failure'     THEN 1 END) as ret_failures,
      COUNT(CASE WHEN jr.failure_type = 'robust_generation'     THEN 1 END) as robust_gen,
      COUNT(CASE WHEN jr.failure_type = 'normal'                THEN 1 END) as normal,
      COUNT(CASE WHEN jr.failure_type = 'hallucination_failure' THEN 1 END) as halluc_failures,
      COUNT(CASE WHEN jr.failure_type IS NULL                   THEN 1 END) as unclassified
    FROM rag_judge_results jr
    JOIN rag_runs_evaluation re ON jr.evaluation_id = re.id
    WHERE re.run_id = ${runId}
    GROUP BY re.pipeline_name
    ORDER BY re.pipeline_name
  `;

  const result: Record<string, QualityMetrics> = {};
  for (const row of rows) {
    result[row.pipeline_name as string] = {
      meanGroundedness: Number(row.mean_groundedness) || 0,
      meanCorrectness: Number(row.mean_correctness) || 0,
      meanCompleteness: Number(row.mean_completeness) || 0,
      hallucinationRate: Number(row.hallucination_rate) || 0,
      judgeMean: Number(row.judge_mean) || 0,
      totalJudged: Number(row.total_judged) || 0,
      failureBreakdown: {
        normal: Number(row.normal) || 0,
        generation_failure: Number(row.gen_failures) || 0,
        retrieval_failure: Number(row.ret_failures) || 0,
        robust_generation: Number(row.robust_gen) || 0,
        hallucination_failure: Number(row.halluc_failures) || 0,
        unclassified: Number(row.unclassified) || 0,
      },
    };
  }
  return result;
}

interface RunSnapshot {
  runId: string;
  runName: string | null;
  startedAt: string;
  metrics: Record<string, QualityMetrics>;
}

/**
 * Compare the two most recent evaluation runs that have judge results.
 * Returns { current, previous } where current is the newer run.
 */
export async function getQualityComparison(): Promise<{
  current: RunSnapshot | null;
  previous: RunSnapshot | null;
}> {
  const runs = await sql`
    SELECT DISTINCT er.id, er.name, er.started_at
    FROM evaluation_runs er
    JOIN rag_runs_evaluation re ON re.run_id = er.id
    JOIN rag_judge_results jr ON jr.evaluation_id = re.id
    ORDER BY er.started_at DESC
    LIMIT 2
  `;

  if (runs.length === 0) {
    return { current: null, previous: null };
  }

  const snapshots: RunSnapshot[] = await Promise.all(
    runs.map(async (r) => ({
      runId: r.id as string,
      runName: r.name as string | null,
      startedAt: r.started_at instanceof Date ? r.started_at.toISOString() : String(r.started_at),
      metrics: await getQualityMetricsByRun(r.id as string),
    }))
  );

  return {
    current: snapshots[0] ?? null,
    previous: snapshots[1] ?? null,
  };
}
