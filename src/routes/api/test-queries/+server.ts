/**
 * Test Queries API Endpoint
 *
 * GET/POST /api/test-queries
 * Manage test queries for evaluation.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db/client';

/**
 * GET /api/test-queries
 * Get all test queries
 */
export const GET: RequestHandler = async () => {
  try {
    const rows = await sql`
      SELECT id, query, expected_document_ids, category, difficulty, metadata, created_at
      FROM test_queries
      ORDER BY created_at DESC
    `;

    // Map to camelCase for frontend
    const queries = rows.map((row: Record<string, unknown>) => ({
      id: row.id,
      query: row.query,
      expectedDocumentIds: row.expected_document_ids || [],
      category: row.category,
      difficulty: row.difficulty,
      metadata: row.metadata || {},
      createdAt: row.created_at,
    }));

    return json({ queries });
  } catch (error) {
    console.error('Get test queries error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};

/**
 * POST /api/test-queries
 * Create a new test query
 */
export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const {
      query,
      expectedDocumentIds,
      category = null,
      difficulty = 'medium',
      metadata = {},
    } = body;

    if (!query || typeof query !== 'string') {
      return json({ error: 'Query is required' }, { status: 400 });
    }

    // expectedDocumentIds is now optional (default to empty array)
    const docIds = Array.isArray(expectedDocumentIds) ? expectedDocumentIds : [];

    if (!['easy', 'medium', 'hard'].includes(difficulty)) {
      return json(
        { error: 'Difficulty must be "easy", "medium", or "hard"' },
        { status: 400 }
      );
    }

    const result = await sql`
      INSERT INTO test_queries (query, expected_document_ids, category, difficulty, metadata)
      VALUES (
        ${query},
        ${JSON.stringify(docIds)},
        ${category},
        ${difficulty},
        ${JSON.stringify(metadata)}
      )
      RETURNING id
    `;

    return json({
      id: result[0].id,
      message: 'Test query created successfully',
    });
  } catch (error) {
    console.error('Create test query error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};

/**
 * DELETE /api/test-queries
 * Delete a test query
 */
export const DELETE: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return json({ error: 'Query ID is required' }, { status: 400 });
    }

    await sql`DELETE FROM test_queries WHERE id = ${id}`;

    return json({ message: 'Test query deleted successfully' });
  } catch (error) {
    console.error('Delete test query error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};
