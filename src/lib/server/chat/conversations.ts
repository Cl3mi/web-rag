/**
 * Chat Conversation Service
 *
 * CRUD operations for chat_sessions and chat_messages.
 * Handles saving, feedback, review workflow, and export to rag_preferences.
 */

import { sql } from '$lib/server/db/client';
import { calculateWeight, getDistribution } from './weights';
import type { RatingCategory } from './weights';

export interface SaveMessageInput {
  sessionId?: string | null;
  question: string;
  answer: string;
  context: string[];
  sources: Array<{ title: string | null; url: string | null; content: string }>;
  pipeline: 'chunk' | 'fact' | 'llm';
  model: string;
  latencyMs: number;
}

export interface ConversationListItem {
  id: string;
  sessionId: string | null;
  question: string;
  answer: string;
  pipeline: string;
  model: string;
  latencyMs: number;
  rating: 'up' | 'down' | null;
  ratingCategory: string | null;
  ratingFreetext: string | null;
  ratingCreatedAt: string | null;
  reviewedAt: string | null;
  trainingWeight: number | null;
  createdAt: string;
}

export interface ConversationDetail extends ConversationListItem {
  context: string[];
  sources: Array<{ title: string | null; url: string | null; content: string }>;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function createSession(
  pipeline: 'chunk' | 'fact' | 'llm',
  model: string
): Promise<string> {
  const rows = await sql`
    INSERT INTO chat_sessions (pipeline, model)
    VALUES (${pipeline}, ${model})
    RETURNING id
  `;
  return rows[0].id as string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function saveMessage(data: SaveMessageInput): Promise<string> {
  const rows = await sql`
    INSERT INTO chat_messages (
      session_id, question, answer, context, sources,
      pipeline, model, latency_ms
    ) VALUES (
      ${data.sessionId ?? null},
      ${data.question},
      ${data.answer},
      ${JSON.stringify(data.context)},
      ${JSON.stringify(data.sources)},
      ${data.pipeline},
      ${data.model},
      ${data.latencyMs}
    )
    RETURNING id
  `;
  return rows[0].id as string;
}

export async function saveFeedback(
  id: string,
  rating: 'up' | 'down',
  category?: RatingCategory | null,
  freetext?: string | null
): Promise<{ trainingWeight: number }> {
  const distribution = await getDistribution();
  const weight = calculateWeight(rating, category ?? null, distribution);

  await sql`
    UPDATE chat_messages
    SET
      rating = ${rating},
      rating_category = ${category ?? null},
      rating_freetext = ${freetext ?? null},
      rating_created_at = NOW(),
      training_weight = ${weight}
    WHERE id = ${id}
  `;

  return { trainingWeight: weight };
}

export async function clearFeedback(id: string): Promise<void> {
  await sql`
    UPDATE chat_messages
    SET
      rating = NULL,
      rating_category = NULL,
      rating_freetext = NULL,
      rating_created_at = NULL,
      training_weight = NULL
    WHERE id = ${id}
  `;
}

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

export async function listConversations(options: {
  filter?: 'all' | 'unreviewed' | 'reviewed';
  pipeline?: 'chunk' | 'fact' | 'llm' | 'all';
  page?: number;
  limit?: number;
} = {}): Promise<{ items: ConversationListItem[]; total: number }> {
  const { filter = 'all', pipeline = 'all', page = 1, limit = 50 } = options;
  const offset = (page - 1) * limit;

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let pIdx = 1;

  if (filter === 'unreviewed') {
    conditions.push(`reviewed_at IS NULL`);
  } else if (filter === 'reviewed') {
    conditions.push(`reviewed_at IS NOT NULL`);
  }

  if (pipeline !== 'all') {
    conditions.push(`pipeline = $${pIdx++}`);
    params.push(pipeline);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countRows = await sql.unsafe(
    `SELECT COUNT(*)::integer AS total FROM chat_messages ${where}`,
    params
  );
  const total = (countRows[0]?.total as number) ?? 0;

  params.push(limit, offset);
  const rows = await sql.unsafe(
    `SELECT id, session_id, question, answer, pipeline, model, latency_ms,
            rating, rating_category, rating_freetext, rating_created_at,
            reviewed_at, training_weight, created_at
     FROM chat_messages
     ${where}
     ORDER BY created_at DESC
     LIMIT $${pIdx++} OFFSET $${pIdx++}`,
    params
  );

  return {
    total,
    items: rows.map(mapListItem),
  };
}

export async function getConversation(id: string): Promise<ConversationDetail | null> {
  const rows = await sql`
    SELECT id, session_id, question, answer, context, sources, pipeline, model, latency_ms,
           rating, rating_category, rating_freetext, rating_created_at,
           reviewed_at, training_weight, created_at
    FROM chat_messages
    WHERE id = ${id}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    ...mapListItem(r),
    context: (r.context as string[]) ?? [],
    sources: (r.sources as Array<{ title: string | null; url: string | null; content: string }>) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Update / Delete
// ---------------------------------------------------------------------------

export async function updateConversation(
  id: string,
  updates: {
    question?: string;
    answer?: string;
    trainingWeight?: number;
  }
): Promise<void> {
  const sets: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;

  if (updates.question !== undefined) {
    sets.push(`question = $${idx++}`);
    params.push(updates.question);
  }
  if (updates.answer !== undefined) {
    sets.push(`answer = $${idx++}`);
    params.push(updates.answer);
  }
  if (updates.trainingWeight !== undefined) {
    // Always clip to [0.3, 2.0]
    const clipped = Math.max(0.3, Math.min(2.0, updates.trainingWeight));
    sets.push(`training_weight = $${idx++}`);
    params.push(clipped);
  }

  if (sets.length === 0) return;

  params.push(id);
  await sql.unsafe(
    `UPDATE chat_messages SET ${sets.join(', ')} WHERE id = $${idx}`,
    params
  );
}

export async function markReviewed(id: string): Promise<void> {
  await sql`
    UPDATE chat_messages
    SET reviewed_at = NOW()
    WHERE id = ${id}
  `;
}

export async function unmarkReviewed(id: string): Promise<void> {
  await sql`
    UPDATE chat_messages
    SET reviewed_at = NULL
    WHERE id = ${id}
  `;
}

export async function deleteConversation(id: string): Promise<void> {
  await sql`DELETE FROM chat_messages WHERE id = ${id}`;
}

export async function deleteConversations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`DELETE FROM chat_messages WHERE id = ANY(${ids}::uuid[])`;
}

// ---------------------------------------------------------------------------
// Export to preference dataset
// ---------------------------------------------------------------------------

export async function exportToPreferences(
  ids: string[]
): Promise<{ exported: number; chosen: number; rejected: number }> {
  if (ids.length === 0) return { exported: 0, chosen: 0, rejected: 0 };

  const rows = await sql`
    SELECT id, question, answer, context, rating, rating_category, training_weight
    FROM chat_messages
    WHERE id = ANY(${ids}::uuid[])
  `;

  let exported = 0;
  let chosen = 0;
  let rejected = 0;

  for (const row of rows) {
    const rating = row.rating as 'up' | 'down' | null;
    const isChosen = rating === 'up';
    const isRejected = rating === 'down';
    const contextArr = row.context as string[];
    const contextText = contextArr.join('\n\n').slice(0, 10000);
    const weight = row.training_weight !== null ? Number(row.training_weight) : 1.0;

    // Skip if already exported (no upsert — each manual export is an independent entry)
    await sql`
      INSERT INTO rag_preferences (
        question, context, answer,
        quality_score, hallucination, chosen, rejected,
        source, chat_message_id, training_weight
      ) VALUES (
        ${row.question as string},
        ${contextText},
        ${row.answer as string},
        ${null},
        ${false},
        ${isChosen},
        ${isRejected},
        'user',
        ${row.id as string},
        ${weight}
      )
      ON CONFLICT DO NOTHING
    `;

    exported++;
    if (isChosen) chosen++;
    if (isRejected) rejected++;
  }

  // Mark all exported messages as reviewed
  await sql`
    UPDATE chat_messages
    SET reviewed_at = COALESCE(reviewed_at, NOW())
    WHERE id = ANY(${ids}::uuid[])
  `;

  return { exported, chosen, rejected };
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export async function getConversationStats(): Promise<{
  total: number;
  unreviewed: number;
  reviewed: number;
  thumbsUp: number;
  thumbsDown: number;
  byPipeline: Record<string, number>;
}> {
  const rows = await sql`
    SELECT
      COUNT(*)::integer AS total,
      COUNT(*) FILTER (WHERE reviewed_at IS NULL)::integer AS unreviewed,
      COUNT(*) FILTER (WHERE reviewed_at IS NOT NULL)::integer AS reviewed,
      COUNT(*) FILTER (WHERE rating = 'up')::integer AS thumbs_up,
      COUNT(*) FILTER (WHERE rating = 'down')::integer AS thumbs_down
    FROM chat_messages
  `;
  const pRows = await sql`
    SELECT pipeline, COUNT(*)::integer AS cnt
    FROM chat_messages
    GROUP BY pipeline
  `;
  const byPipeline: Record<string, number> = {};
  for (const p of pRows) byPipeline[p.pipeline as string] = p.cnt as number;

  const r = rows[0];
  return {
    total: r.total as number,
    unreviewed: r.unreviewed as number,
    reviewed: r.reviewed as number,
    thumbsUp: r.thumbs_up as number,
    thumbsDown: r.thumbs_down as number,
    byPipeline,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapListItem(r: Record<string, unknown>): ConversationListItem {
  return {
    id: r.id as string,
    sessionId: (r.session_id as string | null) ?? null,
    question: r.question as string,
    answer: r.answer as string,
    pipeline: r.pipeline as string,
    model: r.model as string,
    latencyMs: Number(r.latency_ms),
    rating: (r.rating as 'up' | 'down' | null) ?? null,
    ratingCategory: (r.rating_category as string | null) ?? null,
    ratingFreetext: (r.rating_freetext as string | null) ?? null,
    ratingCreatedAt: r.rating_created_at ? new Date(r.rating_created_at as string).toISOString() : null,
    reviewedAt: r.reviewed_at ? new Date(r.reviewed_at as string).toISOString() : null,
    trainingWeight: r.training_weight !== null && r.training_weight !== undefined
      ? Number(r.training_weight)
      : null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}
