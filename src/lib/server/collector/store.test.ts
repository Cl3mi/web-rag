import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorStore } from './store';
import type { CollectorRow } from './scoring';

let dir: string;
let store: CollectorStore;

const row = (queryId: string): CollectorRow => ({
  queryId, query: 'q', answer: 'a', context: 'c',
  expectedUrls: ['https://a.com'], retrievedUrls: ['https://a.com'],
  retrieval: { recallAt5: 1, recallAt10: 1, mrr: 1, ndcg: 1, hitAt1: 1, hitAt5: 1, hitAt10: 1 },
  latency: { retrievalMs: 10, generationMs: 20, totalMs: 30 },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'collector-'));
  store = new CollectorStore(join(dir, 'test.db'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('CollectorStore', () => {
  it('inserts rows and reads them back by session', () => {
    store.insert('s1', 'my-system', row('q1'));
    store.insert('s1', 'my-system', row('q2'));
    store.insert('s2', 'my-system', row('q1'));
    const s1 = store.rowsForSession('s1');
    expect(s1.map((r) => r.queryId)).toEqual(['q1', 'q2']);
    expect(store.rowsForSession('s2')).toHaveLength(1);
  });

  it('records systemLabel per session', () => {
    store.insert('s1', 'partner-org', row('q1'));
    expect(store.systemLabel('s1')).toBe('partner-org');
  });
});
