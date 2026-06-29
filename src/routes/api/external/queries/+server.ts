import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';

interface QueryRow {
  id: string;
  query: string;
  category: string | null;
  difficulty: string | null;
  expected_urls: string[];
}

export const GET: RequestHandler = async ({ request }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const rows = await sql<QueryRow[]>`
    SELECT
      tq.id,
      tq.query,
      tq.category,
      tq.difficulty,
      COALESCE(
        (SELECT jsonb_agg(d.url ORDER BY d.url)
         FROM documents d
         WHERE d.id::text = ANY(SELECT jsonb_array_elements_text(tq.expected_document_ids))),
        '[]'::jsonb
      ) AS expected_urls
    FROM test_queries tq
    ORDER BY tq.created_at ASC
  `;

  return json({
    queries: rows.map(r => ({
      id: r.id,
      query: r.query,
      category: r.category,
      difficulty: r.difficulty,
      expectedUrls: r.expected_urls ?? [],
    })),
  });
};
