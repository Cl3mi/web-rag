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
import { env } from '$env/dynamic/private';
import type { EvaluationConfig, SearchResult, QueryMetrics, PipelineMetrics, DocumentCoverageMetrics, CompressionMetrics } from '$lib/types';

const OLLAMA_BASE_URL = env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = env.OLLAMA_MODEL || 'llama3.2';

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

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: `Answer the following question using ONLY the provided context. Use all relevant information the context contains. If a specific detail is not present, answer based on what is available.\n\nContext:\n${truncatedContext}\n\nQuestion: ${question}\n\nAnswer:`,
        stream: false,
        options: {
          temperature: 0.3,
          top_p: 0.9,
          num_predict: 512,
        },
      }),
    });

    if (!response.ok) {
      return '[Generation failed: Ollama returned ' + response.status + ']';
    }

    const data = await response.json();
    return (data.response || '').trim();
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
    } = body;

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
      VALUES (${name || null}, 'all', ${JSON.stringify(config)}, 'running')
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

      // Run all three pipelines in parallel with error isolation
      const safePipelineRun = (name: string, fn: () => Promise<SearchResult[]>) =>
        measureLatency(async () => {
          try {
            return await fn();
          } catch (error) {
            console.error(`${name} pipeline failed for query "${query}":`, error);
            return [] as SearchResult[];
          }
        });

      const [chunkResult, factResult, llmResult] = await Promise.all([
        safePipelineRun('chunk', async () => {
          let results = await hybridSearch(query, { topK: topK * 2 });
          if (shouldRerank) {
            results = await rerank(query, results, { topK, threshold: rerankThreshold });
          }
          return results.slice(0, topK);
        }),
        safePipelineRun('fact', async () => {
          // Facts are sentence-level and far more granular than chunks.
          // A 4× pool gives vector search a better chance of surfacing facts
          // that cover all sub-parts of the answer, not just the top-ranked sentence.
          let results = await searchFacts(query, { topK: topK * 4 });
          if (shouldRerank) {
            results = await rerank(query, results, { topK, threshold: rerankThreshold });
          }
          return results.slice(0, topK);
        }),
        safePipelineRun('llm', async () => {
          let results = await searchLLMChunks(query, { topK: topK * 2 });
          if (shouldRerank) {
            results = await rerank(query, results, { topK, threshold: rerankThreshold });
          }
          return results.slice(0, topK);
        }),
      ]);

      // Get unique retrieved document IDs (deduplicate - multiple chunks can be from same doc)
      const chunkRetrievedIds = [...new Set(chunkResult.result.map(r => r.documentId))];
      const factRetrievedIds = [...new Set(factResult.result.map(r => r.documentId))];
      const llmRetrievedIds = [...new Set(llmResult.result.map(r => r.documentId))];

      // Calculate IR metrics for each pipeline
      const chunkQueryMetrics = calculateIRMetrics(chunkRetrievedIds, expectedDocIds, topK);
      const factQueryMetrics = calculateIRMetrics(factRetrievedIds, expectedDocIds, topK);
      const llmQueryMetrics = calculateIRMetrics(llmRetrievedIds, expectedDocIds, topK);

      // Track for aggregation
      chunkMetrics.push(chunkQueryMetrics);
      factMetrics.push(factQueryMetrics);
      llmMetrics.push(llmQueryMetrics);

      // Calculate overlaps (Jaccard similarity on chunk IDs)
      const overlap = {
        chunkFact: calculateOverlap(chunkResult.result, factResult.result),
        chunkLlm: calculateOverlap(chunkResult.result, llmResult.result),
        factLlm: calculateOverlap(factResult.result, llmResult.result),
      };

      // Calculate document coverage
      const chunkCoverage = calculateDocumentCoverage(chunkResult.result, expectedDocIds);
      const factCoverage = calculateDocumentCoverage(factResult.result, expectedDocIds);
      const llmCoverage = calculateDocumentCoverage(llmResult.result, expectedDocIds);

      // Calculate source diversity
      const chunkDiversity = calculateSourceDiversity(chunkResult.result, topK);
      const factDiversity = calculateSourceDiversity(factResult.result, topK);
      const llmDiversity = calculateSourceDiversity(llmResult.result, topK);

      // Calculate compression (fact and llm only)
      const factCompression = calculateFactCompressionRatio(factResult.result);
      const llmCompression = calculateLLMCompressionRatio(llmResult.result);

      // Calculate embedding similarity (async)
      const [embChunkFact, embChunkLlm, embFactLlm] = await Promise.all([
        calculateEmbeddingSimilarity(chunkResult.result, factResult.result),
        calculateEmbeddingSimilarity(chunkResult.result, llmResult.result),
        calculateEmbeddingSimilarity(factResult.result, llmResult.result),
      ]);

      // Track all new metrics
      chunkDiversities.push(chunkDiversity);
      factDiversities.push(factDiversity);
      llmDiversities.push(llmDiversity);
      chunkCoverages.push(chunkCoverage);
      factCoverages.push(factCoverage);
      llmCoverages.push(llmCoverage);
      factCompressions.push(factCompression);
      llmCompressions.push(llmCompression);
      embeddingOverlaps.push({ chunkFact: embChunkFact, chunkLlm: embChunkLlm, factLlm: embFactLlm });

      // Calculate average scores
      const avgChunkScore = chunkResult.result.length > 0
        ? chunkResult.result.reduce((sum, r) => sum + r.score, 0) / chunkResult.result.length
        : 0;
      const avgFactScore = factResult.result.length > 0
        ? factResult.result.reduce((sum, r) => sum + r.score, 0) / factResult.result.length
        : 0;
      const avgLlmScore = llmResult.result.length > 0
        ? llmResult.result.reduce((sum, r) => sum + r.score, 0) / llmResult.result.length
        : 0;

      // Track latencies and scores
      chunkLatencies.push(chunkResult.latencyMs);
      factLatencies.push(factResult.latencyMs);
      llmLatencies.push(llmResult.latencyMs);

      if (chunkResult.result.length > 0) chunkScores.push(avgChunkScore);
      if (factResult.result.length > 0) factScores.push(avgFactScore);
      if (llmResult.result.length > 0) llmScores.push(avgLlmScore);

      comparisons.push({
        query,
        expectedDocumentIds: expectedDocIds,
        chunk: { results: chunkResult.result, latencyMs: chunkResult.latencyMs, avgScore: avgChunkScore, metrics: chunkQueryMetrics },
        fact: { results: factResult.result, latencyMs: factResult.latencyMs, avgScore: avgFactScore, metrics: factQueryMetrics },
        llm: { results: llmResult.result, latencyMs: llmResult.latencyMs, avgScore: avgLlmScore, metrics: llmQueryMetrics },
        overlap,
      });

      // Store results for each pipeline with full metrics
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
        storeResult('chunk', chunkResult, chunkQueryMetrics),
        storeResult('fact', factResult, factQueryMetrics),
        storeResult('llm', llmResult, llmQueryMetrics),
      ]);

      // Generate answers and log to rag_runs_evaluation
      if (generateAnswers) {
        const pipelines = [
          { name: 'chunk' as const, result: chunkResult, metrics: chunkQueryMetrics, ids: chunkRetrievedIds },
          { name: 'fact' as const, result: factResult, metrics: factQueryMetrics, ids: factRetrievedIds },
          { name: 'llm' as const, result: llmResult, metrics: llmQueryMetrics, ids: llmRetrievedIds },
        ];

        for (const p of pipelines) {
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

    const aggregatedMetrics = {
      chunk: aggregatePipelineMetrics(chunkMetrics, chunkLatencies, chunkScores, chunkDiversities, chunkCoverages),
      fact: aggregatePipelineMetrics(factMetrics, factLatencies, factScores, factDiversities, factCoverages, factCompressions),
      llm: aggregatePipelineMetrics(llmMetrics, llmLatencies, llmScores, llmDiversities, llmCoverages, llmCompressions),
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
