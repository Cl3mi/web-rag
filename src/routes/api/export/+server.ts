/**
 * Export API Endpoint
 *
 * POST /api/export - Export training data as JSONL
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exportDatasetToFile } from '$lib/server/evaluation/training';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const { outputDir } = body;

    const result = await exportDatasetToFile({ outputDir });

    return json({
      status: 'completed',
      path: result.path,
      rowCount: result.rowCount,
    });
  } catch (error) {
    console.error('Export error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Export failed' },
      { status: 500 }
    );
  }
};
