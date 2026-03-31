import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db/client';
import { widgetConfig } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

export const load: LayoutServerLoad = async ({ cookies }) => {
  const [cfg] = await db.select().from(widgetConfig).where(eq(widgetConfig.id, 1));
  return {
    widgetBgColor: cfg?.bgColor ?? '#0d0f1a',
    widgetPrimaryColor: cfg?.primaryColor ?? '#6366f1',
    widgetTitle: cfg?.title ?? 'Assistant',
    widgetBadgeLabel: cfg?.badgeLabel ?? '',
    widgetBadgeUrl: cfg?.badgeUrl ?? '',
    widgetClosed: cookies.get('cw_closed') === '1',
  };
};
