import { describe, it, expect } from 'vitest';
import { QuestionSet } from './questions';

const FIXTURE = {
  version: 'v1',
  queries: [
    { id: 'q1', query: 'a', category: 'c', difficulty: 'easy', expectedUrls: ['https://a.com'] },
    { id: 'q2', query: 'b', category: null, difficulty: null, expectedUrls: [] },
  ],
};

describe('QuestionSet', () => {
  it('exposes the version and public query list (no leaking internals)', () => {
    const qs = QuestionSet.fromObject(FIXTURE);
    expect(qs.version).toBe('v1');
    expect(qs.list()).toEqual([
      { id: 'q1', query: 'a', category: 'c', difficulty: 'easy', expectedUrls: ['https://a.com'] },
      { id: 'q2', query: 'b', category: null, difficulty: null, expectedUrls: [] },
    ]);
  });

  it('resolves expected URLs by id and throws on unknown id', () => {
    const qs = QuestionSet.fromObject(FIXTURE);
    expect(qs.expectedUrls('q1')).toEqual(['https://a.com']);
    expect(() => qs.expectedUrls('nope')).toThrow(/unknown queryId/i);
  });
});
