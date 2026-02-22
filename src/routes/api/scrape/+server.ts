/**
 * Scrape API Endpoint
 *
 * POST /api/scrape
 * Fetches a URL, extracts content, and processes through both pipelines.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { fetchUrl } from '$lib/server/pipeline/shared/scraper';
import { extractContent, hashContentSha256 } from '$lib/server/pipeline/shared/content-extractor';
import { chunkText } from '$lib/server/pipeline/traditional/chunker';
import { embedChunks } from '$lib/server/pipeline/traditional/embedder';
import { extractFacts } from '$lib/server/pipeline/facts/extractor';
import { embedFacts } from '$lib/server/pipeline/facts/embedder';
import { summarizeChunks, checkOllamaAvailable } from '$lib/server/pipeline/llm/summarizer';
import { embedLLMChunks } from '$lib/server/pipeline/llm/embedder';
import { sql } from '$lib/server/db/client';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return json({ error: 'URL is required' }, { status: 400 });
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return json({ error: 'Invalid URL format' }, { status: 400 });
    }

    // Fetch the URL
    console.log(`Fetching URL: ${url}`);
    const fetchResult = await fetchUrl(url);

    if (fetchResult.status !== 200) {
      return json(
        { error: `Failed to fetch URL: ${fetchResult.status}` },
        { status: 400 }
      );
    }

    // Extract content
    console.log('Extracting content...');
    const extracted = extractContent(fetchResult.html, url);

    if (!extracted.textContent || extracted.wordCount < 10) {
      return json(
        { error: 'No meaningful content found at URL' },
        { status: 400 }
      );
    }

    // Generate content hash
    const contentHash = await hashContentSha256(extracted.textContent);

    // Check if document already exists
    const existing = await sql`
      SELECT id FROM documents WHERE url = ${url}
    `;

    let documentId: string;

    if (existing.length > 0) {
      documentId = existing[0].id as string;

      // Check if content changed
      const existingDoc = await sql`
        SELECT content_hash FROM documents WHERE id = ${documentId}
      `;

      if (existingDoc[0].content_hash === contentHash) {
        // Content unchanged, return existing stats
        const [chunkCount, factCount, llmCount] = await Promise.all([
          sql`SELECT COUNT(*) as count FROM traditional_chunks WHERE document_id = ${documentId}`,
          sql`SELECT COUNT(*) as count FROM facts_chunks WHERE document_id = ${documentId}`,
          sql`SELECT COUNT(*) as count FROM llm_chunks WHERE document_id = ${documentId}`,
        ]);

        return json({
          documentId,
          status: 'unchanged',
          chunk: { chunkCount: Number(chunkCount[0].count) },
          fact: { factCount: Number(factCount[0].count) },
          llm: { chunkCount: Number(llmCount[0].count) },
        });
      }

      // Content changed, delete old chunks
      await sql`DELETE FROM traditional_chunks WHERE document_id = ${documentId}`;
      await sql`DELETE FROM facts_chunks WHERE document_id = ${documentId}`;
      await sql`DELETE FROM llm_chunks WHERE document_id = ${documentId}`;

      // Update document
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
      // Insert new document
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

    // Process through all pipelines
    console.log('Processing through pipelines...');
    const startTime = performance.now();

    // First, create chunks (needed for both chunk and llm pipelines)
    const chunks = chunkText(extracted.markdownContent);

    // Process chunk and fact pipelines in parallel
    const [chunkResult, factResult] = await Promise.all([
      processChunkPipeline(documentId, chunks),
      processFactPipeline(documentId, extracted.textContent),
    ]);

    // Process LLM pipeline (uses Ollama, so run after to not block others)
    // Check if Ollama is available first
    const ollamaAvailable = await checkOllamaAvailable();
    let llmResult = { chunkCount: 0, processingTimeMs: 0 };

    if (ollamaAvailable && chunks.length > 0) {
      console.log('Processing LLM pipeline (summarizing chunks)...');
      llmResult = await processLLMPipeline(documentId, chunks);
    } else if (!ollamaAvailable) {
      console.log('Ollama not available, skipping LLM pipeline');
    }

    const processingTime = performance.now() - startTime;

    return json({
      documentId,
      status: 'processed',
      url,
      title: extracted.title,
      wordCount: extracted.wordCount,
      processingTimeMs: Math.round(processingTime),
      chunk: {
        chunkCount: chunkResult.chunkCount,
        processingTimeMs: chunkResult.processingTimeMs,
      },
      fact: {
        factCount: factResult.factCount,
        processingTimeMs: factResult.processingTimeMs,
      },
      llm: {
        chunkCount: llmResult.chunkCount,
        processingTimeMs: llmResult.processingTimeMs,
      },
    });
  } catch (error) {
    console.error('Scrape error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};

import type { Chunk } from '$lib/server/pipeline/traditional/chunker';

/**
 * Process document through chunk pipeline
 */
