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
import { createSession, saveMessage } from '$lib/server/chat/conversations';
import { buildContextText, buildSystemPrompt } from '$lib/server/chat/prompt';

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
  const incomingSessionId = typeof (body as { sessionId?: unknown }).sessionId === 'string'
    ? (body as { sessionId: string }).sessionId
    : null;

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, data: object) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  };

  const startTime = performance.now();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Retrieve context with chunk pipeline
        const results = await hybridSearch(message, { topK, minScore: 0.1 });

        const rawSources = results.map((r) => ({
          title: r.sourceTitle ?? null,
          url: r.sourceUrl ?? null,
          content: r.content.slice(0, 200) + (r.content.length > 200 ? '…' : ''),
        }));
        const seenSourceKeys = new Set<string>();
        const sources: typeof rawSources = [];
        for (const s of rawSources) {
          const key = s.url || s.title || s.content;
          if (!key || seenSourceKeys.has(key)) continue;
          seenSourceKeys.add(key);
          sources.push(s);
        }
        const context = results.map((r) => r.content);

        send(controller, { type: 'sources', sources });

        if (results.length === 0) {
          const noCtxAnswer = 'Zu dieser Frage liegen mir leider keine passenden Informationen vor. Bitte wende dich für nähere Auskünfte direkt an das Unternehmen.';
          send(controller, { type: 'token', token: noCtxAnswer });

          // Persist even the no-context response
          try {
            let sessionId = incomingSessionId;
            if (!sessionId) sessionId = await createSession('chunk', DEFAULT_MODEL);
            const conversationId = await saveMessage({
              sessionId,
              question: message,
              answer: noCtxAnswer,
              context: [],
              sources: [],
              pipeline: 'chunk',
              model: DEFAULT_MODEL,
              latencyMs: Math.round(performance.now() - startTime),
            });
            send(controller, { type: 'saved', conversationId, sessionId });
          } catch { /* non-fatal */ }

          send(controller, { type: 'done' });
          controller.close();
          return;
        }

        const systemPrompt = buildSystemPrompt(buildContextText(context));

        // Collect tokens while streaming so we can persist the full answer
        let fullAnswer = '';
        try {
          for await (const token of generateStream({
            model: DEFAULT_MODEL,
            prompt: message,
            systemPrompt,
            temperature: 0.7,
            topP: 0.9,
            maxTokens: 1024,
          })) {
            fullAnswer += token;
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

        // Persist the completed conversation before signalling done
        try {
          let sessionId = incomingSessionId;
          if (!sessionId) sessionId = await createSession('chunk', DEFAULT_MODEL);
          const conversationId = await saveMessage({
            sessionId,
            question: message,
            answer: fullAnswer,
            context,
            sources,
            pipeline: 'chunk',
            model: DEFAULT_MODEL,
            latencyMs: Math.round(performance.now() - startTime),
          });
          send(controller, { type: 'saved', conversationId, sessionId });
        } catch { /* non-fatal — don't block the response */ }

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
