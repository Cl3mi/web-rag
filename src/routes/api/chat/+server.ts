/**
 * Chat API Endpoint
 *
 * POST /api/chat
 * RAG-powered chat using selected pipeline and Ollama for generation.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { hybridSearch } from '$lib/server/pipeline/traditional/retriever';
import { searchFacts } from '$lib/server/pipeline/facts/retriever';
import { searchLLMChunks } from '$lib/server/pipeline/llm/retriever';
import { generate, listModels, DEFAULT_MODEL, ACTIVE_PROVIDER, LLMError } from '$lib/server/llm/client';
import { createSession, saveMessage } from '$lib/server/chat/conversations';
import { buildContextText, buildSystemPrompt } from '$lib/server/chat/prompt';

type Source = { title: string | null; url: string | null; content: string };

function dedupeSources(sources: Source[]): Source[] {
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    const key = s.url || s.title || s.content;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const {
      message,
      pipeline = 'chunk',
      model = DEFAULT_MODEL,
      topK = 5,
      sessionId = null,
    } = body;

    if (!message || typeof message !== 'string') {
      return json({ error: 'Message is required' }, { status: 400 });
    }

    if (!['chunk', 'fact', 'llm'].includes(pipeline)) {
      return json({ error: 'Pipeline must be "chunk", "fact", or "llm"' }, { status: 400 });
    }

    const startTime = performance.now();

    // Retrieve relevant context from the selected pipeline
    let context: string[] = [];
    let sources: Array<{ title: string | null; url: string | null; content: string }> = [];

    if (pipeline === 'chunk') {
      const results = await hybridSearch(message, { topK, minScore: 0.3 });
      context = results.map((r) => r.content);
      sources = dedupeSources(results.map((r) => ({
        title: r.sourceTitle || null,
        url: r.sourceUrl || null,
        content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      })));
    } else if (pipeline === 'llm') {
      const results = await searchLLMChunks(message, { topK, minScore: 0.3 });
      context = results.map((r) => r.content);
      sources = dedupeSources(results.map((r) => ({
        title: r.sourceTitle || null,
        url: r.sourceUrl || null,
        content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      })));
    } else {
      const results = await searchFacts(message, { topK, minScore: 0.3 });
      context = results.map((r) => r.content);
      sources = dedupeSources(results.map((r) => ({
        title: r.sourceTitle || null,
        url: r.sourceUrl || null,
        content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      })));
    }

    const retrievalTime = performance.now() - startTime;

    // If no context found, respond accordingly
    if (context.length === 0) {
      const noContextResponse = "I don't have any relevant information in my knowledge base to answer this question. Please try crawling some documents first.";
      const latencyMs = Math.round(performance.now() - startTime);

      // Ensure session exists, then save the empty-context exchange
      let activeSessionId = sessionId as string | null;
      try {
        if (!activeSessionId) {
          activeSessionId = await createSession(pipeline, model);
        }
        const conversationId = await saveMessage({
          sessionId: activeSessionId,
          question: message,
          answer: noContextResponse,
          context: [],
          sources: [],
          pipeline,
          model,
          latencyMs,
        });
        return json({
          response: noContextResponse,
          sources: [],
          pipeline,
          model,
          latencyMs,
          retrievalTimeMs: Math.round(retrievalTime),
          generationTimeMs: 0,
          sessionId: activeSessionId,
          conversationId,
        });
      } catch {
        return json({
          response: noContextResponse,
          sources: [],
          pipeline,
          model,
          latencyMs,
          retrievalTimeMs: Math.round(retrievalTime),
          generationTimeMs: 0,
        });
      }
    }

    const systemPrompt = buildSystemPrompt(buildContextText(context));

    const generationStart = performance.now();

    let response: string;
    try {
      response = await generate({
        model,
        prompt: message,
        systemPrompt,
        temperature: 0.7,
        topP: 0.9,
        maxTokens: 1024,
      });
    } catch (error) {
      if (error instanceof LLMError) {
        return json({ error: `LLM provider error (${error.status})` }, { status: 502 });
      }
      return json({ error: 'Cannot connect to LLM provider' }, { status: 502 });
    }

    const generationTime = performance.now() - generationStart;
    const totalTime = performance.now() - startTime;
    const latencyMs = Math.round(totalTime);

    // Persist the conversation
    let activeSessionId = sessionId as string | null;
    let conversationId: string | undefined;
    try {
      if (!activeSessionId) {
        activeSessionId = await createSession(pipeline, model);
      }
      conversationId = await saveMessage({
        sessionId: activeSessionId,
        question: message,
        answer: response,
        context,
        sources,
        pipeline,
        model,
        latencyMs,
      });
    } catch (err) {
      console.error('Failed to persist chat message:', err);
      // Non-fatal — still return the response to the user
    }

    return json({
      response,
      sources,
      pipeline,
      model,
      latencyMs,
      retrievalTimeMs: Math.round(retrievalTime),
      generationTimeMs: Math.round(generationTime),
      sessionId: activeSessionId,
      conversationId,
    });
  } catch (error) {
    console.error('Chat error:', error);
    return json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
};

/**
 * GET /api/chat/models
 * List available Ollama models
 */
export const GET: RequestHandler = async () => {
  // For Ollama: fetch the live model list from the local instance.
  // For OpenAI / OpenRouter: the model is fixed via env — return the default
  // as a single-item list so the frontend always has something to display.
  const models = ACTIVE_PROVIDER === 'ollama'
    ? await listModels()
    : [DEFAULT_MODEL];
  return json({ models, defaultModel: DEFAULT_MODEL, provider: ACTIVE_PROVIDER });
};
