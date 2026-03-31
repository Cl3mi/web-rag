/**
 * Drizzle ORM Schema for RAG Pipeline Comparison System
 *
 * Tables:
 * - documents: Shared source documents
 * - traditionalChunks: Semantic chunks with dense + sparse vectors
 * - factsChunks: Atomic facts with dense embeddings
 * - testQueries: Ground truth queries
 * - evaluationRuns: Evaluation run metadata
 * - evaluationResults: Per-query results
 */

import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  jsonb,
  real,
  varchar,
  boolean,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { EMBEDDING_DIMENSION } from '../../config/database';

// Custom vector type for pgvector
const vector = (name: string, dimensions: number) =>
  text(name).$type<number[]>();

// Documents table - shared source documents
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    url: text('url').notNull(),
    domain: varchar('domain', { length: 255 }).notNull(),
    title: text('title'),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    rawHtml: text('raw_html'),
    rawContent: text('raw_content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('documents_url_idx').on(table.url),
    index('documents_domain_idx').on(table.domain),
    index('documents_content_hash_idx').on(table.contentHash),
  ]
);

// Traditional chunks table - semantic chunks with dense + sparse vectors
export const traditionalChunks = pgTable(
  'traditional_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    contentMarkdown: text('content_markdown').notNull(),
    // Dense embedding stored as vector type (handled via raw SQL for pgvector)
    denseEmbedding: vector('dense_embedding', EMBEDDING_DIMENSION),
    // Sparse vector stored as JSONB (term -> weight)
    sparseVector: jsonb('sparse_vector').$type<Record<string, number>>().default({}),
    metadata: jsonb('metadata').$type<{
      chunkType: 'text' | 'table' | 'mixed';
      hasTable: boolean;
      pageNumber?: number;
      sectionTitle?: string;
      tokenCount: number;
      startChar: number;
      endChar: number;
    }>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('traditional_chunks_document_idx').on(table.documentId),
    index('traditional_chunks_chunk_index_idx').on(table.documentId, table.chunkIndex),
  ]
);

// Facts chunks table - atomic facts with dense embeddings
export const factsChunks = pgTable(
  'facts_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    factIndex: integer('fact_index').notNull(),
    content: text('content').notNull(),
    category: varchar('category', { length: 20 }).$type<'SPEC' | 'PROC' | 'DEF' | 'REL' | 'OTHER'>().notNull(),
    confidence: real('confidence').notNull().default(1.0),
    // Dense embedding stored as vector type
    denseEmbedding: vector('dense_embedding', EMBEDDING_DIMENSION),
    // Sparse (BM25-style) vector for hybrid search
    sparseVector: jsonb('sparse_vector').$type<Record<string, number>>().default({}),
    sourceContext: text('source_context'),
    metadata: jsonb('metadata').$type<{
      extractedFrom?: string;
      entities?: string[];
      relations?: string[];
    }>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('facts_chunks_document_idx').on(table.documentId),
    index('facts_chunks_category_idx').on(table.category),
    index('facts_chunks_confidence_idx').on(table.confidence),
  ]
);

// Test queries table - ground truth queries with expected results
export const testQueries = pgTable(
  'test_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    query: text('query').notNull(),
    expectedDocumentIds: jsonb('expected_document_ids').$type<string[]>().notNull(),
    category: varchar('category', { length: 100 }),
    difficulty: varchar('difficulty', { length: 20 }).$type<'easy' | 'medium' | 'hard'>().default('medium'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('test_queries_category_idx').on(table.category),
    index('test_queries_difficulty_idx').on(table.difficulty),
  ]
);

// Evaluation runs table - evaluation run metadata and aggregate metrics
export const evaluationRuns = pgTable(
  'evaluation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name'),
    pipeline: varchar('pipeline', { length: 20 }).$type<'chunk' | 'fact' | 'llm' | 'all' | 'traditional' | 'facts' | 'both'>().notNull(),
    config: jsonb('config').$type<{
      topK: number;
      rerank: boolean;
      rerankThreshold?: number;
    }>().notNull(),
    metrics: jsonb('metrics').$type<{
      chunk?: Record<string, unknown>;
      fact?: Record<string, unknown>;
      llm?: Record<string, unknown>;
      overlap?: Record<string, unknown>;
      // Legacy keys
      traditional?: Record<string, unknown>;
      facts?: Record<string, unknown>;
    }>().default({}),
    status: varchar('status', { length: 20 }).$type<'running' | 'completed' | 'failed'>().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('evaluation_runs_status_idx').on(table.status),
    index('evaluation_runs_started_at_idx').on(table.startedAt),
  ]
);

// Evaluation results table - per-query results
export const evaluationResults = pgTable(
  'evaluation_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: 'cascade' }),
    queryId: uuid('query_id')
      .notNull()
      .references(() => testQueries.id, { onDelete: 'cascade' }),
    pipeline: varchar('pipeline', { length: 20 }).$type<'chunk' | 'fact' | 'llm' | 'traditional' | 'facts'>().notNull(),
    retrievedIds: jsonb('retrieved_ids').$type<string[]>().notNull(),
    scores: jsonb('scores').$type<number[]>().notNull(),
    metrics: jsonb('metrics').$type<{
      recall: number;
      recallAt5: number;
      recallAt10: number;
      mrr: number;
      ndcg: number;
      precision: number;
      hitAt1: number;
      hitAt5: number;
      hitAt10: number;
    }>().notNull(),
    latencyMs: real('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('evaluation_results_run_idx').on(table.runId),
    index('evaluation_results_query_idx').on(table.queryId),
    index('evaluation_results_pipeline_idx').on(table.pipeline),
  ]
);

