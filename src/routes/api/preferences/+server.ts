/**
 * Preferences API Endpoint
 *
 * POST /api/preferences - Populate preferences from judged data
 * GET /api/preferences - Get preference dataset statistics
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { populatePreferences, getPreferenceStats, getPreferenceSamples, repairPreferenceLinks } from '$lib/server/evaluation/preferences';

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

export const GET: RequestHandler = async ({ url }) => {
  try {
    // Auto-repair preferences with missing evaluation_id links
    await repairPreferenceLinks();

    const filter = (url.searchParams.get('filter') || 'all') as 'all' | 'chosen' | 'rejected';
    const [stats, samples] = await Promise.all([
      getPreferenceStats(),
      getPreferenceSamples({ filter, limit: 50 }),
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
