// eval-dist/scripts/export-questions.ts
// Run from repo root: bun run eval-dist/scripts/export-questions.ts
// Reads DATABASE_* from .env, writes eval-dist/seed/questions.json.
import { writeFileSync } from 'node:fs';
import { sql } from '../../src/lib/server/db/client';

const VERSION = process.env.QUESTION_SET_VERSION || 'v1';

interface Row {
  id: string;
  query: string;
  category: string | null;
  difficulty: string | null;
  expected_urls: string[];
}

const rows = await sql<Row[]>`
  SELECT tq.id, tq.query, tq.category, tq.difficulty,
    COALESCE(
      (SELECT jsonb_agg(d.url ORDER BY d.url)
       FROM documents d
       WHERE d.id::text = ANY(SELECT jsonb_array_elements_text(tq.expected_document_ids))),
      '[]'::jsonb
    ) AS expected_urls
  FROM test_queries tq
  ORDER BY tq.created_at ASC
`;

const out = {
  version: VERSION,
  queries: rows.map((r) => ({
    id: r.id,
    query: r.query,
    category: r.category,
    difficulty: r.difficulty,
    expectedUrls: r.expected_urls ?? [],
  })),
};

writeFileSync(new URL('../seed/questions.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(`Wrote ${out.queries.length} queries (version ${VERSION}) to eval-dist/seed/questions.json`);
process.exit(0);
