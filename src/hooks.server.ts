/**
 * Server Hooks
 *
 * Initialize database and preload models on server startup.
 */

import { error, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { initializeDatabase } from '$lib/server/db/client';
import { preloadModel } from '$lib/server/embeddings/bge-m3';
import { ensureExternalSchema } from '$lib/server/external/storage';

let initialized = false;

async function initialize() {
  if (initialized) return;

  console.log('Initializing server...');

  try {
    await initializeDatabase();
    console.log('Database initialized');

    await ensureExternalSchema();

    preloadModel().catch((err) => {
      console.warn('Failed to preload embedding model:', err);
    });

    initialized = true;
    console.log('Server initialization complete');
  } catch (err) {
    console.error('Server initialization failed:', err);
    throw err;
  }
}

const EVAL_SERVER_MODE = env.EVAL_SERVER_MODE === '1' || env.EVAL_SERVER_MODE === 'true';

export const handle: Handle = async ({ event, resolve }) => {
  await initialize();

  if (EVAL_SERVER_MODE) {
    const p = event.url.pathname;
    const allowed = p === '/' || p.startsWith('/api/external/') || p.startsWith('/_app/');
    if (!allowed) {
      throw error(404, 'Not found');
    }
  }

  return resolve(event);
};
