/**
 * GET    /api/conversations/[id]  — full conversation detail
 * PUT    /api/conversations/[id]  — edit question/answer/weight, mark reviewed
 * DELETE /api/conversations/[id]  — delete single conversation
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
  getConversation,
  updateConversation,
  markReviewed,
  unmarkReviewed,
  deleteConversation,
} from '$lib/server/chat/conversations';

export const GET: RequestHandler = async ({ params }) => {
  try {
    const conv = await getConversation(params.id);
    if (!conv) return json({ error: 'Not found' }, { status: 404 });
    return json(conv);
  } catch (err) {
    console.error('Get conversation error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};

export const PUT: RequestHandler = async ({ params, request }) => {
  try {
    const body = await request.json();
    const { question, answer, trainingWeight, markReviewedFlag } = body;

    if (question !== undefined || answer !== undefined || trainingWeight !== undefined) {
      await updateConversation(params.id, {
        question: question as string | undefined,
        answer: answer as string | undefined,
        trainingWeight: trainingWeight as number | undefined,
      });
    }

    if (markReviewedFlag === true) {
      await markReviewed(params.id);
    } else if (markReviewedFlag === false) {
      await unmarkReviewed(params.id);
    }

    const updated = await getConversation(params.id);
    return json(updated);
  } catch (err) {
    console.error('Update conversation error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  try {
    await deleteConversation(params.id);
    return json({ ok: true });
  } catch (err) {
    console.error('Delete conversation error:', err);
    return json({ error: 'Internal server error' }, { status: 500 });
  }
};