// RAG Runs Evaluation table - per query + pipeline generation logging
export const ragRunsEvaluation = pgTable(
  'rag_runs_evaluation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => evaluationRuns.id, { onDelete: 'cascade' }),
    queryId: uuid('query_id')
      .notNull()
      .references(() => testQueries.id, { onDelete: 'cascade' }),
    pipelineName: varchar('pipeline_name', { length: 20 }).$type<'chunk' | 'fact' | 'llm'>().notNull(),
    question: text('question').notNull(),
    retrievedDocIds: jsonb('retrieved_doc_ids').$type<string[]>().notNull(),
    retrievedContext: text('retrieved_context').notNull(),
    generatedAnswer: text('generated_answer').notNull(),
    topK: integer('top_k').notNull(),
    rerankEnabled: boolean('rerank_enabled').notNull().default(false),
    modelName: text('model_name').notNull(),
    recallAtK: real('recall_at_k'),
    ndcg: real('ndcg'),
    mrr: real('mrr'),
    latencyMs: real('latency_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('rag_runs_eval_run_idx').on(table.runId),
    index('rag_runs_eval_query_idx').on(table.queryId),
    index('rag_runs_eval_pipeline_idx').on(table.pipelineName),
  ]
);

// RAG Judge Results table - LLM-as-judge scoring
export const ragJudgeResults = pgTable(
  'rag_judge_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => ragRunsEvaluation.id, { onDelete: 'cascade' }),
    groundednessScore: integer('groundedness_score').notNull(),
    completenessScore: integer('completeness_score').notNull(),
    correctnessScore: integer('correctness_score').notNull(),
    hallucination: boolean('hallucination').notNull(),
    judgeMean: real('judge_mean').notNull(),
    judgeStd: real('judge_std').notNull(),
    failureType: varchar('failure_type', { length: 30 }).$type<
      'generation_failure' | 'retrieval_failure' | 'robust_generation' | 'normal' | 'hallucination_failure' | null
    >(),
    answerableFromContext: boolean('answerable_from_context'),
    judgeModel: text('judge_model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('rag_judge_evaluation_idx').on(table.evaluationId),
    index('rag_judge_failure_type_idx').on(table.failureType),
  ]
);

// RAG Preferences table - preference dataset for training
export const ragPreferences = pgTable(
  'rag_preferences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    question: text('question').notNull(),
    context: text('context').notNull(),
    answer: text('answer').notNull(),
    qualityScore: real('quality_score'),
    hallucination: boolean('hallucination').notNull().default(false),
    chosen: boolean('chosen').notNull().default(false),
    rejected: boolean('rejected').notNull().default(false),
    source: varchar('source', { length: 20 }).$type<'llm_judge' | 'user'>().notNull().default('llm_judge'),
    evaluationId: uuid('evaluation_id')
      .references(() => ragRunsEvaluation.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('rag_preferences_chosen_idx').on(table.chosen),
    index('rag_preferences_rejected_idx').on(table.rejected),
    index('rag_preferences_source_idx').on(table.source),
  ]
);

// RAG Models table - model registry for LoRA adapters
export const ragModels = pgTable(
  'rag_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    baseModel: text('base_model').notNull(),
    adapterPath: text('adapter_path'),
    datasetSize: integer('dataset_size').notNull().default(0),
    avgQualityScore: real('avg_quality_score'),
    active: boolean('active').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('rag_models_active_idx').on(table.active),
  ]
);

// Type exports for use with Drizzle
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

export type TraditionalChunk = typeof traditionalChunks.$inferSelect;
export type NewTraditionalChunk = typeof traditionalChunks.$inferInsert;

export type FactsChunk = typeof factsChunks.$inferSelect;
export type NewFactsChunk = typeof factsChunks.$inferInsert;

export type TestQuery = typeof testQueries.$inferSelect;
export type NewTestQuery = typeof testQueries.$inferInsert;

export type EvaluationRun = typeof evaluationRuns.$inferSelect;
export type NewEvaluationRun = typeof evaluationRuns.$inferInsert;

export type EvaluationResult = typeof evaluationResults.$inferSelect;
export type NewEvaluationResult = typeof evaluationResults.$inferInsert;

export type RagRunsEvaluation = typeof ragRunsEvaluation.$inferSelect;
export type NewRagRunsEvaluation = typeof ragRunsEvaluation.$inferInsert;

export type RagJudgeResult = typeof ragJudgeResults.$inferSelect;
export type NewRagJudgeResult = typeof ragJudgeResults.$inferInsert;

export type RagPreference = typeof ragPreferences.$inferSelect;
export type NewRagPreference = typeof ragPreferences.$inferInsert;

export type RagModel = typeof ragModels.$inferSelect;
export type NewRagModel = typeof ragModels.$inferInsert;

// Widget configuration — single-row table (id always = 1)
export const widgetConfig = pgTable('widget_config', {
  id: integer('id').primaryKey(),
  bgColor: text('bg_color').notNull().default('#0d0f1a'),
  primaryColor: text('primary_color').notNull().default('#6366f1'),
  title: text('title').notNull().default('Assistant'),
  badgeLabel: text('badge_label').notNull().default(''),
  badgeUrl: text('badge_url').notNull().default(''),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export type WidgetConfig = typeof widgetConfig.$inferSelect;
