/**
 * BGE-M3 Embedding Service
 *
 * Uses @xenova/transformers for local embedding generation.
 * Provides both dense (1024d) and sparse (BM25-style) embeddings.
 */

import { pipeline } from '@xenova/transformers';
import natural from 'natural';
import { EMBEDDING_CONFIG, EMBEDDING_DIMENSION, CHUNKING_CONFIG } from '$lib/config/database';
import type { EmbeddingResult } from '$lib/types';

// Extract from CommonJS module
const { WordTokenizer, PorterStemmer } = natural;

// Pipeline type
type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline>>;

// Singleton state
let embeddingPipeline: EmbeddingPipeline | null = null;
let loadingPromise: Promise<void> | null = null;
let modelLoaded = false;

// Tokenizer for sparse vectors
const tokenizer = new WordTokenizer();

// Common stopwords for English (extend as needed)
const stopwords = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'must', 'shall',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'under', 'again', 'further', 'then', 'once',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their',
  'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
  'how', 'when', 'where', 'why', 'all', 'each', 'every', 'both',
  'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'can',
]);

/**
 * Initialize the embedding model
 */
async function initializeModel(): Promise<void> {
  if (embeddingPipeline) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  loadingPromise = (async () => {
    console.log(`Loading embedding model: ${EMBEDDING_CONFIG.model}...`);

    try {
      embeddingPipeline = await pipeline(
        'feature-extraction',
        EMBEDDING_CONFIG.model
      );

      modelLoaded = true;
      console.log('Embedding model loaded successfully');
    } catch (error) {
      console.error('Failed to load embedding model:', error);
      throw error;
    }
  })();

  await loadingPromise;
}

/**
 * Extract embedding data from model output
 */
function extractEmbeddingData(output: unknown): Float32Array {
  if (output && typeof output === 'object') {
    // Handle Tensor-like objects
    if ('data' in output && output.data instanceof Float32Array) {
      return output.data;
    }
    // Handle nested data property
    if ('data' in output && typeof (output as { data: unknown }).data === 'object') {
      const nested = (output as { data: { data?: Float32Array } }).data;
      if (nested && 'data' in nested && nested.data instanceof Float32Array) {
        return nested.data;
      }
    }
    // Handle array-like objects
    if (Array.isArray(output)) {
      return new Float32Array(output.flat(Infinity));
    }
  }
  throw new Error('Unable to extract embedding data from model output');
}

/**
 * Generate dense embedding for text
 */
export async function embedDense(text: string): Promise<number[]> {
  await initializeModel();

  if (!embeddingPipeline) {
    throw new Error('Embedding pipeline not initialized');
  }

  try {
    const output = await (embeddingPipeline as (
      text: string,
      options: { pooling: string; normalize: boolean }
    ) => Promise<unknown>)(text, {
      pooling: 'mean',
      normalize: true,
    });

    const embeddingData = extractEmbeddingData(output);
    const embedding = Array.from(embeddingData);

    // Ensure correct dimensions
    if (embedding.length !== EMBEDDING_DIMENSION) {
      console.warn(
        `Embedding dimension mismatch: got ${embedding.length}, expected ${EMBEDDING_DIMENSION}`
      );

      if (embedding.length < EMBEDDING_DIMENSION) {
        while (embedding.length < EMBEDDING_DIMENSION) {
          embedding.push(0);
        }
      } else {
        embedding.length = EMBEDDING_DIMENSION;
      }
    }

    return embedding;
  } catch (error) {
    console.error('Dense embedding error:', error);
    throw error;
  }
}

/**
 * Generate sparse (BM25-style) embedding for text
 */
export function embedSparse(text: string): Record<string, number> {
  // Tokenize
  const tokens = tokenizer.tokenize(text.toLowerCase()) || [];

  // Remove stopwords and short tokens
  const filtered = tokens.filter(
    (token) => token.length > 2 && !stopwords.has(token)
  );

  // Stem tokens
  const stemmed = filtered.map((token) => PorterStemmer.stem(token));

  // Calculate term frequencies
  const termFreq: Record<string, number> = {};
  for (const term of stemmed) {
    termFreq[term] = (termFreq[term] || 0) + 1;
  }

  // Apply BM25-style weighting
  const k1 = 1.5;
  const b = 0.75;
  const avgDocLength = 200;
  const docLength = stemmed.length;

  const weights: Record<string, number> = {};

  for (const [term, freq] of Object.entries(termFreq)) {
    const tf = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (docLength / avgDocLength)));
    weights[term] = Math.min(tf / (k1 + 1), 1);
  }

  return weights;
}

/**
 * Generate both dense and sparse embeddings
 */
export async function embed(text: string): Promise<EmbeddingResult> {
  const [dense, sparse] = await Promise.all([
    embedDense(text),
    Promise.resolve(embedSparse(text)),
  ]);

  return {
    dense,
    sparse,
    tokenCount: estimateTokens(text),
  };
}

/**
 * Batch generate dense embeddings
 */
export async function embedBatchDense(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const embeddings: number[][] = [];
  const batchSize = EMBEDDING_CONFIG.batchSize;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map((text) => embedDense(text))
    );

    embeddings.push(...batchResults);

    // Progress logging for large batches
    if (texts.length > batchSize) {
      console.log(`Embedding progress: ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
    }
  }

  return embeddings;
}

/**
 * Batch generate full embeddings (dense + sparse)
 */
export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return [];

  const results: EmbeddingResult[] = [];
  const batchSize = EMBEDDING_CONFIG.batchSize;

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map((text) => embed(text))
    );

    results.push(...batchResults);

    if (texts.length > batchSize) {
      console.log(`Embedding progress: ${Math.min(i + batchSize, texts.length)}/${texts.length}`);
    }
  }

  return results;
}

/**
 * Compute cosine similarity between two dense vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must have the same length');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Compute sparse vector similarity
 */
export function sparseSimilarity(
  a: Record<string, number>,
  b: Record<string, number>
): number {
  const keysA = new Set(Object.keys(a));
  const keysB = new Set(Object.keys(b));

  const intersection = new Set([...keysA].filter((k) => keysB.has(k)));

  if (intersection.size === 0) return 0;

  let numerator = 0;
  let denominatorA = 0;
  let denominatorB = 0;

  for (const key of intersection) {
    numerator += Math.min(a[key], b[key]);
  }

  for (const key of keysA) {
    denominatorA += a[key];
  }

  for (const key of keysB) {
    denominatorB += b[key];
  }

  const denominator = denominatorA + denominatorB - numerator;
  if (denominator === 0) return 0;

  return numerator / denominator;
}

/**
 * Compute hybrid similarity score
 */
export function hybridSimilarity(
  queryDense: number[],
  querySparse: Record<string, number>,
  docDense: number[],
  docSparse: Record<string, number>,
  alpha: number = 0.7
): number {
  const denseSim = cosineSimilarity(queryDense, docDense);
  const sparseSim = sparseSimilarity(querySparse, docSparse);
  return alpha * denseSim + (1 - alpha) * sparseSim;
}

/**
 * Estimate token count for text
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHUNKING_CONFIG.charsPerToken);
}

/**
 * Check if model is loaded
 */
export function isModelLoaded(): boolean {
  return modelLoaded;
}

/**
 * Preload the embedding model
 */
export async function preloadModel(): Promise<void> {
  await initializeModel();
}

/**
 * Get embedding dimension
 */
export function getEmbeddingDimension(): number {
  return EMBEDDING_DIMENSION;
}
