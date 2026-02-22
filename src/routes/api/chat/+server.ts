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
import { env } from '$env/dynamic/private';

const OLLAMA_BASE_URL = env.OLLAMA_URL || 'http://localhost:11434';
const DEFAULT_MODEL = env.OLLAMA_MODEL || 'llama3.2';

interface OllamaResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
}

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
    const systemPrompt = `You are a helpful assistant that answers questions based on the provided context. Use the context to answer the user's question accurately and concisely. If the context doesn't contain enough information to fully answer the question, say so.

Context:
${contextText}`;

    const generationStart = performance.now();

    // Call Ollama API
    const ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: message,
        system: systemPrompt,
        stream: false,
        options: {
          temperature: 0.7, // higher=more creative / lower=more logical
          top_p: 0.9, // vocabulary diversity | higher=wider range of words to choose from
          num_predict: 1024, // maximum answer length (in token)
        },
      }),
    });

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text();
      console.error('Ollama error:', errorText);
      return json(
        { error: `Ollama error: ${ollamaResponse.status}. Make sure Ollama is running with the model "${model}".` },
        { status: 502 }
      );
    }

    const ollamaData: OllamaResponse = await ollamaResponse.json();
    const generationTime = performance.now() - generationStart;
    const totalTime = performance.now() - startTime;

    return json({
      response: ollamaData.response,
      sources,
      pipeline,
      model: ollamaData.model,
      latencyMs: Math.round(totalTime),
      retrievalTimeMs: Math.round(retrievalTime),
      generationTimeMs: Math.round(generationTime),
    });
  } catch (error) {
    console.error('Chat error:', error);

    // Check if it's a connection error to Ollama
    if (error instanceof Error && error.message.includes('fetch')) {
      return json(
        { error: 'Cannot connect to Ollama. Make sure Ollama is running on localhost:11434.' },
        { status: 502 }
      );
    }

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
  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);

    if (!response.ok) {
      return json({ models: [], error: 'Cannot connect to Ollama' });
    }

    const data = await response.json();
    const models = (data.models || []).map((m: { name: string }) => m.name);

    return json({ models, defaultModel: DEFAULT_MODEL });
  } catch (error) {
    console.error('List models error:', error);
    return json({ models: [], error: 'Cannot connect to Ollama' });
  }
};
