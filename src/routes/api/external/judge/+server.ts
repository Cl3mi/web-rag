import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireApiKey, UnauthorizedError } from '$lib/server/external/auth';
import { judgeAnswer, classifyFailureType } from '$lib/server/evaluation/judge';
import { DEFAULT_JUDGE_MODEL } from '$lib/server/llm/client';
import { recordJudge } from '$lib/server/external/storage';

interface Body {
  sessionId?: string;
  queryId?: string | null;
  query: string;
  context: string;
  answer: string;
  judgeRuns?: number;
  recallAtK?: number;
  clientMeta?: Record<string, unknown>;
}

export const POST: RequestHandler = async ({ request }) => {
  try {
    requireApiKey(request);
  } catch (e) {
    if (e instanceof UnauthorizedError) return json({ error: e.message }, { status: 401 });
    throw e;
  }

  const body = await request.json().catch(() => null) as Body | null;
  if (!body || !body.query || typeof body.context !== 'string' || typeof body.answer !== 'string') {
    return json({ error: 'Required: { query, context, answer }' }, { status: 400 });
  }

  const scores = await judgeAnswer({
    question: body.query,
    context: body.context,
    answer: body.answer,
    runs: body.judgeRuns ?? 3,
  });

  if (!scores) {
    return json({ error: 'Judge failed to produce a valid response' }, { status: 502 });
  }

  const judgeMean = (scores.groundedness + scores.completeness + scores.answerQuality) / 3;
  const failureType = classifyFailureType(
    body.recallAtK ?? null,
    judgeMean,
    scores.hallucination,
    scores.answerableFromContext,
  );

  const id = await recordJudge({
    sessionId: body.sessionId ?? 'default',
    queryId: body.queryId ?? null,
    queryText: body.query,
    retrievedContext: body.context,
    generatedAnswer: body.answer,
    clientMeta: body.clientMeta ?? {},
    scores: {
      groundedness: scores.groundedness,
      completeness: scores.completeness,
      correctness: scores.answerQuality,
      hallucination: scores.hallucination,
      judgeMean,
      answerableFromContext: scores.answerableFromContext,
      failureType,
      judgeModel: DEFAULT_JUDGE_MODEL,
    },
  });

  return json({
    id,
    scores: {
      groundedness: scores.groundedness,
      completeness: scores.completeness,
      correctness: scores.answerQuality,
      hallucination: scores.hallucination,
      answerableFromContext: scores.answerableFromContext,
      judgeMean,
      failureType,
      judgeModel: DEFAULT_JUDGE_MODEL,
    },
  });
};
