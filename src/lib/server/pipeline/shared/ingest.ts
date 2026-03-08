/**
 * Shared URL ingestion logic used by /api/scrape and /api/sitemap.
 *
 * fetch → extract → hash → upsert document → run 3 pipelines
 */

import { fetchUrl } from './scraper';
import { extractContent, hashContentSha256 } from './content-extractor';
import { chunkText } from '$lib/server/pipeline/traditional/chunker';
import { embedChunks } from '$lib/server/pipeline/traditional/embedder';
import { extractFacts } from '$lib/server/pipeline/facts/extractor';
import { embedFacts } from '$lib/server/pipeline/facts/embedder';
import { summarizeChunks, checkOllamaAvailable } from '$lib/server/pipeline/llm/summarizer';
import { embedLLMChunks } from '$lib/server/pipeline/llm/embedder';
import { sql } from '$lib/server/db/client';
import type { Chunk } from '$lib/server/pipeline/traditional/chunker';

export interface IngestResult {
  documentId: string;
  status: 'processed' | 'unchanged' | 'error';
  url: string;
  title: string | null;
  wordCount: number;
  processingTimeMs: number;
  chunk: { chunkCount: number; processingTimeMs: number };
  fact: { factCount: number; processingTimeMs: number };
  llm: { chunkCount: number; processingTimeMs: number };
  error?: string;
}

/**
 * Ingest a single URL through all three pipelines.
 */
