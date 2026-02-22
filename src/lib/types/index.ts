/**
 * TypeScript interfaces for the RAG pipeline comparison system
 */

// Document types
export interface Document {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  contentHash: string;
  rawHtml: string | null;
  rawContent: string;
  metadata: DocumentMetadata;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentMetadata {
  wordCount?: number;
  hasCodeBlocks?: boolean;
  language?: string;
  fetchedAt?: string;
}

// Chunk pipeline types (formerly "Traditional")
export interface ChunkEntry {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  contentMarkdown: string;
  denseEmbedding: number[];
  sparseVector: Record<string, number>;
  metadata: ChunkMetadata;
  createdAt: Date;
}

// Backwards compatibility alias
export type TraditionalChunk = ChunkEntry;

export interface ChunkMetadata {
  chunkType: 'text' | 'table' | 'mixed';
  hasTable: boolean;
  pageNumber?: number;
  sectionTitle?: string;
  tokenCount: number;
  startChar: number;
  endChar: number;
}

// LLM pipeline types - chunks with LLM-generated summaries
export interface LLMChunkEntry {
  id: string;
  documentId: string;
  chunkIndex: number;
  originalContent: string;
  summary: string;
  denseEmbedding: number[];
  metadata: LLMChunkMetadata;
  createdAt: Date;
}

export interface LLMChunkMetadata {
  chunkType: string;
  tokenCount: number;
  summaryTokenCount: number;
}

// Fact pipeline types (formerly "Facts")
export type FactCategory = 'SPEC' | 'PROC' | 'DEF' | 'REL' | 'OTHER';

export interface FactEntry {
  id: string;
  documentId: string;
  factIndex: number;
  content: string;
  category: FactCategory;
  confidence: number;
  denseEmbedding: number[];
  sourceContext: string | null;
  metadata: FactMetadata;
  createdAt: Date;
}

// Backwards compatibility alias
export type FactsChunk = FactEntry;

export interface FactMetadata {
  extractedFrom?: string;
  entities?: string[];
  relations?: string[];
}

// Evaluation types
export interface TestQuery {
  id: string;
  query: string;
  expectedDocumentIds: string[];
  category: string | null;
  difficulty: 'easy' | 'medium' | 'hard';
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface EvaluationRun {
  id: string;
  name: string | null;
  pipeline: 'chunk' | 'fact' | 'llm' | 'all';
  config: EvaluationConfig;
  metrics: AggregateMetrics;
  status: 'running' | 'completed' | 'failed';
  startedAt: Date;
  completedAt: Date | null;
}

export interface EvaluationConfig {
  topK: number;
  rerank: boolean;
  rerankThreshold?: number;
}

export interface OverlapMetrics {
  avgChunkFact: number;
  avgChunkLlm: number;
  avgFactLlm: number;
  // Embedding similarity
  embeddingChunkFact?: number;
  embeddingChunkLlm?: number;
  embeddingFactLlm?: number;
}

export interface DocumentCoverageMetrics {
  avgChunksPerExpectedDoc: number;
  percentDocsWithMultipleChunks: number;
}

export interface CompressionMetrics {
  avgCompressionRatio: number;
  minCompressionRatio: number;
  maxCompressionRatio: number;
}

export interface AggregateMetrics {
  chunk?: PipelineMetrics;
  fact?: PipelineMetrics;
  llm?: PipelineMetrics;
  overlap?: OverlapMetrics;
  // Backwards compatibility
  traditional?: PipelineMetrics;
  facts?: PipelineMetrics;
}

export interface PipelineMetrics {
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
  avgLatencyMs: number;
  queryCount: number;
  avgScore?: number;
  sourceDiversity?: number;
  documentCoverage?: DocumentCoverageMetrics;
  compression?: CompressionMetrics;
  latencyStats?: {
    min: number;
    max: number;
    mean: number;
    median: number;
    p95: number;
    p99: number;
  };
}

export interface EvaluationResult {
  id: string;
  runId: string;
  queryId: string;
  pipeline: 'chunk' | 'fact' | 'llm';
  retrievedIds: string[];
  scores: number[];
  metrics: QueryMetrics;
  latencyMs: number;
  createdAt: Date;
}

export interface QueryMetrics {
  recall: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
  precision: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
}

// Search types
export interface SearchResult {
  id: string;
  content: string;
  score: number;
  documentId: string;
  metadata: ChunkMetadata | FactMetadata | Record<string, unknown>;
  sourceUrl?: string;
  sourceTitle?: string | null;
}

export interface SearchRequest {
  query: string;
  pipeline: 'chunk' | 'fact' | 'llm';
  topK?: number;
  rerank?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  latencyMs: number;
  pipeline: 'chunk' | 'fact' | 'llm';
}

// Pipeline processing types
export interface ProcessingResult {
  documentId: string;
  chunk: {
    chunkCount: number;
    processingTimeMs: number;
  };
  fact: {
    factCount: number;
    processingTimeMs: number;
  };
  llm?: {
    chunkCount: number;
    processingTimeMs: number;
  };
}

export interface ScrapingResult {
  url: string;
  title: string | null;
  content: string;
  html: string;
  metadata: DocumentMetadata;
}

// RAG Evaluation types (generation + judging)
export interface RagRunEvaluation {
  id: string;
  runId: string;
  queryId: string;
  pipelineName: 'chunk' | 'fact' | 'llm';
  question: string;
  retrievedDocIds: string[];
  retrievedContext: string;
  generatedAnswer: string;
  topK: number;
  rerankEnabled: boolean;
  modelName: string;
  recallAtK: number | null;
  ndcg: number | null;
  mrr: number | null;
  latencyMs: number;
  createdAt: Date;
}

export interface JudgeScores {
  groundedness: number;
  completeness: number;
  correctness: number;
  hallucination: boolean;
  answerableFromContext?: boolean;
}

export interface RagJudgeResult {
  id: string;
  evaluationId: string;
  groundednessScore: number;
  completenessScore: number;
  correctnessScore: number;
  hallucination: boolean;
  judgeMean: number;
  judgeStd: number;
  failureType: 'generation_failure' | 'retrieval_failure' | 'robust_generation' | null;
  judgeModel: string;
  createdAt: Date;
}

export interface RagPreference {
  id: string;
  question: string;
  context: string;
  answer: string;
  qualityScore: number | null;
  hallucination: boolean;
  chosen: boolean;
  rejected: boolean;
  source: 'llm_judge' | 'user';
  evaluationId: string | null;
  createdAt: Date;
}

export interface RagModel {
  id: string;
  baseModel: string;
  adapterPath: string | null;
  datasetSize: number;
  avgQualityScore: number | null;
  active: boolean;
  createdAt: Date;
}

export type FailureType = 'generation_failure' | 'retrieval_failure' | 'robust_generation' | 'normal';

export interface PipelineQualityMetrics {
  pipelineName: string;
  meanGroundedness: number;
  meanCorrectness: number;
  meanCompleteness: number;
  hallucinationRate: number;
  judgeMean: number;
  totalJudged: number;
  failureBreakdown: {
    generation_failure: number;
    retrieval_failure: number;
    robust_generation: number;
    other: number;
  };
}

// Embedding result type
export interface EmbeddingResult {
  dense: number[];
  sparse: Record<string, number>;
  tokenCount: number;
}
