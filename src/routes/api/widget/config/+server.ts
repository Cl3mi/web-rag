/**
 * Widget config API — stores and serves theme + content settings for the chat widget.
 * CORS-enabled so the externally embedded custom element can fetch its config.
 *
 * GET  /api/widget/config  → { bgColor, primaryColor, title, badgeLabel, badgeUrl }
 * POST /api/widget/config  → save all fields
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db/client';
import { widgetConfig } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';

const DEFAULTS = {
  bgColor: '#0d0f1a',
  primaryColor: '#6366f1',
  title: 'Assistant',
  badgeLabel: '',
  badgeUrl: '',
};
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export const OPTIONS: RequestHandler = async () =>
  new Response(null, { status: 204, headers: CORS });

export const GET: RequestHandler = async () => {
  const [cfg] = await db.select().from(widgetConfig).where(eq(widgetConfig.id, 1));
  return json(
    {
      bgColor: cfg?.bgColor ?? DEFAULTS.bgColor,
      primaryColor: cfg?.primaryColor ?? DEFAULTS.primaryColor,
      title: cfg?.title ?? DEFAULTS.title,
      badgeLabel: cfg?.badgeLabel ?? DEFAULTS.badgeLabel,
      badgeUrl: cfg?.badgeUrl ?? DEFAULTS.badgeUrl,
    },
    { headers: CORS }
  );
};

export const POST: RequestHandler = async ({ request }) => {
  let body: { bgColor?: unknown; primaryColor?: unknown; title?: unknown; badgeLabel?: unknown; badgeUrl?: unknown };
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { bgColor, primaryColor, title, badgeLabel, badgeUrl } = body;
  if (typeof bgColor !== 'string' || !HEX_RE.test(bgColor) ||
      typeof primaryColor !== 'string' || !HEX_RE.test(primaryColor)) {
    return json({ error: 'bgColor and primaryColor must be 6-digit hex strings' }, { status: 400 });
  }

  const t  = typeof title      === 'string' ? title.slice(0, 100)      : DEFAULTS.title;
  const bl = typeof badgeLabel === 'string' ? badgeLabel.slice(0, 60)  : DEFAULTS.badgeLabel;
  const bu = typeof badgeUrl   === 'string' ? badgeUrl.slice(0, 500)   : DEFAULTS.badgeUrl;

  await db.insert(widgetConfig)
    .values({ id: 1, bgColor, primaryColor, title: t, badgeLabel: bl, badgeUrl: bu })
    .onConflictDoUpdate({
      target: widgetConfig.id,
      set: { bgColor, primaryColor, title: t, badgeLabel: bl, badgeUrl: bu },
    });

  return json({ ok: true }, { headers: CORS });
};
