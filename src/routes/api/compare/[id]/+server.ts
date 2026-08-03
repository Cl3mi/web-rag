import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getComparison } from '$lib/server/compare/store';

export const GET: RequestHandler = async ({ params }) => {
  const payload = await getComparison(params.id);
  if (!payload) return json({ error: 'Not found' }, { status: 404 });
  return json({ id: params.id, ...payload });
};
