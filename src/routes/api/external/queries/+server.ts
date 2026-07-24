import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { getQuestionSet } from '$lib/server/collector/questions';

export const GET: RequestHandler = async ({ request }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const qs = getQuestionSet();
  return json({ questionSetVersion: qs.version, queries: qs.list() });
};
