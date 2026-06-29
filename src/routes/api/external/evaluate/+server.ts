import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import {
  calculateRecallAtK,
  calculateMRR,
  calculateNDCGBinary,
  calculateHitAtK,
} from '$lib/server/evaluation/metrics';
import { recordRetrieval } from '$lib/server/external/storage';

interface Body {
  sessionId?: string;
  queryId?: string | null;
  query: string;
  expectedUrls: string[];
  retrievedUrls: string[];
  k?: number;
  clientMeta?: Record<string, unknown>;
}

function normalize(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase();
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const body = await request.json().catch(() => null) as Body | null;
  if (!body || !body.query || !Array.isArray(body.expectedUrls) || !Array.isArray(body.retrievedUrls)) {
    return json({ error: 'Required: { query, expectedUrls[], retrievedUrls[] }' }, { status: 400 });
  }

  const expected = body.expectedUrls.map(normalize);
  const retrieved = body.retrievedUrls.map(normalize);
  const k = body.k ?? 10;

  const metrics = {
    recallAt5: calculateRecallAtK(retrieved, expected, 5),
    recallAt10: calculateRecallAtK(retrieved, expected, 10),
    mrr: calculateMRR(retrieved, expected),
    ndcg: calculateNDCGBinary(retrieved, expected, k),
    hitAt1: calculateHitAtK(retrieved, expected, 1),
    hitAt5: calculateHitAtK(retrieved, expected, 5),
    hitAt10: calculateHitAtK(retrieved, expected, 10),
  };

  const id = await recordRetrieval({
    sessionId: body.sessionId ?? 'default',
    queryId: body.queryId ?? null,
    queryText: body.query,
    expectedUrls: expected,
    retrievedUrls: retrieved,
    clientMeta: body.clientMeta ?? {},
    metrics,
  });

  return json({ id, metrics });
};
