/**
 * Server Hooks
 *
 * Initialize database and preload models on server startup.
 */

import { initializeDatabase } from '$lib/server/db/client';
import { preloadModel } from '$lib/server/embeddings/bge-m3';

let initialized = false;

async function initialize() {
  if (initialized) return;

  console.log('Initializing server...');

  try {
    // Initialize database
    await initializeDatabase();
    console.log('Database initialized');

    // Preload embedding model (in background)
    preloadModel().catch((error) => {
      console.warn('Failed to preload embedding model:', error);
    });

    initialized = true;
    console.log('Server initialization complete');
  } catch (error) {
    console.error('Server initialization failed:', error);
    throw error;
  }
}

// Initialize on first request
export async function handle({ event, resolve }) {
  await initialize();
  return resolve(event);
}
