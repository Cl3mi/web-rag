/**
 * Reindex API Endpoint
 *
 * POST /api/reindex
 * Re-processes all stored documents through selected pipelines using current config.
 * Does NOT re-fetch from the web — uses stored raw_html.
 *
 * Streams results as Server-Sent Events so the client sees progress in real time.
 * Each document emits one 'progress' event; a final 'done' event closes the stream.
 */

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
  const body = await request.json().catch(() => ({}));
  const { pipelines = ['chunk', 'fact', 'llm'] } = body as { pipelines?: string[] };

  const shouldChunk = pipelines.includes('chunk');
  const shouldFact  = pipelines.includes('fact');
  const shouldLLM   = pipelines.includes('llm');

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* client disconnected */ }
      };

      try {
        const docs = await sql`SELECT id, url, raw_html FROM documents ORDER BY created_at`;

        if (docs.length === 0) {
          send({ type: 'done', reindexed: 0, failed: 0, total: 0 });
          controller.close();
          return;
        }

        const ollamaAvailable = shouldLLM ? await checkOllamaAvailable() : false;
        send({ type: 'start', total: docs.length, ollamaAvailable, pipelines });

        let reindexed = 0;
        let failed = 0;

        for (const doc of docs) {
          const documentId = doc.id as string;
          const url = doc.url as string;
          const rawHtml = doc.raw_html as string;

          if (!rawHtml) {
            send({ type: 'progress', url, status: 'error', error: 'No stored HTML' });
            failed++;
            continue;
          }

          try {
            const extracted = extractContent(rawHtml, url);
            const chunks = chunkText(extracted.markdownContent);

            if (shouldChunk) await sql`DELETE FROM traditional_chunks WHERE document_id = ${documentId}`;
            if (shouldFact)  await sql`DELETE FROM facts_chunks      WHERE document_id = ${documentId}`;
            if (shouldLLM)   await sql`DELETE FROM llm_chunks         WHERE document_id = ${documentId}`;

            let chunkCount = 0;
            let chunkError: string | undefined;
            let factCount = 0;
            let factError: string | undefined;
            let llmCount = 0;
            let llmError: string | undefined;

            // --- Chunk pipeline ---
            if (shouldChunk && chunks.length > 0) {
              try {
                const embedded = await embedChunks(chunks);
                for (const chunk of embedded) {
                  const embStr = `[${chunk.denseEmbedding.join(',')}]`;
                  await sql`
                    INSERT INTO traditional_chunks (
                      document_id, chunk_index, content, content_markdown,
                      dense_embedding, sparse_vector, metadata
                    ) VALUES (
                      ${documentId}, ${chunk.index}, ${chunk.content}, ${chunk.contentMarkdown},
                      ${embStr}::vector, ${JSON.stringify(chunk.sparseVector)},
                      ${JSON.stringify(chunk.metadata)}
                    )
                  `;
                }
                chunkCount = embedded.length;
              } catch (e) {
                chunkError = e instanceof Error ? e.message : 'Chunk pipeline failed';
              }
            }

            // --- Fact pipeline ---
            if (shouldFact) {
              try {
                const facts = extractFacts(extracted.markdownContent, { minConfidence: 0.3 });
                if (facts.length > 0) {
                  const embedded = await embedFacts(facts);
                  for (const fact of embedded) {
                    const embStr = `[${fact.denseEmbedding.join(',')}]`;
                    await sql`
                      INSERT INTO facts_chunks (
                        document_id, fact_index, content, category, confidence,
                        dense_embedding, sparse_vector, source_context, metadata
                      ) VALUES (
                        ${documentId}, ${fact.factIndex}, ${fact.content}, ${fact.category},
                        ${fact.confidence}, ${embStr}::vector, ${JSON.stringify(fact.sparseVector)},
                        ${fact.sourceContext}, ${JSON.stringify(fact.metadata)}
                      )
                    `;
                  }
                  factCount = embedded.length;
                }
              } catch (e) {
                factError = e instanceof Error ? e.message : 'Fact pipeline failed';
              }
            }

            // --- LLM pipeline ---
            if (shouldLLM) {
              if (!ollamaAvailable) {
                llmError = 'Ollama unreachable';
              } else if (chunks.length === 0) {
                llmError = 'No chunks to summarize';
              } else {
                try {
                  const summarized = await summarizeChunks(chunks);
                  if (summarized.length > 0) {
                    const embedded = await embedLLMChunks(summarized);
                    for (const chunk of embedded) {
                      const embStr = `[${chunk.denseEmbedding.join(',')}]`;
                      await sql`
                        INSERT INTO llm_chunks (
                          document_id, chunk_index, original_content, summary,
                          dense_embedding, sparse_vector, metadata
                        ) VALUES (
                          ${documentId}, ${chunk.index}, ${chunk.originalContent}, ${chunk.summary},
                          ${embStr}::vector, ${JSON.stringify(chunk.sparseVector)},
                          ${JSON.stringify(chunk.metadata)}
                        )
                      `;
                    }
                    llmCount = embedded.length;
                  }
                } catch (e) {
                  llmError = e instanceof Error ? e.message : 'LLM pipeline failed';
                }
              }
            }

            send({ type: 'progress', url, status: 'processed', chunkCount, chunkError, factCount, factError, llmCount, llmError });
            reindexed++;
          } catch (e) {
            send({ type: 'progress', url, status: 'error', error: e instanceof Error ? e.message : 'Unknown error' });
            failed++;
          }
        }

        send({ type: 'done', reindexed, failed, total: docs.length });
      } catch (e) {
        send({ type: 'error', error: e instanceof Error ? e.message : 'Internal error' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
};
