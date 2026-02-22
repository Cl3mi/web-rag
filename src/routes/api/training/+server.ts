/**
 * Training API Endpoint
 *
 * POST /api/training - Prepare LoRA training (export dataset + config + register model)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { trainLoraModel } from '$lib/server/evaluation/training';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const { baseModel, outputDir } = body;

    const result = await trainLoraModel({ baseModel, outputDir });

    return json({
      status: 'completed',
      ...result,
    });
  } catch (error) {
    console.error('Training error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Training pipeline failed' },
      { status: 500 }
    );
  }
};
