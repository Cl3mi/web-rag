// src/hooks.server.ts
/**
 * Server Hooks
 *
 * Normal mode: initialise Postgres + preload embedding model.
 * EVAL_SERVER_MODE: initialise the SQLite collector store + question set only,
 * and gate routing to /api/external/*.
 */
import { error, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { initializeDatabase } from '$lib/server/db/client';
import { preloadModel } from '$lib/server/embeddings/bge-m3';

const EVAL_SERVER_MODE = env.EVAL_SERVER_MODE === '1' || env.EVAL_SERVER_MODE === 'true';

let initialized = false;

async function initialize() {
  if (initialized) return;
  console.log('Initializing server...');

  if (EVAL_SERVER_MODE) {
    // Collector: no Postgres, no Ollama, no embedding model.
    const { getQuestionSet } = await import('$lib/server/collector/questions');
    const { getCollectorStore } = await import('$lib/server/collector/store');
    const dbPath = env.COLLECTOR_DB_PATH || '/app/data/collector.db';
    getQuestionSet();          // fail fast if questions.json is missing/invalid
    getCollectorStore(dbPath); // create schema
    initialized = true;
    console.log('Collector initialization complete');
    return;
  }

  try {
    await initializeDatabase();
    console.log('Database initialized');
    preloadModel().catch((err) => console.warn('Failed to preload embedding model:', err));
    initialized = true;
    console.log('Server initialization complete');
  } catch (err) {
    console.error('Server initialization failed:', err);
    throw err;
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  await initialize();

  if (EVAL_SERVER_MODE) {
    const p = event.url.pathname;
    const allowed = p === '/' || p.startsWith('/api/external/') || p.startsWith('/_app/');
    if (!allowed) throw error(404, 'Not found');
  }

  return resolve(event);
};
