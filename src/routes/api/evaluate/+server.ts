/**
 * Evaluate API Endpoint
 *
 * POST /api/evaluate
 * Run evaluation against test queries for all pipelines.
 * Calculates proper IR metrics (Recall@K, MRR, nDCG, Hit@K) when expectedDocumentIds exist.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hybridSearch } from '$lib/server/pipeline/traditional/retriever';
import { searchFacts } from '$lib/server/pipeline/facts/retriever';
import { searchLLMChunks } from '$lib/server/pipeline/llm/retriever';
import {
  measureLatency,
  calculateRecallAtK,
  calculatePrecisionAtK,
  calculateMRR,
  calculateNDCGBinary,
  calculateHitAtK,
  calculateDocumentCoverage,
  calculateSourceDiversity,
  calculateLLMCompressionRatio,
  calculateFactCompressionRatio,
  calculateLatencyStats,
} from '$lib/server/evaluation/metrics';
import { embedBatchDense, cosineSimilarity } from '$lib/server/embeddings/bge-m3';
import { rerank } from '$lib/server/reranker';
import { sql } from '$lib/server/db/client';
import type { EvaluationConfig, SearchResult, QueryMetrics, PipelineMetrics, DocumentCoverageMetrics, CompressionMetrics } from '$lib/types';

import { generate, DEFAULT_MODEL } from '$lib/server/llm/client';

const MAX_CONTEXT_LENGTH = 8000; // Truncate context to prevent overly large prompts

interface PipelineResult {
  results: SearchResult[];
  latencyMs: number;
  avgScore: number;
  metrics: QueryMetrics;
}

interface QueryComparison {
  query: string;
  expectedDocumentIds: string[];
  chunk?: PipelineResult;
  fact?: PipelineResult;
  llm?: PipelineResult;
  overlap: {
    chunkFact: number;
    chunkLlm: number;
    factLlm: number;
  };
}

/**
 * Calculate IR metrics for a single query
 */
function calculateIRMetrics(retrievedIds: string[], expectedIds: string[], topK: number): QueryMetrics {
  return {
    recall: calculateRecallAtK(retrievedIds, expectedIds, topK),
    recallAt5: calculateRecallAtK(retrievedIds, expectedIds, 5),
    recallAt10: calculateRecallAtK(retrievedIds, expectedIds, 10),
    mrr: calculateMRR(retrievedIds, expectedIds),
    ndcg: calculateNDCGBinary(retrievedIds, expectedIds, topK),
    precision: calculatePrecisionAtK(retrievedIds, expectedIds, topK),
    hitAt1: calculateHitAtK(retrievedIds, expectedIds, 1),
    hitAt5: calculateHitAtK(retrievedIds, expectedIds, 5),
    hitAt10: calculateHitAtK(retrievedIds, expectedIds, 10),
  };
}

/**
 * Calculate overlap between two result sets (Jaccard similarity on document IDs)
 */
function calculateOverlap(results1: SearchResult[], results2: SearchResult[]): number {
  if (results1.length === 0 || results2.length === 0) return 0;

  const docIds1 = new Set(results1.map(r => r.documentId));
  const docIds2 = new Set(results2.map(r => r.documentId));

  const intersection = [...docIds1].filter(id => docIds2.has(id)).length;
  const union = new Set([...docIds1, ...docIds2]).size;

  return union > 0 ? intersection / union : 0;
}

/**
 * Calculate embedding similarity between two result sets
 */
async function calculateEmbeddingSimilarity(
  results1: SearchResult[],
  results2: SearchResult[]
): Promise<number> {
  if (results1.length === 0 || results2.length === 0) return 0;

  const contents1 = results1.map(r => r.content);
  const contents2 = results2.map(r => r.content);

  const embeddings1 = await embedBatchDense(contents1);
  const embeddings2 = await embedBatchDense(contents2);

  // Average pairwise cosine similarity
  let totalSim = 0;
  let count = 0;

  for (const emb1 of embeddings1) {
    for (const emb2 of embeddings2) {
      totalSim += cosineSimilarity(emb1, emb2);
      count++;
    }
  }

  return count > 0 ? totalSim / count : 0;
}

/**
 * Generate an answer using Ollama given a question and retrieved context
 */
