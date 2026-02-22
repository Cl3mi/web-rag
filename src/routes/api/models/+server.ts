/**
 * Models API Endpoint
 *
 * GET /api/models - List all registered models
 * POST /api/models - Activate a model
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listModels, activateModel } from '$lib/server/evaluation/training';

export const GET: RequestHandler = async () => {
  try {
    const models = await listModels();
    return json({ models });
  } catch (error) {
    console.error('List models error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to list models' },
      { status: 500 }
    );
  }
};

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { modelId } = body;

    if (!modelId) {
      return json({ error: 'modelId is required' }, { status: 400 });
    }

    await activateModel(modelId);

    return json({ status: 'activated', modelId });
  } catch (error) {
    console.error('Activate model error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to activate model' },
      { status: 500 }
    );
  }
};
