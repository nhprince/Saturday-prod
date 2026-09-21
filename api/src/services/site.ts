/* ============================================================
   Saturday — site configuration
   A thin, well-known shape on top of the generic cms_content
   table, so the frontend can do one fetch and always get a
   complete, safe-to-apply config — even before an admin has
   touched anything.
   ============================================================ */
import { Env } from '../types';

export interface SiteBranding {
  name: string;
  tagline: string;
  favicon: string;   // an emoji, or an https:// image URL
  mark: string;       // '' = built-in mark; otherwise raw <svg>…</svg> markup or an https:// image URL
}
export interface SiteWelcome {
  heading: string;
  subheading: string;
  suggestions: string[];
}
export interface SiteComposer { placeholder: string; }
export interface SiteAnnouncement { enabled: boolean; text: string; }

export interface SiteConfig {
  branding: SiteBranding;
  welcome: SiteWelcome;
  composer: SiteComposer;
  announcement: SiteAnnouncement;
}

export const SITE_DEFAULTS: SiteConfig = {
  branding: { name: 'Saturday', tagline: 'A calm, intelligent AI companion.', favicon: '🪐', mark: '' },
  welcome: {
    heading: 'Saturday',
    subheading: 'What are we working on today?',
    suggestions: ['Help me plan my week.', 'Explain something difficult.', 'Write something for me.', 'Help me build an idea.'],
  },
  composer: { placeholder: 'Ask Saturday anything…' },
  announcement: { enabled: false, text: '' },
};

const KEYS: Array<keyof SiteConfig> = ['branding', 'welcome', 'composer', 'announcement'];

export async function assembleSiteConfig(env: Env): Promise<SiteConfig> {
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM cms_content WHERE key IN ('site.branding','site.welcome','site.composer','site.announcement')`,
  ).all<{ key: string; value: string }>();

  const rows = new Map(results.map((r) => [r.key.replace('site.', ''), r.value]));
  const out = { ...SITE_DEFAULTS };
  for (const k of KEYS) {
    const raw = rows.get(k);
    if (!raw) continue;
    try {
      out[k] = { ...SITE_DEFAULTS[k], ...JSON.parse(raw) } as any;
    } catch { /* malformed value from a manual CMS edit — keep the default for this section */ }
  }
  return out;
}
