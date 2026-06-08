/**
 * POST /api/conversations/export
 * Export selected chat messages to rag_preferences (source='user').
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exportToPreferences } from '$lib/server/chat/conversations';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { ids } = body;

    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return json({ error: 'ids must be an array of strings' }, { status: 400 });
    }

    const result = await exportToPreferences(ids);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error('Export conversations error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};
