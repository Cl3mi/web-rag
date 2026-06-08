/**
 * Scrape API Endpoint
 *
 * POST /api/scrape — fetch a single URL and process through all pipelines.
 * DELETE /api/scrape — remove a document and all its chunks/facts.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ingestUrl, type PipelineSelection } from '$lib/server/pipeline/shared/ingest';
import { sql } from '$lib/server/db/client';

function parsePipelines(raw: unknown): PipelineSelection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    chunk: typeof r.chunk === 'boolean' ? r.chunk : undefined,
    fact: typeof r.fact === 'boolean' ? r.fact : undefined,
    llm: typeof r.llm === 'boolean' ? r.llm : undefined,
  };
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { url, pipelines } = body;

    if (!url || typeof url !== 'string') {
      return json({ error: 'URL is required' }, { status: 400 });
    }

    // Validate URL
    try {
      new URL(url);
    } catch {
      return json({ error: 'Invalid URL format' }, { status: 400 });
    }

    console.log(`Fetching URL: ${url}`);
    const result = await ingestUrl(url, parsePipelines(pipelines));

    if (result.status === 'error') {
      return json({ error: result.error }, { status: 400 });
    }

    return json(result);
  } catch (error) {
    console.error('Scrape error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};

/**
 * DELETE /api/scrape
 * Delete a document and all its chunks/facts
 */
export const DELETE: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { documentId, url } = body;

    if (!documentId && !url) {
      return json({ error: 'documentId or url is required' }, { status: 400 });
    }

    let targetDocId = documentId;

    if (!targetDocId && url) {
      const result = await sql`
        SELECT id FROM documents WHERE url = ${url}
      `;
      if (result.length === 0) {
        return json({ error: 'Document not found' }, { status: 404 });
      }
      targetDocId = result[0].id;
    }

    await sql`DELETE FROM traditional_chunks WHERE document_id = ${targetDocId}`;
    await sql`DELETE FROM facts_chunks WHERE document_id = ${targetDocId}`;
    await sql`DELETE FROM llm_chunks WHERE document_id = ${targetDocId}`;

    const deleted = await sql`
      DELETE FROM documents WHERE id = ${targetDocId}
      RETURNING id, url, title
    `;

    if (deleted.length === 0) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    return json({
      success: true,
      deleted: {
        id: deleted[0].id,
        url: deleted[0].url,
        title: deleted[0].title,
      },
    });
  } catch (error) {
    console.error('Delete document error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
