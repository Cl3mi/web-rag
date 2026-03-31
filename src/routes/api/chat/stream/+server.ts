/**
 * Streaming Chat API Endpoint
 *
 * POST /api/chat/stream
 * SSE stream: sources event, then token events, then done.
 * Uses the traditional chunk pipeline (hybrid BM25 + dense).
 */

import type { RequestHandler } from './$types';
import { hybridSearch } from '$lib/server/pipeline/traditional/retriever';
import { generateStream, DEFAULT_MODEL, LLMError } from '$lib/server/llm/client';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const OPTIONS: RequestHandler = async () =>
  new Response(null, { status: 204, headers: CORS_HEADERS });

export const POST: RequestHandler = async ({ request }) => {
  let body: { message?: unknown; topK?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return new Response(JSON.stringify({ error: 'message is required' }), { status: 400 });
  }
  const topK = typeof body.topK === 'number' ? body.topK : 5;

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: object) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Retrieve context with chunk pipeline
        const results = await hybridSearch(message, { topK, minScore: 0.1 });

        const sources = results.map((r) => ({
          title: r.sourceTitle ?? null,
          url: r.sourceUrl ?? null,
          content: r.content.slice(0, 200) + (r.content.length > 200 ? '…' : ''),
        }));

        send(controller, { type: 'sources', sources });

        if (results.length === 0) {
          send(controller, {
            type: 'token',
            token: "I don't have relevant information to answer this question. Try crawling some documents first.",
          });
          send(controller, { type: 'done' });
          controller.close();
          return;
        }

        const contextText = results.map((c, i) => `[${i + 1}] ${c.content}`).join('\n\n');
        const systemPrompt = `You are a helpful assistant that answers questions based on the provided context. Give thorough, well-structured answers. Use markdown formatting where appropriate.

Context:
${contextText}`;

        try {
          for await (const token of generateStream({
            model: DEFAULT_MODEL,
            prompt: message,
            systemPrompt,
            temperature: 0.7,
            topP: 0.9,
            maxTokens: 1024,
          })) {
            send(controller, { type: 'token', token });
          }
        } catch (err) {
          const msg = err instanceof LLMError
            ? `LLM error (${err.status})`
            : 'Cannot connect to LLM provider';
          send(controller, { type: 'error', error: msg });
          controller.close();
          return;
        }

        send(controller, { type: 'done' });
        controller.close();
      } catch (err) {
        send(controller, {
          type: 'error',
          error: err instanceof Error ? err.message : 'Internal server error',
        });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS_HEADERS,
    },
  });
};
