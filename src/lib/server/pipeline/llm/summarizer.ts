/**
 * LLM Summarizer
 *
 * Generates concise summaries of chunks via the configured LLM provider.
 * Each chunk gets a 1-2 sentence summary that captures key information.
 */

import type { Chunk } from '../traditional/chunker';
import { generate, isAvailable, DEFAULT_MODEL } from '$lib/server/llm/client';

export interface SummarizedChunk {
  index: number;
  originalContent: string;
  summary: string;
  metadata: {
    chunkType: string;
    tokenCount: number;
    summaryTokenCount: number;
  };
}

async function summarizeChunk(content: string, model: string = DEFAULT_MODEL): Promise<string> {
  const prompt = `You are a precise summarizer. Summarize the following text in concise sentences without loosing crucial information. Focus on the key facts, concepts, or instructions. Be specific and informative. Do NOT reproduce the original text verbatim. IMPORTANT: ONLY RETURN THE SUMMARY.

Text:
${content}

Summary:`;

  try {
    return await generate({ model, prompt, temperature: 0.3, topP: 0.9, maxTokens: 150 });
  } catch (error) {
    console.warn('[summarizer] summarizeChunk failed, falling back to raw slice:',
      error instanceof Error ? error.message : error);
    return content.slice(0, 200) + (content.length > 200 ? '...' : '');
  }
}

/**
 * Summarize multiple chunks in parallel with rate limiting
 */
export async function summarizeChunks(
  chunks: Chunk[],
  options: {
    model?: string;
    concurrency?: number;
  } = {}
): Promise<SummarizedChunk[]> {
  const { model = DEFAULT_MODEL, concurrency = 3 } = options;

  const results: SummarizedChunk[] = [];

  // Process in batches to avoid overwhelming Ollama
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, i + concurrency);

    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        const summary = await summarizeChunk(chunk.content, model);

        return {
          index: chunk.index,
          originalContent: chunk.content,
          summary,
          metadata: {
            chunkType: chunk.metadata.chunkType,
            tokenCount: chunk.metadata.tokenCount,
            summaryTokenCount: Math.ceil(summary.length / 4), // Rough estimate
          },
        };
      })
    );

    results.push(...batchResults);

    // Small delay between batches
    if (i + concurrency < chunks.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return results;
}

export { isAvailable as checkOllamaAvailable };
