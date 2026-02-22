/**
 * Documents API Endpoint
 *
 * GET /api/documents
 * List all indexed documents for selection.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

/**
 * GET /api/documents
 * Get all documents with basic info for selection
 */
export const GET: RequestHandler = async () => {
  try {
    const rows = await sql`
      SELECT id, url, title, domain, created_at, updated_at
      FROM documents
      ORDER BY updated_at DESC
      LIMIT 500
    `;

    // Map to camelCase for frontend
    const documents = rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      domain: row.domain,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return json({ documents });
  } catch (error) {
    console.error('Get documents error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
