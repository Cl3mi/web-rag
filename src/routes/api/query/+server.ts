/**
 * Query API Endpoint
 *
 * POST /api/query
 * Search through either traditional or facts pipeline.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hybridSearch, getChunksByDocumentId } from '$lib/server/pipeline/traditional/retriever';
import { searchFacts, getFactsByDocumentId } from '$lib/server/pipeline/facts/retriever';
import { searchLLMChunks, getLLMChunksForDocument } from '$lib/server/pipeline/llm/retriever';
import { rerank } from '$lib/server/reranker';
import type { SearchResult } from '$lib/types';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const {
      query,
      pipeline = 'traditional',
      topK = 10,
      rerank: shouldRerank = false,
      threshold = 0.3,
      documentId,
    } = body;

    // Support both old (traditional/facts) and new (chunk/fact/llm) naming
    const pipelineMap: Record<string, string> = {
      'traditional': 'chunk',
      'facts': 'fact',
      'chunk': 'chunk',
      'fact': 'fact',
      'llm': 'llm',
    };

    if (!pipelineMap[pipeline]) {
      return json(
        { error: 'Pipeline must be "chunk", "fact", or "llm"' },
        { status: 400 }
      );
    }

    const normalizedPipeline = pipelineMap[pipeline];
    const startTime = performance.now();

    // Document-scoped fetch: bypass vector search entirely, return ALL stored items for the doc
    if (documentId && typeof documentId === 'string') {
      let results: SearchResult[];

      if (normalizedPipeline === 'chunk') {
        results = await getChunksByDocumentId(documentId);
      } else if (normalizedPipeline === 'llm') {
        const llmChunks = await getLLMChunksForDocument(documentId);
        results = llmChunks.map(c => ({
          id: c.id,
          content: `Summary: ${c.summary}\n\nDetails: ${c.originalContent}`,
          score: 1.0,
          documentId,
          metadata: { summary: c.summary },
          sourceUrl: '',
          sourceTitle: null,
        }));
      } else {
        results = await getFactsByDocumentId(documentId);
      }

      const latencyMs = performance.now() - startTime;
      return json({
        results,
        query: '',
        pipeline: normalizedPipeline,
        latencyMs: Math.round(latencyMs),
        totalResults: results.length,
        reranked: false,
      });
    }

    if (!query || typeof query !== 'string') {
      return json({ error: 'Query is required' }, { status: 400 });
    }

    // Search using appropriate pipeline
    let results: SearchResult[];

    if (normalizedPipeline === 'chunk') {
      results = await hybridSearch(query, {
        topK: shouldRerank ? topK * 3 : topK, // Fetch more for reranking
        minScore: threshold,
      });
    } else if (normalizedPipeline === 'llm') {
      results = await searchLLMChunks(query, {
        topK: shouldRerank ? topK * 3 : topK,
        minScore: threshold,
      });
    } else {
      results = await searchFacts(query, {
        topK: shouldRerank ? topK * 3 : topK,
        minScore: threshold,
      });
    }

    // Optionally rerank
    if (shouldRerank && results.length > 0) {
      results = await rerank(query, results, { topK, threshold: 0.3 });
    }

    const latencyMs = performance.now() - startTime;

    return json({
      results: results.slice(0, topK),
      query,
      pipeline: normalizedPipeline,
      latencyMs: Math.round(latencyMs),
      totalResults: results.length,
      reranked: shouldRerank,
    });
  } catch (error) {
    console.error('Query error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
