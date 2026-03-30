/**
 * Unified LLM Client
 *
 * Single entry point for all LLM calls. Switch providers via LLM_PROVIDER in .env.
 * Supported: ollama (default) | openai | openrouter
 *
 * Each provider reads its own env vars (OLLAMA_*, OPENAI_*, OPENROUTER_*).
 * LLM_MODEL / LLM_JUDGE_MODEL override the active provider's model if set.
 */

import { env } from '$env/dynamic/private';

type Provider = 'ollama' | 'openai' | 'openrouter';

export interface GenerateOptions {
  model: string;
  prompt: string;
  systemPrompt?: string;
  temperature: number;
  topP: number;
  maxTokens: number;
}

export class LLMError extends Error {
  constructor(public readonly status: number, body: string) {
    super(`LLM provider returned ${status}: ${body.slice(0, 200)}`);
    this.name = 'LLMError';
  }
}

const provider = (env.LLM_PROVIDER as Provider) || 'ollama';

const PROVIDER_CONFIG: Record<Provider, { baseUrl: string; apiKey: string; model: string; judgeModel: string }> = {
  ollama: {
    baseUrl: env.OLLAMA_URL || 'http://localhost:11434',
    apiKey: '',
    model: env.OLLAMA_MODEL || 'llama3.2',
    judgeModel: env.OLLAMA_JUDGE_MODEL || env.OLLAMA_MODEL || 'llama3.2',
  },
  openai: {
    baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    apiKey: env.OPENAI_API_KEY || '',
    model: env.OPENAI_MODEL || 'gpt-4o',
    judgeModel: env.OPENAI_JUDGE_MODEL || env.OPENAI_MODEL || 'gpt-4o',
  },
  openrouter: {
    baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    apiKey: env.OPENROUTER_API_KEY || '',
    model: env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct',
    judgeModel: env.OPENROUTER_JUDGE_MODEL || env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct',
  },
};

const config = PROVIDER_CONFIG[provider];

// LLM_MODEL / LLM_JUDGE_MODEL act as global overrides across all providers
export const DEFAULT_MODEL = env.LLM_MODEL || config.model;
export const DEFAULT_JUDGE_MODEL = env.LLM_JUDGE_MODEL || config.judgeModel;

export async function generate(opts: GenerateOptions): Promise<string> {
  return provider === 'ollama' ? ollamaGenerate(opts) : openaiGenerate(opts);
}

export async function isAvailable(): Promise<boolean> {
  try {
    if (provider === 'ollama') {
      const res = await fetch(`${config.baseUrl}/api/tags`);
      return res.ok;
    }
    return Boolean(config.apiKey);
  } catch {
    return false;
  }
}

export async function listModels(): Promise<string[]> {
  if (provider !== 'ollama') return [];
  try {
    const res = await fetch(`${config.baseUrl}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}

// --- Internal implementations ---

async function ollamaGenerate(opts: GenerateOptions): Promise<string> {
  const { model, prompt, systemPrompt, temperature, topP, maxTokens } = opts;
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    options: { temperature, top_p: topP, num_predict: maxTokens },
  };
  if (systemPrompt) body.system = systemPrompt;

  const res = await fetch(`${config.baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new LLMError(res.status, await res.text());
  const data = await res.json();
  return (data.response || '').trim();
}

async function openaiGenerate(opts: GenerateOptions): Promise<string> {
  const { model, prompt, systemPrompt, temperature, topP, maxTokens } = opts;
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature, top_p: topP, max_tokens: maxTokens }),
  });

  if (!res.ok) throw new LLMError(res.status, await res.text());
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}
