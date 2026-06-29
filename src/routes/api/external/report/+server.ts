import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { exportReport } from '$lib/server/external/storage';

export const GET: RequestHandler = async ({ request, url }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const sessionId = url.searchParams.get('sessionId') ?? undefined;
  const report = await exportReport(sessionId);

  return new Response(JSON.stringify(report, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="eval-report-${sessionId ?? 'all'}.json"`,
    },
  });
};
