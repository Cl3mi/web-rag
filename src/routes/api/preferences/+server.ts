/**
 * Preferences API Endpoint
 *
 * POST /api/preferences - Populate preferences from judged data
 * GET /api/preferences - Get preference dataset statistics
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { populatePreferences, getPreferenceStats, getPreferenceSamples, repairPreferenceLinks, deletePreferencesByPipeline } from '$lib/server/evaluation/preferences';

export const POST: RequestHandler = async () => {
  try {
    const result = await populatePreferences();

    return json({
      status: 'completed',
      ...result,
    });
  } catch (error) {
    console.error('Populate preferences error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to populate preferences' },
      { status: 500 }
    );
  }
};

export const DELETE: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({}));
    const targets = Array.isArray(body.pipelines) ? (body.pipelines as string[]) : [];
    if (targets.length === 0) {
      return json({ error: 'pipelines array is required' }, { status: 400 });
    }
    const result = await deletePreferencesByPipeline(targets);
    return json({ ok: true, deleted: result.deleted });
  } catch (error) {
    console.error('Delete preferences error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to delete preferences' },
      { status: 500 }
    );
  }
};

export const GET: RequestHandler = async ({ url }) => {
  try {
    // Auto-repair preferences with missing evaluation_id links
    await repairPreferenceLinks();

    const filter = (url.searchParams.get('filter') || 'all') as 'all' | 'chosen' | 'rejected';
    const pipeline = url.searchParams.get('pipeline') || 'all';
    const [stats, samples] = await Promise.all([
      getPreferenceStats(),
      getPreferenceSamples({ filter, limit: 50, pipeline }),
    ]);
    return json({ stats, samples });
  } catch (error) {
    console.error('Get preferences stats error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to get preference stats' },
      { status: 500 }
    );
  }
};