async function processChunkPipeline(
  documentId: string,
  chunks: Chunk[]
): Promise<{ chunkCount: number; processingTimeMs: number }> {
  const startTime = performance.now();

  if (chunks.length === 0) {
    return { chunkCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  // Embed chunks
  const embeddedChunks = await embedChunks(chunks);

  // Insert into database
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

/**
 * Process document through fact pipeline
 */
async function processFactPipeline(
  documentId: string,
  content: string
): Promise<{ factCount: number; processingTimeMs: number }> {
  const startTime = performance.now();

  // Extract facts
  const facts = extractFacts(content, { minConfidence: 0.5 });

  if (facts.length === 0) {
    return { factCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  // Embed facts
  const embeddedFacts = await embedFacts(facts);

  // Insert into database
  for (const fact of embeddedFacts) {
    const embeddingStr = `[${fact.denseEmbedding.join(',')}]`;

    await sql`
      INSERT INTO facts_chunks (
        document_id, fact_index, content, category, confidence,
        dense_embedding, source_context, metadata
      )
      VALUES (
        ${documentId},
        ${fact.factIndex},
        ${fact.content},
        ${fact.category},
        ${fact.confidence},
        ${embeddingStr}::vector,
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

/**
 * Process document through LLM pipeline (chunk + summarize)
 */
async function processLLMPipeline(
  documentId: string,
  chunks: Chunk[]
): Promise<{ chunkCount: number; processingTimeMs: number }> {
  const startTime = performance.now();

  if (chunks.length === 0) {
    return { chunkCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  // Summarize chunks using Ollama
  const summarizedChunks = await summarizeChunks(chunks);

  if (summarizedChunks.length === 0) {
    return { chunkCount: 0, processingTimeMs: Math.round(performance.now() - startTime) };
  }

  // Embed summarized chunks
  const embeddedChunks = await embedLLMChunks(summarizedChunks);

  // Insert into database
  for (const chunk of embeddedChunks) {
    const embeddingStr = `[${chunk.denseEmbedding.join(',')}]`;

    await sql`
      INSERT INTO llm_chunks (
        document_id, chunk_index, original_content, summary,
        dense_embedding, metadata
      )
      VALUES (
        ${documentId},
        ${chunk.index},
        ${chunk.originalContent},
        ${chunk.summary},
        ${embeddingStr}::vector,
        ${JSON.stringify(chunk.metadata)}
      )
    `;
  }

  return {
    chunkCount: embeddedChunks.length,
    processingTimeMs: Math.round(performance.now() - startTime),
  };
}

/**
 * DELETE /api/scrape
 * Delete a document and all its chunks/facts
 */
export const DELETE: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { documentId, url } = body;

    if (!documentId && !url) {
      return json({ error: 'documentId or url is required' }, { status: 400 });
    }

    let targetDocId = documentId;

    // If URL provided, find the document ID
    if (!targetDocId && url) {
      const result = await sql`
        SELECT id FROM documents WHERE url = ${url}
      `;
      if (result.length === 0) {
        return json({ error: 'Document not found' }, { status: 404 });
      }
      targetDocId = result[0].id;
    }

    // Delete chunks and facts (cascade should handle this, but be explicit)
    await sql`DELETE FROM traditional_chunks WHERE document_id = ${targetDocId}`;
    await sql`DELETE FROM facts_chunks WHERE document_id = ${targetDocId}`;
    await sql`DELETE FROM llm_chunks WHERE document_id = ${targetDocId}`;

    // Delete the document
    const deleted = await sql`
      DELETE FROM documents WHERE id = ${targetDocId}
      RETURNING id, url, title
    `;

    if (deleted.length === 0) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    return json({
      success: true,
      deleted: {
        id: deleted[0].id,
        url: deleted[0].url,
        title: deleted[0].title,
      },
    });
  } catch (error) {
    console.error('Delete document error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
