/**
 * Reindex API Endpoint
 *
 * POST /api/reindex
 * Re-processes all stored documents through all pipelines using current config
 * (chunk size, overlap, etc.). Does NOT re-fetch from the web — uses stored raw_html.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { extractContent } from '$lib/server/pipeline/shared/content-extractor';
import { chunkText } from '$lib/server/pipeline/traditional/chunker';
import { embedChunks } from '$lib/server/pipeline/traditional/embedder';
import { extractFacts } from '$lib/server/pipeline/facts/extractor';
import { embedFacts } from '$lib/server/pipeline/facts/embedder';
import { summarizeChunks, checkOllamaAvailable } from '$lib/server/pipeline/llm/summarizer';
import { embedLLMChunks } from '$lib/server/pipeline/llm/embedder';
import { sql } from '$lib/server/db/client';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const { pipelines = ['chunk', 'fact', 'llm'] } = body as { pipelines?: string[] };

    const shouldChunk = pipelines.includes('chunk');
    const shouldFact  = pipelines.includes('fact');
    const shouldLLM   = pipelines.includes('llm');

    // Load all documents with their stored HTML (no web fetch needed)
    const docs = await sql`
      SELECT id, url, raw_html
      FROM documents
      ORDER BY created_at
    `;

    if (docs.length === 0) {
      return json({ reindexed: 0, results: [], message: 'No documents found.' });
    }

    const ollamaAvailable = shouldLLM ? await checkOllamaAvailable() : false;

    const results: Array<{
      documentId: string;
      url: string;
      chunkCount: number;
      factCount: number;
      llmCount: number;
      error?: string;
    }> = [];

    for (const doc of docs) {
      const documentId = doc.id as string;
      const url = doc.url as string;
      const rawHtml = doc.raw_html as string;

      if (!rawHtml) {
        results.push({ documentId, url, chunkCount: 0, factCount: 0, llmCount: 0, error: 'No stored HTML' });
        continue;
      }

      try {
        // Re-extract content from stored HTML (gets fresh markdownContent + textContent)
        const extracted = extractContent(rawHtml, url);

        // Delete old pipeline data
        if (shouldChunk) await sql`DELETE FROM traditional_chunks WHERE document_id = ${documentId}`;
        if (shouldFact)  await sql`DELETE FROM facts_chunks WHERE document_id = ${documentId}`;
        if (shouldLLM)   await sql`DELETE FROM llm_chunks WHERE document_id = ${documentId}`;

        // Chunk pipeline
        const chunks = chunkText(extracted.markdownContent);
        let chunkCount = 0;

        if (shouldChunk && chunks.length > 0) {
          const embedded = await embedChunks(chunks);
          for (const chunk of embedded) {
            const embeddingStr = `[${chunk.denseEmbedding.join(',')}]`;
            await sql`
              INSERT INTO traditional_chunks (
                document_id, chunk_index, content, content_markdown,
                dense_embedding, sparse_vector, metadata
              ) VALUES (
                ${documentId}, ${chunk.index}, ${chunk.content}, ${chunk.contentMarkdown},
                ${embeddingStr}::vector, ${JSON.stringify(chunk.sparseVector)},
                ${JSON.stringify(chunk.metadata)}
              )
            `;
          }
          chunkCount = embedded.length;
        }

        // Fact pipeline
        let factCount = 0;
        if (shouldFact) {
          const facts = extractFacts(extracted.textContent, { minConfidence: 0.5 });
          if (facts.length > 0) {
            const embedded = await embedFacts(facts);
            for (const fact of embedded) {
              const embeddingStr = `[${fact.denseEmbedding.join(',')}]`;
              await sql`
                INSERT INTO facts_chunks (
                  document_id, fact_index, content, category, confidence,
                  dense_embedding, sparse_vector, source_context, metadata
                ) VALUES (
                  ${documentId}, ${fact.factIndex}, ${fact.content}, ${fact.category},
                  ${fact.confidence}, ${embeddingStr}::vector, ${JSON.stringify(fact.sparseVector)},
                  ${fact.sourceContext}, ${JSON.stringify(fact.metadata)}
                )
              `;
            }
            factCount = embedded.length;
          }
        }

        // LLM pipeline
        let llmCount = 0;
        if (shouldLLM && ollamaAvailable && chunks.length > 0) {
          const summarized = await summarizeChunks(chunks);
          if (summarized.length > 0) {
            const embedded = await embedLLMChunks(summarized);
            for (const chunk of embedded) {
              const embeddingStr = `[${chunk.denseEmbedding.join(',')}]`;
              await sql`
                INSERT INTO llm_chunks (
                  document_id, chunk_index, original_content, summary,
                  dense_embedding, sparse_vector, metadata
                ) VALUES (
                  ${documentId}, ${chunk.index}, ${chunk.originalContent}, ${chunk.summary},
                  ${embeddingStr}::vector, ${JSON.stringify(chunk.sparseVector)},
                  ${JSON.stringify(chunk.metadata)}
                )
              `;
            }
            llmCount = embedded.length;
          }
        }

        results.push({ documentId, url, chunkCount, factCount, llmCount });
        console.log(`Reindexed ${url}: ${chunkCount} chunks, ${factCount} facts, ${llmCount} llm`);
      } catch (docError) {
        console.error(`Failed to reindex ${url}:`, docError);
        results.push({
          documentId, url, chunkCount: 0, factCount: 0, llmCount: 0,
          error: docError instanceof Error ? docError.message : 'Unknown error',
        });
      }
    }

    const succeeded = results.filter(r => !r.error).length;
    const failed = results.filter(r => r.error).length;

    return json({
      reindexed: succeeded,
      failed,
      totalDocuments: docs.length,
      ollamaAvailable,
      results,
    });
  } catch (error) {
    console.error('Reindex error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
