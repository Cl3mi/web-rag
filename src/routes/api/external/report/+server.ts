// src/routes/api/external/report/+server.ts
import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { getCollectorStore } from '$lib/server/collector/store';
import { summarizeRows } from '$lib/server/collector/scoring';
import { getQuestionSet } from '$lib/server/collector/questions';

const DB_PATH = env.COLLECTOR_DB_PATH || '/app/data/collector.db';

export const GET: RequestHandler = async ({ request, url }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) return json({ error: 'sessionId query param required' }, { status: 400 });

  const store = getCollectorStore(DB_PATH);
  const rows = store.rowsForSession(sessionId);
  const report = {
    systemLabel: store.systemLabel(sessionId) ?? 'unknown',
    sessionId,
    questionSetVersion: getQuestionSet().version,
    generatedAt: new Date().toISOString(),
    rows,
    summary: summarizeRows(rows),
  };

  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="eval-report-${sessionId}.json"`,
    },
  });
};
