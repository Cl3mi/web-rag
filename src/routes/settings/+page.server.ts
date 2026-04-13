import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db/client';
import { widgetConfig } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const load: PageServerLoad = async () => {
  const [cfg] = await db.select().from(widgetConfig).where(eq(widgetConfig.id, 1));
  return {
    bgColor: cfg?.bgColor ?? '#0d0f1a',
    primaryColor: cfg?.primaryColor ?? '#6366f1',
    title: cfg?.title ?? 'Assistant',
    badgeLabel: cfg?.badgeLabel ?? '',
    badgeUrl: cfg?.badgeUrl ?? '',
    emptyText: cfg?.emptyText ?? 'Ask anything about the knowledge base',
    suggestedQuestions: (cfg?.suggestedQuestions ?? []) as string[],
  };
};
