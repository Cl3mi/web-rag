import { sql } from '$lib/server/db/client';
import type { ComparisonPayload } from './types';

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await sql`
    CREATE TABLE IF NOT EXISTS comparison_runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label_a     text NOT NULL,
      label_b     text NOT NULL,
      payload     jsonb NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `;
  ensured = true;
}

export async function saveComparison(payload: ComparisonPayload): Promise<string> {
  await ensureSchema();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO comparison_runs (label_a, label_b, payload)
    VALUES (${payload.aggregates.a.systemLabel}, ${payload.aggregates.b.systemLabel},
            ${JSON.stringify(payload)}::jsonb)
    RETURNING id
  `;
  return rows[0].id;
}

export async function getComparison(id: string): Promise<ComparisonPayload | null> {
  await ensureSchema();
  const rows = await sql<{ payload: ComparisonPayload }[]>`
    SELECT payload FROM comparison_runs WHERE id = ${id}
  `;
  return rows[0]?.payload ?? null;
}

export async function listComparisons(): Promise<{ id: string; labelA: string; labelB: string; createdAt: string }[]> {
  await ensureSchema();
  const rows = await sql<{ id: string; label_a: string; label_b: string; created_at: string }[]>`
    SELECT id, label_a, label_b, created_at FROM comparison_runs ORDER BY created_at DESC
  `;
  return rows.map((r) => ({ id: r.id, labelA: r.label_a, labelB: r.label_b, createdAt: r.created_at }));
}
