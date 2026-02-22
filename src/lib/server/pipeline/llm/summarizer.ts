/**
 * LLM Summarizer
 *
 * Uses Ollama to generate concise summaries of chunks.
 * Each chunk gets a 1-2 sentence summary that captures key information.
 */

import { env } from '$env/dynamic/private';
import type { Chunk } from '../traditional/chunker';

const OLLAMA_BASE_URL = env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = env.OLLAMA_MODEL || 'llama3.2';

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

interface OllamaResponse {
  model: string;
  response: string;
  done: boolean;
}

/**
 * Generate a summary for a single chunk using Ollama
 */
async function summarizeChunk(
  content: string,
  model: string = DEFAULT_MODEL
): Promise<string> {
  const prompt = `Summarize the following text in 1-2 concise sentences. Focus on the key facts, concepts, or instructions. Be specific and informative. IMPORTANT: ONLY RETURN THE SUMMARY.

Text:
${content}

Summary:`;

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature: 0.3, // Low temperature for consistent summaries
          top_p: 0.9,
          num_predict: 100, // Short summaries
        },
      }),
    });

    if (!response.ok) {
      console.error('Ollama summarization failed:', response.status);
      // Fallback: return first 200 chars as summary
      return content.slice(0, 200) + (content.length > 200 ? '...' : '');
    }

    const data: OllamaResponse = await response.json();
    return data.response.trim();
  } catch (error) {
    console.error('Ollama summarization error:', error);
    // Fallback: return first 200 chars as summary
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

/**
 * Check if Ollama is available
 */
export async function checkOllamaAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    return response.ok;
  } catch {
    return false;
  }
}
