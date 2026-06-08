/**
 * POST /api/chat/feedback
 * Save or update user rating (thumbs up/down) for a chat message.
 * DELETE /api/chat/feedback  — clear feedback (discard)
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { saveFeedback, clearFeedback } from '$lib/server/chat/conversations';
import type { RatingCategory } from '$lib/server/chat/weights';

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { conversationId, rating, category, freetext } = body;

    if (!conversationId || typeof conversationId !== 'string') {
      return json({ error: 'conversationId is required' }, { status: 400 });
    }
    if (rating !== 'up' && rating !== 'down') {
      return json({ error: 'rating must be "up" or "down"' }, { status: 400 });
    }

    const result = await saveFeedback(
      conversationId,
      rating as 'up' | 'down',
      (category as RatingCategory) ?? null,
      (freetext as string) ?? null
    );

    return json({ ok: true, trainingWeight: result.trainingWeight });
  } catch (err) {
    console.error('Feedback error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { conversationId } = body;

    if (!conversationId || typeof conversationId !== 'string') {
      return json({ error: 'conversationId is required' }, { status: 400 });
    }

    await clearFeedback(conversationId);
    return json({ ok: true });
  } catch (err) {
    console.error('Clear feedback error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};
