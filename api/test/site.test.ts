import { describe, it, expect } from 'vitest';
import { assembleSiteConfig, SITE_DEFAULTS } from '../src/services/site';
import { fakeEnv, fakeD1, fakeKV } from './helpers';

describe('site config assembly', () => {
  it('returns complete defaults when nothing is stored', async () => {
    const cfg = await assembleSiteConfig(fakeEnv());
    expect(cfg).toEqual(SITE_DEFAULTS);
  });

  it('merges stored sections over defaults, field by field', async () => {
    const env = fakeEnv({
      DB: fakeD1([{ key: 'site.branding', value: JSON.stringify({ name: 'Acme Chat' }) }]),
    } as any);
    const cfg = await assembleSiteConfig(env);
    expect(cfg.branding.name).toBe('Acme Chat');
    expect(cfg.branding.tagline).toBe(SITE_DEFAULTS.branding.tagline); // untouched
    expect(cfg.welcome).toEqual(SITE_DEFAULTS.welcome);                 // untouched
  });

  it('keeps a section at its default when the stored JSON is malformed', async () => {
    const env = fakeEnv({
      DB: fakeD1([{ key: 'site.composer', value: '{not json' }]),
    } as any);
    const cfg = await assembleSiteConfig(env);
    expect(cfg.composer).toEqual(SITE_DEFAULTS.composer);
  });

  it('ignores cms keys that are not part of the site schema', async () => {
    const env = fakeEnv({
      DB: fakeD1([{ key: 'unrelated.key', value: JSON.stringify({ name: 'Nope' }) }]),
    } as any);
    const cfg = await assembleSiteConfig(env);
    expect(cfg).toEqual(SITE_DEFAULTS);
  });
});

// referenced so the helper import stays meaningful if fakeKV is unused in this file
void fakeKV;
