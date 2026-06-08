import type { PageServerLoad } from './$types';
import { listConversations, getConversationStats } from '$lib/server/chat/conversations';

export const load: PageServerLoad = async ({ url }) => {
  const filter = (url.searchParams.get('filter') ?? 'all') as 'all' | 'unreviewed' | 'reviewed';
  const pipeline = (url.searchParams.get('pipeline') ?? 'all') as 'chunk' | 'fact' | 'llm' | 'all';

  const [list, stats] = await Promise.all([
    listConversations({ filter, pipeline, page: 1, limit: 50 }),
    getConversationStats(),
  ]);

  return { conversations: list.items, total: list.total, stats, filter, pipeline };
};