export async function ingestUrl(url: string): Promise<IngestResult> {
  const blank: IngestResult = {
    documentId: '',
    status: 'error',
    url,
    title: null,
    wordCount: 0,
    processingTimeMs: 0,
    chunk: { chunkCount: 0, processingTimeMs: 0 },
    fact: { factCount: 0, processingTimeMs: 0 },
    llm: { chunkCount: 0, processingTimeMs: 0 },
  };

  try {
    const parsedUrl = new URL(url);

    // Fetch
    const fetchResult = await fetchUrl(url);
    if (fetchResult.status !== 200) {
      return { ...blank, error: `Failed to fetch URL: ${fetchResult.status}` };
    }

    // Extract content
    const extracted = extractContent(fetchResult.html, url);
    if (!extracted.textContent || extracted.wordCount < 10) {
      return { ...blank, error: 'No meaningful content found at URL' };
    }

    const contentHash = await hashContentSha256(extracted.textContent);

    // Upsert document
    let documentId: string;
    const existing = await sql`SELECT id, content_hash FROM documents WHERE url = ${url}`;

    if (existing.length > 0) {
      documentId = existing[0].id as string;

      if (existing[0].content_hash === contentHash) {
        // Content unchanged
        const [chunkCount, factCount, llmCount] = await Promise.all([
          sql`SELECT COUNT(*) as count FROM traditional_chunks WHERE document_id = ${documentId}`,
          sql`SELECT COUNT(*) as count FROM facts_chunks WHERE document_id = ${documentId}`,
          sql`SELECT COUNT(*) as count FROM llm_chunks WHERE document_id = ${documentId}`,
        ]);

        return {
          documentId,
          status: 'unchanged',
          url,
          title: extracted.title,
          wordCount: extracted.wordCount,
          processingTimeMs: 0,
          chunk: { chunkCount: Number(chunkCount[0].count), processingTimeMs: 0 },
          fact: { factCount: Number(factCount[0].count), processingTimeMs: 0 },
          llm: { chunkCount: Number(llmCount[0].count), processingTimeMs: 0 },
        };
      }

      // Content changed — delete old chunks then update
      await sql`DELETE FROM traditional_chunks WHERE document_id = ${documentId}`;
      await sql`DELETE FROM facts_chunks WHERE document_id = ${documentId}`;
      await sql`DELETE FROM llm_chunks WHERE document_id = ${documentId}`;

      await sql`
        UPDATE documents SET
          title = ${extracted.title},
          content_hash = ${contentHash},
          raw_html = ${fetchResult.html},
          raw_content = ${extracted.textContent},
          metadata = ${JSON.stringify({
            wordCount: extracted.wordCount,
            hasCodeBlocks: extracted.hasCodeBlocks,
            language: extracted.language,
            fetchedAt: fetchResult.fetchedAt.toISOString(),
          })},
          updated_at = NOW()
        WHERE id = ${documentId}
      `;
    } else {
      const result = await sql`
        INSERT INTO documents (url, domain, title, content_hash, raw_html, raw_content, metadata)
        VALUES (
          ${url},
          ${parsedUrl.hostname},
          ${extracted.title},
          ${contentHash},
          ${fetchResult.html},
          ${extracted.textContent},
          ${JSON.stringify({
            wordCount: extracted.wordCount,
            hasCodeBlocks: extracted.hasCodeBlocks,
            language: extracted.language,
            fetchedAt: fetchResult.fetchedAt.toISOString(),
          })}
        )
        RETURNING id
      `;
      documentId = result[0].id as string;
    }

    // Run pipelines
    const startTime = performance.now();
    const chunks = chunkText(extracted.markdownContent);

    const [chunkResult, factResult] = await Promise.all([
      processChunkPipeline(documentId, chunks),
      processFactPipeline(documentId, extracted.textContent),
    ]);

    const ollamaAvailable = await checkOllamaAvailable();
    let llmResult = { chunkCount: 0, processingTimeMs: 0 };
    if (ollamaAvailable && chunks.length > 0) {
      llmResult = await processLLMPipeline(documentId, chunks);
    }

    return {
      documentId,
      status: 'processed',
      url,
      title: extracted.title,
      wordCount: extracted.wordCount,
      processingTimeMs: Math.round(performance.now() - startTime),
      chunk: chunkResult,
      fact: factResult,
      llm: llmResult,
    };
  } catch (error) {
    return {
      ...blank,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function processChunkPipeline(
  documentId: string,
  chunks: Chunk[]
): Promise<{ chunkCount: number; processingTimeMs: number }> {
  const startTime = performance.now();

  if (chunks.length === 0) {
    return { chunkCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  const embeddedChunks = await embedChunks(chunks);

  for (const chunk of embeddedChunks) {
    const embeddingStr = `[${chunk.denseEmbedding.join(',')}]`;
    await sql`
      INSERT INTO traditional_chunks (
        document_id, chunk_index, content, content_markdown,
        dense_embedding, sparse_vector, metadata
      )
      VALUES (
        ${documentId},
        ${chunk.index},
        ${chunk.content},
        ${chunk.contentMarkdown},
        ${embeddingStr}::vector,
        ${JSON.stringify(chunk.sparseVector)},
        ${JSON.stringify(chunk.metadata)}
      )
    `;
  }

  return {
    chunkCount: embeddedChunks.length,
    processingTimeMs: Math.round(performance.now() - startTime),
  };
}

async function processFactPipeline(
  documentId: string,
  content: string
): Promise<{ factCount: number; processingTimeMs: number }> {
  const startTime = performance.now();

  const facts = extractFacts(content, { minConfidence: 0.3 });

  if (facts.length === 0) {
    return { factCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  const embeddedFacts = await embedFacts(facts);

  for (const fact of embeddedFacts) {
    const embeddingStr = `[${fact.denseEmbedding.join(',')}]`;
    await sql`
      INSERT INTO facts_chunks (
        document_id, fact_index, content, category, confidence,
        dense_embedding, sparse_vector, source_context, metadata
      )
      VALUES (
        ${documentId},
        ${fact.factIndex},
        ${fact.content},
        ${fact.category},
        ${fact.confidence},
        ${embeddingStr}::vector,
        ${JSON.stringify(fact.sparseVector)},
        ${fact.sourceContext},
        ${JSON.stringify(fact.metadata)}
      )
    `;
  }

  return {
    factCount: embeddedFacts.length,
    processingTimeMs: Math.round(performance.now() - startTime),
  };
}

async function processLLMPipeline(
  documentId: string,
  chunks: Chunk[]
): Promise<{ chunkCount: number; processingTimeMs: number }> {
  const startTime = performance.now();

  if (chunks.length === 0) {
    return { chunkCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  const summarizedChunks = await summarizeChunks(chunks);

  if (summarizedChunks.length === 0) {
    return { chunkCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  const embeddedChunks = await embedLLMChunks(summarizedChunks);

  for (const chunk of embeddedChunks) {
    const embeddingStr = `[${chunk.denseEmbedding.join(',')}]`;
    await sql`
      INSERT INTO llm_chunks (
        document_id, chunk_index, original_content, summary,
        dense_embedding, sparse_vector, metadata
      )
      VALUES (
        ${documentId},
        ${chunk.index},
        ${chunk.originalContent},
        ${chunk.summary},
        ${embeddingStr}::vector,
        ${JSON.stringify(chunk.sparseVector)},
        ${JSON.stringify(chunk.metadata)}
      )
    `;
  }

  return {
    chunkCount: embeddedChunks.length,
    processingTimeMs: Math.round(performance.now() - startTime),
  };
}
