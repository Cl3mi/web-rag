/**
 * Single Preference API
 *
 * PUT /api/preferences/[id]  — edit question, answer, training weight
 * DELETE /api/preferences/[id] — delete the row
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

export const PUT: RequestHandler = async ({ params, request }) => {
  const { id } = params;
  let body: { question?: unknown; answer?: unknown; trainingWeight?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const sets: string[] = [];
  const values: (string | number | boolean)[] = [];
  let idx = 1;

  if (typeof body.question === 'string' && body.question.trim()) {
    sets.push(`question = $${idx++}`);
    values.push(body.question.trim());
  }
  if (typeof body.answer === 'string' && body.answer.trim()) {
    sets.push(`answer = $${idx++}`);
    values.push(body.answer.trim());
  }
  if (typeof body.trainingWeight === 'number' && isFinite(body.trainingWeight)) {
    const clipped = Math.max(0.3, Math.min(2.0, body.trainingWeight));
    sets.push(`training_weight = $${idx++}`);
    values.push(clipped);
  }

  if (sets.length === 0) {
    return json({ error: 'Nothing to update' }, { status: 400 });
  }

  values.push(id);
  try {
    await sql.unsafe(
      `UPDATE rag_preferences SET ${sets.join(', ')} WHERE id = $${idx}`,
      values as (string | number)[]
    );
    return json({ ok: true });
  } catch (err) {
    console.error('Update preference error:', err);
    return json({ error: err instanceof Error ? err.message : 'DB error' }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  const { id } = params;
  try {
    await sql`DELETE FROM rag_preferences WHERE id = ${id}`;
    return json({ ok: true });
  } catch (err) {
    console.error('Delete preference error:', err);
    return json({ error: err instanceof Error ? err.message : 'DB error' }, { status: 500 });
  }
};
