/**
 * Sitemap API Endpoint
 *
 * GET  /api/sitemap?url=<sitemapUrl> — preview all page URLs in a sitemap (follows indexes)
 * POST /api/sitemap                  — ingest a user-selected subset of those URLs
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parseSitemapDeep } from '$lib/server/pipeline/shared/scraper';
import { ingestUrl } from '$lib/server/pipeline/shared/ingest';

export const GET: RequestHandler = async ({ url }) => {
  const sitemapUrl = url.searchParams.get('url');

  if (!sitemapUrl) {
    return json({ error: 'url parameter is required' }, { status: 400 });
  }

  try {
    new URL(sitemapUrl);
  } catch {
    return json({ error: 'Invalid URL format' }, { status: 400 });
  }

  try {
    console.log(`Parsing sitemap: ${sitemapUrl}`);
    const urls = await parseSitemapDeep(sitemapUrl);
    return json({ urls, total: urls.length });
  } catch (error) {
    console.error('Sitemap parse error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Failed to fetch or parse sitemap' },
      { status: 400 }
    );
  }
};

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const { urls } = body as { urls?: unknown[] };

  if (!Array.isArray(urls) || urls.length === 0) {
    return json({ error: 'urls array is required and must not be empty' }, { status: 400 });
  }
  if (!urls.every((u) => typeof u === 'string')) {
    return json({ error: 'All urls must be strings' }, { status: 400 });
  }

  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch { /* client disconnected */ }
      };

      let processed = 0;
      let unchanged = 0;
      let failed = 0;

      send({ type: 'start', total: urls.length });

      for (const url of urls as string[]) {
        console.log(`Ingesting: ${url}`);
        try {
          const result = await ingestUrl(url);

          if (result.status === 'processed') processed++;
          else if (result.status === 'unchanged') unchanged++;
          else failed++;

          send({
            type: 'progress',
            url: result.url,
            status: result.status,
            title: result.title,
            wordCount: result.wordCount,
            chunkCount: result.chunk.chunkCount,
            factCount: result.fact.factCount,
            llmChunkCount: result.llm.chunkCount,
            processingTimeMs: result.processingTimeMs,
            error: result.error,
          });
        } catch (e) {
          failed++;
          send({ type: 'progress', url, status: 'error', error: e instanceof Error ? e.message : 'Unknown error', chunkCount: 0, factCount: 0, llmChunkCount: 0 });
        }
      }

      send({ type: 'done', total: urls.length, processed, unchanged, failed });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
};