async function generateAnswer(
  question: string,
  context: string,
  model: string
): Promise<string> {
  try {
    const truncatedContext = context.length > MAX_CONTEXT_LENGTH
      ? context.slice(0, MAX_CONTEXT_LENGTH) + '\n...[truncated]'
      : context;

    return await generate({
      model,
      prompt: `Answer the following question using ONLY the provided context. Use all relevant information the context contains. If a specific detail is not present, answer based on what is available.\n\nContext:\n${truncatedContext}\n\nQuestion: ${question}\n\nAnswer:`,
      temperature: 0.3,
      topP: 0.9,
      maxTokens: 512,
    });
  } catch (error) {
    console.error('Answer generation error:', error);
    return '[Generation failed: ' + (error instanceof Error ? error.message : 'unknown error') + ']';
  }
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const {
      name,
      topK = 10,
      rerank: shouldRerank = false,
      rerankThreshold = 0.3,
      generateAnswers = true,
      model = DEFAULT_MODEL,
      pipelines: selectedPipelines,
    } = body;

    const ALL_PIPELINES = ['chunk', 'fact', 'llm'] as const;
    const activePipelines = new Set<string>(
      Array.isArray(selectedPipelines) && selectedPipelines.length > 0
        ? selectedPipelines.filter((p: string) => (ALL_PIPELINES as readonly string[]).includes(p))
        : ALL_PIPELINES
    );

    // Get test queries with expected document IDs
    const testQueries = await sql`
      SELECT id, query, category, difficulty, expected_document_ids
      FROM test_queries
      ORDER BY created_at
    `;

    if (testQueries.length === 0) {
      return json({ error: 'No test queries found. Add test queries first.' }, { status: 400 });
    }

    const config: EvaluationConfig = {
      topK,
      rerank: shouldRerank,
      rerankThreshold,
    };

    // Create evaluation run
    const runResult = await sql`
      INSERT INTO evaluation_runs (name, pipeline, config, status)
      VALUES (${name || null}, ${[...activePipelines].join(',')}, ${JSON.stringify(config)}, 'running')
      RETURNING id
    `;
    const runId = runResult[0].id as string;

    // Run evaluation for all pipelines
    const comparisons: QueryComparison[] = [];

    // Track metrics per pipeline for aggregation
    const chunkMetrics: QueryMetrics[] = [];
    const factMetrics: QueryMetrics[] = [];
    const llmMetrics: QueryMetrics[] = [];
    const chunkLatencies: number[] = [];
    const factLatencies: number[] = [];
    const llmLatencies: number[] = [];
    const chunkScores: number[] = [];
    const factScores: number[] = [];
    const llmScores: number[] = [];

    // Track new metrics
    const chunkDiversities: number[] = [];
    const factDiversities: number[] = [];
    const llmDiversities: number[] = [];
    const chunkCoverages: DocumentCoverageMetrics[] = [];
    const factCoverages: DocumentCoverageMetrics[] = [];
    const llmCoverages: DocumentCoverageMetrics[] = [];
    const factCompressions: CompressionMetrics[] = [];
    const llmCompressions: CompressionMetrics[] = [];
    const embeddingOverlaps: { chunkFact: number; chunkLlm: number; factLlm: number }[] = [];

    for (const testQuery of testQueries) {
      const query = testQuery.query as string;
      const queryId = testQuery.id as string;
      // Parse expected document IDs - could be array or JSON string
      let expectedDocIds: string[] = [];
      if (testQuery.expected_document_ids) {
        if (Array.isArray(testQuery.expected_document_ids)) {
          expectedDocIds = testQuery.expected_document_ids as string[];
        } else if (typeof testQuery.expected_document_ids === 'string') {
          try {
            expectedDocIds = JSON.parse(testQuery.expected_document_ids as string);
          } catch {
            expectedDocIds = [];
          }
        }
      }

      // Run selected pipelines in parallel with error isolation
      type PipelineRun = { result: SearchResult[]; latencyMs: number };
      const safePipelineRun = (pName: string, fn: () => Promise<SearchResult[]>): Promise<PipelineRun> =>
        measureLatency(async () => {
          try {
            return await fn();
          } catch (error) {
            console.error(`${pName} pipeline failed for query "${query}":`, error);
            return [] as SearchResult[];
          }
        });
      const skipPipeline: PipelineRun = { result: [], latencyMs: 0 };

      const [chunkResult, factResult, llmResult] = await Promise.all([
        activePipelines.has('chunk')
          ? safePipelineRun('chunk', async () => {
              let results = await hybridSearch(query, { topK: topK * 2 });
              if (shouldRerank) results = await rerank(query, results, { topK, threshold: rerankThreshold });
              return results.slice(0, topK);
            })
          : Promise.resolve(skipPipeline),
        activePipelines.has('fact')
          ? safePipelineRun('fact', async () => {
              // Facts are sentence-level and far more granular than chunks.
              // A 4× pool gives vector search a better chance of surfacing facts
              // that cover all sub-parts of the answer, not just the top-ranked sentence.
              let results = await searchFacts(query, { topK: topK * 4 });
              if (shouldRerank) results = await rerank(query, results, { topK, threshold: rerankThreshold });
              return results.slice(0, topK);
            })
          : Promise.resolve(skipPipeline),
        activePipelines.has('llm')
          ? safePipelineRun('llm', async () => {
              let results = await searchLLMChunks(query, { topK: topK * 2 });
              if (shouldRerank) results = await rerank(query, results, { topK, threshold: rerankThreshold });
              return results.slice(0, topK);
            })
          : Promise.resolve(skipPipeline),
      ]);

      // Get unique retrieved document IDs (deduplicate - multiple chunks can be from same doc)
      const chunkRetrievedIds = [...new Set(chunkResult.result.map(r => r.documentId))];
      const factRetrievedIds = [...new Set(factResult.result.map(r => r.documentId))];
      const llmRetrievedIds = [...new Set(llmResult.result.map(r => r.documentId))];

      // Calculate IR metrics only for active pipelines
      const chunkQueryMetrics = activePipelines.has('chunk') ? calculateIRMetrics(chunkRetrievedIds, expectedDocIds, topK) : null;
      const factQueryMetrics  = activePipelines.has('fact')  ? calculateIRMetrics(factRetrievedIds,  expectedDocIds, topK) : null;
      const llmQueryMetrics   = activePipelines.has('llm')   ? calculateIRMetrics(llmRetrievedIds,   expectedDocIds, topK) : null;

      // Track for aggregation (only active pipelines)
      if (chunkQueryMetrics) chunkMetrics.push(chunkQueryMetrics);
      if (factQueryMetrics)  factMetrics.push(factQueryMetrics);
      if (llmQueryMetrics)   llmMetrics.push(llmQueryMetrics);

      // Calculate overlaps (Jaccard similarity) — only when both pipelines are active
      const overlap = {
        chunkFact: (activePipelines.has('chunk') && activePipelines.has('fact'))
          ? calculateOverlap(chunkResult.result, factResult.result) : 0,
        chunkLlm:  (activePipelines.has('chunk') && activePipelines.has('llm'))
          ? calculateOverlap(chunkResult.result, llmResult.result) : 0,
        factLlm:   (activePipelines.has('fact')  && activePipelines.has('llm'))
          ? calculateOverlap(factResult.result, llmResult.result) : 0,
      };

      // Calculate document coverage + diversity + compression (only for active pipelines)
      if (activePipelines.has('chunk')) {
        chunkCoverages.push(calculateDocumentCoverage(chunkResult.result, expectedDocIds));
        chunkDiversities.push(calculateSourceDiversity(chunkResult.result, topK));
        chunkLatencies.push(chunkResult.latencyMs);
        const s = chunkResult.result.reduce((sum, r) => sum + r.score, 0);
        if (chunkResult.result.length > 0) chunkScores.push(s / chunkResult.result.length);
      }
      if (activePipelines.has('fact')) {
        factCoverages.push(calculateDocumentCoverage(factResult.result, expectedDocIds));
        factDiversities.push(calculateSourceDiversity(factResult.result, topK));
        factCompressions.push(calculateFactCompressionRatio(factResult.result));
        factLatencies.push(factResult.latencyMs);
        const s = factResult.result.reduce((sum, r) => sum + r.score, 0);
        if (factResult.result.length > 0) factScores.push(s / factResult.result.length);
      }
      if (activePipelines.has('llm')) {
        llmCoverages.push(calculateDocumentCoverage(llmResult.result, expectedDocIds));
        llmDiversities.push(calculateSourceDiversity(llmResult.result, topK));
        llmCompressions.push(calculateLLMCompressionRatio(llmResult.result));
        llmLatencies.push(llmResult.latencyMs);
        const s = llmResult.result.reduce((sum, r) => sum + r.score, 0);
        if (llmResult.result.length > 0) llmScores.push(s / llmResult.result.length);
      }

      // Calculate embedding similarity — only when both pipelines are active
      const [embChunkFact, embChunkLlm, embFactLlm] = await Promise.all([
        (activePipelines.has('chunk') && activePipelines.has('fact'))
          ? calculateEmbeddingSimilarity(chunkResult.result, factResult.result) : Promise.resolve(0),
        (activePipelines.has('chunk') && activePipelines.has('llm'))
          ? calculateEmbeddingSimilarity(chunkResult.result, llmResult.result) : Promise.resolve(0),
        (activePipelines.has('fact')  && activePipelines.has('llm'))
          ? calculateEmbeddingSimilarity(factResult.result, llmResult.result)  : Promise.resolve(0),
      ]);
      embeddingOverlaps.push({ chunkFact: embChunkFact, chunkLlm: embChunkLlm, factLlm: embFactLlm });

      const avgChunkScore = chunkScores.at(-1) ?? 0;
      const avgFactScore  = factScores.at(-1) ?? 0;
      const avgLlmScore   = llmScores.at(-1) ?? 0;

      comparisons.push({
        query,
        expectedDocumentIds: expectedDocIds,
        ...(activePipelines.has('chunk') && chunkQueryMetrics ? { chunk: { results: chunkResult.result, latencyMs: chunkResult.latencyMs, avgScore: avgChunkScore, metrics: chunkQueryMetrics } } : {}),
        ...(activePipelines.has('fact')  && factQueryMetrics  ? { fact:  { results: factResult.result,  latencyMs: factResult.latencyMs,  avgScore: avgFactScore,  metrics: factQueryMetrics  } } : {}),
        ...(activePipelines.has('llm')   && llmQueryMetrics   ? { llm:   { results: llmResult.result,   latencyMs: llmResult.latencyMs,   avgScore: avgLlmScore,   metrics: llmQueryMetrics   } } : {}),
        overlap,
      });

      // Store results for each active pipeline with full metrics
      const storeResult = async (pipeline: string, result: { result: SearchResult[]; latencyMs: number }, metrics: QueryMetrics) => {
        await sql`
          INSERT INTO evaluation_results (run_id, query_id, pipeline, retrieved_ids, scores, metrics, latency_ms)
          VALUES (
            ${runId},
            ${queryId},
            ${pipeline},
            ${JSON.stringify(result.result.map(r => r.documentId))},
            ${JSON.stringify(result.result.map(r => r.score))},
            ${JSON.stringify(metrics)},
            ${result.latencyMs}
          )
        `;
      };

      await Promise.all([
        ...(activePipelines.has('chunk') && chunkQueryMetrics ? [storeResult('chunk', chunkResult, chunkQueryMetrics)] : []),
        ...(activePipelines.has('fact')  && factQueryMetrics  ? [storeResult('fact',  factResult,  factQueryMetrics)]  : []),
        ...(activePipelines.has('llm')   && llmQueryMetrics   ? [storeResult('llm',   llmResult,   llmQueryMetrics)]   : []),
      ]);

      // Generate answers and log to rag_runs_evaluation (only active pipelines)
      if (generateAnswers) {
        const activePipelineRuns = [
          activePipelines.has('chunk') && chunkQueryMetrics ? { name: 'chunk' as const, result: chunkResult, metrics: chunkQueryMetrics, ids: chunkRetrievedIds } : null,
          activePipelines.has('fact')  && factQueryMetrics  ? { name: 'fact'  as const, result: factResult,  metrics: factQueryMetrics,  ids: factRetrievedIds  } : null,
          activePipelines.has('llm')   && llmQueryMetrics   ? { name: 'llm'   as const, result: llmResult,   metrics: llmQueryMetrics,   ids: llmRetrievedIds   } : null,
        ].filter((p): p is NonNullable<typeof p> => p !== null);

        for (const p of activePipelineRuns) {
          // For the fact pipeline, sort retrieved facts by (documentId, factIndex) before
          // assembling context. Score-order interleaves facts from different documents,
          // producing an incoherent mosaic. Grouping by document and sequential position
          // creates coherent mini-passages that the LLM and judge can reason about.
          const contextResults = p.name === 'fact'
            ? [...p.result.result].sort((a, b) => {
                if (a.documentId !== b.documentId) return a.documentId.localeCompare(b.documentId);
                const ai = (a.metadata as Record<string, unknown>).factIndex as number ?? 0;
                const bi = (b.metadata as Record<string, unknown>).factIndex as number ?? 0;
                return ai - bi;
              })
            : p.result.result;

          const context = contextResults.map((r, i) => `[${i + 1}] ${r.content}`).join('\n\n');
          const truncatedContext = context.length > MAX_CONTEXT_LENGTH
            ? context.slice(0, MAX_CONTEXT_LENGTH) + '\n...[truncated]'
            : context;

          let answer = '';
          try {
            answer = await generateAnswer(query, context, model);
          } catch {
            answer = '[Generation failed]';
          }

          await sql`
            INSERT INTO rag_runs_evaluation (
              run_id, query_id, pipeline_name, question,
              retrieved_doc_ids, retrieved_context, generated_answer,
              top_k, rerank_enabled, model_name,
              recall_at_k, ndcg, mrr, latency_ms
            ) VALUES (
              ${runId}, ${queryId}, ${p.name}, ${query},
              ${JSON.stringify(p.ids)}, ${truncatedContext}, ${answer},
              ${topK}, ${shouldRerank}, ${model},
              ${p.metrics.recall}, ${p.metrics.ndcg}, ${p.metrics.mrr}, ${p.result.latencyMs}
            )
          `;
        }
      }
    }

    // Calculate aggregate metrics for each pipeline
    const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const aggregatePipelineMetrics = (
      metrics: QueryMetrics[],
      latencies: number[],
      scores: number[],
      diversities: number[],
      coverages: DocumentCoverageMetrics[],
      compressions?: CompressionMetrics[]
    ): PipelineMetrics => ({
      recallAt5: avg(metrics.map(m => m.recallAt5)),
      recallAt10: avg(metrics.map(m => m.recallAt10)),
      mrr: avg(metrics.map(m => m.mrr)),
      ndcg: avg(metrics.map(m => m.ndcg)),
      hitAt1: avg(metrics.map(m => m.hitAt1)),
      hitAt5: avg(metrics.map(m => m.hitAt5)),
      hitAt10: avg(metrics.map(m => m.hitAt10)),
      avgLatencyMs: Math.round(avg(latencies)),
      avgScore: avg(scores),
      queryCount: metrics.length,
      // New metrics
      sourceDiversity: avg(diversities),
      documentCoverage: {
        avgChunksPerExpectedDoc: avg(coverages.map(c => c.avgChunksPerExpectedDoc)),
        percentDocsWithMultipleChunks: avg(coverages.map(c => c.percentDocsWithMultipleChunks)),
      },
      compression: compressions ? {
        avgCompressionRatio: avg(compressions.map(c => c.avgCompressionRatio)),
        minCompressionRatio: Math.min(...compressions.map(c => c.minCompressionRatio)),
        maxCompressionRatio: Math.max(...compressions.map(c => c.maxCompressionRatio)),
      } : undefined,
      latencyStats: calculateLatencyStats(latencies),
    });

    const aggregatedMetrics: Record<string, unknown> = {
      ...(activePipelines.has('chunk') && chunkMetrics.length > 0 ? { chunk: aggregatePipelineMetrics(chunkMetrics, chunkLatencies, chunkScores, chunkDiversities, chunkCoverages) } : {}),
      ...(activePipelines.has('fact')  && factMetrics.length  > 0 ? { fact:  aggregatePipelineMetrics(factMetrics,  factLatencies,  factScores,  factDiversities,  factCoverages,  factCompressions) } : {}),
      ...(activePipelines.has('llm')   && llmMetrics.length   > 0 ? { llm:   aggregatePipelineMetrics(llmMetrics,   llmLatencies,   llmScores,   llmDiversities,   llmCoverages,   llmCompressions) }  : {}),
      overlap: {
        avgChunkFact: avg(comparisons.map(c => c.overlap.chunkFact)),
        avgChunkLlm: avg(comparisons.map(c => c.overlap.chunkLlm)),
        avgFactLlm: avg(comparisons.map(c => c.overlap.factLlm)),
        // Embedding similarity
        embeddingChunkFact: avg(embeddingOverlaps.map(e => e.chunkFact)),
        embeddingChunkLlm: avg(embeddingOverlaps.map(e => e.chunkLlm)),
        embeddingFactLlm: avg(embeddingOverlaps.map(e => e.factLlm)),
      },
    };

    // Update run with aggregated metrics
    await sql`
      UPDATE evaluation_runs
      SET metrics = ${JSON.stringify(aggregatedMetrics)},
          status = 'completed',
          completed_at = NOW()
      WHERE id = ${runId}
    `;

    return json({
      runId,
      status: 'completed',
      queryCount: testQueries.length,
      metrics: aggregatedMetrics,
      comparisons,
    });
  } catch (error) {
    console.error('Evaluation error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};

/**
 * GET /api/evaluate
 * Get all evaluation runs
 */
export const GET: RequestHandler = async () => {
  try {
    const rows = await sql`
      SELECT id, name, pipeline, config, metrics, status, started_at, completed_at
      FROM evaluation_runs
      ORDER BY started_at DESC
      LIMIT 50
    `;

    // Map snake_case to camelCase for frontend compatibility
    const runs = rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      name: row.name,
      pipeline: row.pipeline,
      config: row.config,
      metrics: row.metrics,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));

    return json({ runs });
  } catch (error) {
    console.error('Get evaluations error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
