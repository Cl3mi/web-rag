import { describe, it, expect } from 'vitest';
import { normalizeUrl, scoreRow, summarizeRows, type CollectorRow } from './scoring';

describe('normalizeUrl', () => {
  it('lowercases and strips trailing slashes', () => {
    expect(normalizeUrl('HTTPS://Example.com/Page/')).toBe('https://example.com/page');
    expect(normalizeUrl('  https://x.com  ')).toBe('https://x.com');
  });
});

describe('scoreRow', () => {
  it('computes retrieval metrics with normalized URL matching', () => {
    const m = scoreRow(
      ['https://A.com/', 'https://b.com'], // retrieved
      ['https://a.com'],                    // expected
    );
    expect(m.recallAt5).toBe(1);
    expect(m.recallAt10).toBe(1);
    expect(m.mrr).toBe(1);       // relevant at rank 1
    expect(m.hitAt1).toBe(1);
  });

  it('reports zero when nothing relevant retrieved', () => {
    const m = scoreRow(['https://x.com'], ['https://a.com']);
    expect(m.recallAt5).toBe(0);
    expect(m.mrr).toBe(0);
    expect(m.hitAt1).toBe(0);
  });
});

describe('summarizeRows', () => {
  it('averages retrieval metrics and computes latency stats', () => {
    const rows: CollectorRow[] = [
      {
        queryId: 'q1', query: 'a', answer: '', context: '',
        expectedUrls: ['https://a.com'], retrievedUrls: ['https://a.com'],
        retrieval: { recallAt5: 1, recallAt10: 1, mrr: 1, ndcg: 1, hitAt1: 1, hitAt5: 1, hitAt10: 1 },
        latency: { retrievalMs: 100, generationMs: 200, totalMs: 300 },
      },
      {
        queryId: 'q2', query: 'b', answer: '', context: '',
        expectedUrls: ['https://b.com'], retrievedUrls: ['https://x.com'],
        retrieval: { recallAt5: 0, recallAt10: 0, mrr: 0, ndcg: 0, hitAt1: 0, hitAt5: 0, hitAt10: 0 },
        latency: { retrievalMs: 300, generationMs: 400, totalMs: 700 },
      },
    ];
    const s = summarizeRows(rows);
    expect(s.total).toBe(2);
    expect(s.retrieval.recallAt5).toBe(0.5);
    expect(s.latency.totalMs.mean).toBe(500);
  });
});
