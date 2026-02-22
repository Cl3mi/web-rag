/**
 * Drizzle ORM Database Client
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { getDatabaseUrl, databaseConfig } from '$lib/config/database';
import * as schema from './schema';

// Create postgres client
const connectionString = getDatabaseUrl();

const client = postgres(connectionString, {
  max: databaseConfig.maxConnections,
  idle_timeout: 20,
  connect_timeout: 10,
});

// Create drizzle instance with schema
export const db = drizzle(client, { schema });

// Export for direct SQL queries if needed
export { client as sql };

// Helper to check database connection
export async function checkConnection(): Promise<boolean> {
  try {
    await client`SELECT 1`;
    return true;
  } catch (error) {
    console.error('Database connection failed:', error);
    return false;
  }
}

// Initialize pgvector extension and create HNSW indexes
export async function initializeDatabase(): Promise<void> {
  try {
    // Enable pgvector extension
    await client`CREATE EXTENSION IF NOT EXISTS vector`;

    // Create documents table
    await client`
      CREATE TABLE IF NOT EXISTS documents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url TEXT NOT NULL,
        domain VARCHAR(255) NOT NULL,
        title TEXT,
        content_hash VARCHAR(64) NOT NULL,
        raw_html TEXT,
        raw_content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create unique index on URL
    await client`
      CREATE UNIQUE INDEX IF NOT EXISTS documents_url_idx ON documents(url)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS documents_domain_idx ON documents(domain)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS documents_content_hash_idx ON documents(content_hash)
    `;

    // Create traditional_chunks table with vector column
    await client`
      CREATE TABLE IF NOT EXISTS traditional_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        content_markdown TEXT NOT NULL,
        dense_embedding vector(1024),
        sparse_vector JSONB DEFAULT '{}',
        metadata JSONB NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create indexes for traditional_chunks
    await client`
      CREATE INDEX IF NOT EXISTS traditional_chunks_document_idx ON traditional_chunks(document_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS traditional_chunks_chunk_index_idx ON traditional_chunks(document_id, chunk_index)
    `;

    // Create HNSW index for traditional chunks vector search
    await client`
      CREATE INDEX IF NOT EXISTS traditional_chunks_embedding_idx
      ON traditional_chunks
      USING hnsw (dense_embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `;

    // Create facts_chunks table with vector column
    await client`
      CREATE TABLE IF NOT EXISTS facts_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        fact_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(20) NOT NULL,
        confidence REAL DEFAULT 1.0 NOT NULL,
        dense_embedding vector(1024),
        source_context TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create indexes for facts_chunks
    await client`
      CREATE INDEX IF NOT EXISTS facts_chunks_document_idx ON facts_chunks(document_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS facts_chunks_category_idx ON facts_chunks(category)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS facts_chunks_confidence_idx ON facts_chunks(confidence)
    `;

    // Create HNSW index for facts chunks vector search
    await client`
      CREATE INDEX IF NOT EXISTS facts_chunks_embedding_idx
      ON facts_chunks
      USING hnsw (dense_embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `;

    // Create llm_chunks table - chunks with LLM-generated summaries
    await client`
      CREATE TABLE IF NOT EXISTS llm_chunks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        original_content TEXT NOT NULL,
        summary TEXT NOT NULL,
        dense_embedding vector(1024),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    // Create indexes for llm_chunks
    await client`
      CREATE INDEX IF NOT EXISTS llm_chunks_document_idx ON llm_chunks(document_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS llm_chunks_chunk_index_idx ON llm_chunks(document_id, chunk_index)
    `;

    // Create HNSW index for llm chunks vector search
    await client`
      CREATE INDEX IF NOT EXISTS llm_chunks_embedding_idx
      ON llm_chunks
      USING hnsw (dense_embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `;

    // Create test_queries table
    await client`
      CREATE TABLE IF NOT EXISTS test_queries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        query TEXT NOT NULL,
        expected_document_ids JSONB NOT NULL,
        category VARCHAR(100),
        difficulty VARCHAR(20) DEFAULT 'medium',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    await client`
      CREATE INDEX IF NOT EXISTS test_queries_category_idx ON test_queries(category)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS test_queries_difficulty_idx ON test_queries(difficulty)
    `;

    // Create evaluation_runs table
    await client`
      CREATE TABLE IF NOT EXISTS evaluation_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT,
        pipeline VARCHAR(20) NOT NULL,
        config JSONB NOT NULL,
        metrics JSONB DEFAULT '{}',
        status VARCHAR(20) DEFAULT 'running',
        started_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
        completed_at TIMESTAMPTZ
      )
    `;

    await client`
      CREATE INDEX IF NOT EXISTS evaluation_runs_status_idx ON evaluation_runs(status)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS evaluation_runs_started_at_idx ON evaluation_runs(started_at)
    `;

    // Create evaluation_results table
    await client`
      CREATE TABLE IF NOT EXISTS evaluation_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
        query_id UUID NOT NULL REFERENCES test_queries(id) ON DELETE CASCADE,
        pipeline VARCHAR(20) NOT NULL,
        retrieved_ids JSONB NOT NULL,
        scores JSONB NOT NULL,
        metrics JSONB NOT NULL,
        latency_ms REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    await client`
      CREATE INDEX IF NOT EXISTS evaluation_results_run_idx ON evaluation_results(run_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS evaluation_results_query_idx ON evaluation_results(query_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS evaluation_results_pipeline_idx ON evaluation_results(pipeline)
    `;

    // Create rag_runs_evaluation table
    await client`
      CREATE TABLE IF NOT EXISTS rag_runs_evaluation (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id UUID NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
        query_id UUID NOT NULL REFERENCES test_queries(id) ON DELETE CASCADE,
        pipeline_name VARCHAR(20) NOT NULL,
        question TEXT NOT NULL,
        retrieved_doc_ids JSONB NOT NULL,
        retrieved_context TEXT NOT NULL,
        generated_answer TEXT NOT NULL,
        top_k INTEGER NOT NULL,
        rerank_enabled BOOLEAN NOT NULL DEFAULT false,
        model_name TEXT NOT NULL,
        recall_at_k REAL,
        ndcg REAL,
        mrr REAL,
        latency_ms REAL NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    await client`
      CREATE INDEX IF NOT EXISTS rag_runs_eval_run_idx ON rag_runs_evaluation(run_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS rag_runs_eval_query_idx ON rag_runs_evaluation(query_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS rag_runs_eval_pipeline_idx ON rag_runs_evaluation(pipeline_name)
    `;

    // Create rag_judge_results table
    await client`
      CREATE TABLE IF NOT EXISTS rag_judge_results (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        evaluation_id UUID NOT NULL REFERENCES rag_runs_evaluation(id) ON DELETE CASCADE,
        groundedness_score INTEGER NOT NULL,
        completeness_score INTEGER NOT NULL,
        correctness_score INTEGER NOT NULL,
        hallucination BOOLEAN NOT NULL,
        judge_mean REAL NOT NULL,
        judge_std REAL NOT NULL,
        failure_type VARCHAR(30),
        judge_model TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    await client`
      CREATE INDEX IF NOT EXISTS rag_judge_evaluation_idx ON rag_judge_results(evaluation_id)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS rag_judge_failure_type_idx ON rag_judge_results(failure_type)
    `;

    // Create rag_preferences table
    await client`
      CREATE TABLE IF NOT EXISTS rag_preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        question TEXT NOT NULL,
        context TEXT NOT NULL,
        answer TEXT NOT NULL,
        quality_score REAL,
        hallucination BOOLEAN NOT NULL DEFAULT false,
        chosen BOOLEAN NOT NULL DEFAULT false,
        rejected BOOLEAN NOT NULL DEFAULT false,
        source VARCHAR(20) NOT NULL DEFAULT 'llm_judge',
        evaluation_id UUID REFERENCES rag_runs_evaluation(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    await client`
      CREATE INDEX IF NOT EXISTS rag_preferences_chosen_idx ON rag_preferences(chosen)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS rag_preferences_rejected_idx ON rag_preferences(rejected)
    `;
    await client`
      CREATE INDEX IF NOT EXISTS rag_preferences_source_idx ON rag_preferences(source)
    `;

    // Create rag_models table
    await client`
      CREATE TABLE IF NOT EXISTS rag_models (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        base_model TEXT NOT NULL,
        adapter_path TEXT,
        dataset_size INTEGER NOT NULL DEFAULT 0,
        avg_quality_score REAL,
        active BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
      )
    `;

    await client`
      CREATE INDEX IF NOT EXISTS rag_models_active_idx ON rag_models(active)
    `;

    console.log('Database initialized successfully with pgvector and HNSW indexes');
  } catch (error) {
    console.error('Failed to initialize database:', error);
    throw error;
  }
}

// Close database connection
export async function closeConnection(): Promise<void> {
  await client.end();
}
