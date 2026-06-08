/**
 * GET  /api/conversations  — list conversations (paginated, filterable)
 * DELETE /api/conversations  — batch delete by ids
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  listConversations,
  deleteConversations,
  getConversationStats,
} from '$lib/server/chat/conversations';

export const GET: RequestHandler = async ({ url }) => {
  try {
    const filter = (url.searchParams.get('filter') ?? 'all') as 'all' | 'unreviewed' | 'reviewed';
    const pipeline = (url.searchParams.get('pipeline') ?? 'all') as 'chunk' | 'fact' | 'llm' | 'all';
    const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10)));

    const [list, stats] = await Promise.all([
      listConversations({ filter, pipeline, page, limit }),
      getConversationStats(),
    ]);

    return json({ ...list, stats });
  } catch (err) {
    console.error('List conversations error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { ids } = body;

    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      return json({ error: 'ids must be an array of strings' }, { status: 400 });
    }

    await deleteConversations(ids);
    return json({ ok: true, deleted: ids.length });
  } catch (err) {
    console.error('Delete conversations error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};
