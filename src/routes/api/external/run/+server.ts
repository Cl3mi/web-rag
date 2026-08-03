import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { getQuestionSet } from '$lib/server/collector/questions';
import { getCollectorStore } from '$lib/server/collector/store';
import { scoreRow, type CollectorRow } from '$lib/server/collector/scoring';

interface Body {
  sessionId?: string;
  systemLabel?: string;
  queryId: string;
  answer: string;
  context: string;
  retrievedUrls: string[];
  latency?: { retrievalMs?: number; generationMs?: number; totalMs?: number };
}

const DB_PATH = env.COLLECTOR_DB_PATH || '/app/data/collector.db';

export const POST: RequestHandler = async ({ request }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const body = (await request.json().catch(() => null)) as Body | null;
  if (
    !body ||
    typeof body.queryId !== 'string' ||
    typeof body.answer !== 'string' ||
    typeof body.context !== 'string' ||
    !Array.isArray(body.retrievedUrls)
  ) {
    return json(
      { error: 'Required: { queryId, answer, context, retrievedUrls[] } (+ optional latency)' },
      { status: 400 },
    );
  }

  let expectedUrls: string[];
  try {
    expectedUrls = getQuestionSet().expectedUrls(body.queryId);
  } catch (e) {
    return json({ error: (e as Error).message }, { status: 400 });
  }

  const query = getQuestionSet().list().find((q) => q.id === body.queryId)?.query ?? '';
  const retrieval = scoreRow(body.retrievedUrls, expectedUrls);
  const retrievalMs = body.latency?.retrievalMs ?? 0;
  const generationMs = body.latency?.generationMs ?? 0;
  const totalMs = body.latency?.totalMs ?? retrievalMs + generationMs;

  const row: CollectorRow = {
    queryId: body.queryId,
    query,
    answer: body.answer,
    context: body.context,
    expectedUrls,
    retrievedUrls: body.retrievedUrls,
    retrieval,
    latency: { retrievalMs, generationMs, totalMs },
  };

  const sessionId = body.sessionId ?? 'default';
  const systemLabel = body.systemLabel ?? 'unknown';
  getCollectorStore(DB_PATH).insert(sessionId, systemLabel, row);

  return json({ queryId: row.queryId, retrieval, latency: row.latency });
};
