/**
 * Database configuration
 */

function getEnv(key: string, defaultValue: string): string {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[key] ?? defaultValue;
  }
  return defaultValue;
}

function getEnvInt(key: string, defaultValue: number): number {
  const value = getEnv(key, String(defaultValue));
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = getEnv(key, String(defaultValue));
  return value.toLowerCase() === 'true';
}

export const databaseConfig = {
  host: getEnv('DATABASE_HOST', 'localhost'),
  port: getEnvInt('DATABASE_PORT', 5432),
  database: getEnv('DATABASE_NAME', 'web_rag_lab'),
  user: getEnv('DATABASE_USER', 'rag_user'),
  password: getEnv('DATABASE_PASSWORD', 'rag_password'),
  ssl: getEnvBool('DATABASE_SSL', false),
  maxConnections: getEnvInt('DATABASE_MAX_CONNECTIONS', 10)
};

export function getDatabaseUrl(): string {
  const { host, port, database, user, password, ssl } = databaseConfig;
  const sslParam = ssl ? '?sslmode=require' : '';
  return `postgres://${user}:${password}@${host}:${port}/${database}${sslParam}`;
}

// Embedding dimensions — must match the active model and the pgvector column size.
// Changing this requires: bun run db:generate && bun run db:push + full reindex.
//   local  (Xenova/bge-m3):           1024
//   openai (text-embedding-3-small):  1536
//   openai (text-embedding-ada-002):  1536
export const EMBEDDING_DIMENSION = getEnvInt('EMBEDDING_DIMENSION', 1024);

// Vector search defaults
export const VECTOR_SEARCH_DEFAULTS = {
  matchCount: 10,
  similarityThreshold: 0.1,
  hybridAlpha: 0.7, // Weight for dense similarity in hybrid search
};

// Chunking configuration
export const CHUNKING_CONFIG = {
  maxTokens: 512,
  overlap: 128,
  minChunkSize: 50,
  charsPerToken: 4,
  preserveTables: true,
};

// Embedding configuration
export const EMBEDDING_CONFIG = {
  provider: getEnv('EMBEDDING_PROVIDER', 'local') as 'local' | 'openai',
  model: getEnv('LOCAL_EMBEDDING_MODEL', 'Xenova/bge-m3'),
  openaiModel: getEnv('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  batchSize: 32,
  dimensions: EMBEDDING_DIMENSION,
};
