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

export const POST: RequestHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const {
      message,
      pipeline = 'chunk',
      model = DEFAULT_MODEL,
      topK = 5,
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
      sources = results.map((r) => ({
        title: r.sourceTitle || null,
        url: r.sourceUrl || null,
        content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      }));
    } else if (pipeline === 'llm') {
      const results = await searchLLMChunks(message, { topK, minScore: 0.3 });
      context = results.map((r) => r.content);
      sources = results.map((r) => ({
        title: r.sourceTitle || null,
        url: r.sourceUrl || null,
        content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      }));
    } else {
      const results = await searchFacts(message, { topK, minScore: 0.3 });
      context = results.map((r) => r.content);
      sources = results.map((r) => ({
        title: r.sourceTitle || null,
        url: r.sourceUrl || null,
        content: r.content.slice(0, 200) + (r.content.length > 200 ? '...' : ''),
      }));
    }

    const retrievalTime = performance.now() - startTime;

    // If no context found, respond accordingly
    if (context.length === 0) {
      return json({
        response: "I don't have any relevant information in my knowledge base to answer this question. Please try crawling some documents first.",
        sources: [],
        pipeline,
        model,
        latencyMs: Math.round(performance.now() - startTime),
        retrievalTimeMs: Math.round(retrievalTime),
        generationTimeMs: 0,
      });
    }

    // Build prompt with context
    const contextText = context.map((c, i) => `[${i + 1}] ${c}`).join('\n\n');
    const systemPrompt = ` You are a helpful assistant that answers questions thoroughly and in detail based on the provided context. Give complete, well-structured answers. Use markdown formatting where appropriate (headings, bullet points, code blocks). Only state that information is missing if the context genuinely does not contain it.

    Context:
${contextText}`;

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

    return json({
      response,
      sources,
      pipeline,
      model,
      latencyMs: Math.round(totalTime),
      retrievalTimeMs: Math.round(retrievalTime),
      generationTimeMs: Math.round(generationTime),
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
