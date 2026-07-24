import { readFileSync } from 'node:fs';
import { env } from '$env/dynamic/private';

export interface PublicQuery {
  id: string;
  query: string;
  category: string | null;
  difficulty: string | null;
  expectedUrls: string[];
}

interface QuestionSetFile {
  version: string;
  queries: PublicQuery[];
}

export class QuestionSet {
  private constructor(
    public readonly version: string,
    private readonly queries: PublicQuery[],
  ) {}

  static fromObject(obj: QuestionSetFile): QuestionSet {
    if (!obj || typeof obj.version !== 'string' || !Array.isArray(obj.queries)) {
      throw new Error('Invalid question set: expected { version, queries[] }');
    }
    const queries = obj.queries.map((q) => ({
      id: q.id,
      query: q.query,
      category: q.category ?? null,
      difficulty: q.difficulty ?? null,
      expectedUrls: q.expectedUrls ?? [],
    }));
    return new QuestionSet(obj.version, queries);
  }

  static fromFile(path: string): QuestionSet {
    return QuestionSet.fromObject(JSON.parse(readFileSync(path, 'utf8')));
  }

  list(): PublicQuery[] {
    return this.queries.map((q) => ({ ...q, expectedUrls: [...q.expectedUrls] }));
  }

  expectedUrls(queryId: string): string[] {
    const q = this.queries.find((x) => x.id === queryId);
    if (!q) throw new Error(`unknown queryId: ${queryId}`);
    return [...q.expectedUrls];
  }
}

let cached: QuestionSet | null = null;

/** Runtime singleton, loaded from QUESTIONS_PATH (default: bundled seed). */
export function getQuestionSet(): QuestionSet {
  if (cached) return cached;
  const path = env.QUESTIONS_PATH || '/app/seed/questions.json';
  cached = QuestionSet.fromFile(path);
  return cached;
}
