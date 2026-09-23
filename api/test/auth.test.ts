import { describe, it, expect } from 'vitest';
import {
  signAdminToken, verifyAdminToken, hashPassword,
  verifyAdminPassword, setAdminPassword, hasCustomAdminPassword, safeEqual,
} from '../src/services/auth';
import { fakeEnv, fakeKV } from './helpers';

describe('admin bearer tokens', () => {
  it('round-trips a signed token', async () => {
    const env = fakeEnv();
    const token = await signAdminToken(env);
    const payload = await verifyAdminToken(env, token);
    expect(payload?.role).toBe('admin');
    expect(payload?.sub).toBe('admin');
    expect(payload!.exp).toBeGreaterThan(Date.now());
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAdminToken(fakeEnv());
    const other = fakeEnv({ ADMIN_TOKEN_SECRET: 'another-secret-entirely-abcdefghij' });
    expect(await verifyAdminToken(other, token)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const env = fakeEnv();
    const token = await signAdminToken(env);
    const [payloadB64, sig] = token.split('.');
    const forged = JSON.parse(atob(payloadB64!));
    forged.exp = Date.now() + 10 ** 10;
    const tampered = `${btoa(JSON.stringify(forged))}.${sig}`;
    expect(await verifyAdminToken(env, tampered)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const env = fakeEnv();
    const token = await signAdminToken(env, 'admin', -1000);
    expect(await verifyAdminToken(env, token)).toBeNull();
  });

  it('rejects malformed input without throwing', async () => {
    const env = fakeEnv();
    expect(await verifyAdminToken(env, undefined)).toBeNull();
    expect(await verifyAdminToken(env, 'not-a-token')).toBeNull();
    expect(await verifyAdminToken(env, '###.###')).toBeNull();
  });

  it('fails closed when no secret is configured', async () => {
    const env = fakeEnv({ ADMIN_TOKEN_SECRET: undefined });
    expect(await verifyAdminToken(env, 'anything.anything')).toBeNull();
  });
});

describe('admin passwords', () => {
  it('hashes with pbkdf2 and verifies the original', async () => {
    const hash = await hashPassword('hunter2-hunter2');
    expect(hash.startsWith('pbkdf2$120000$')).toBe(true);
    const env = fakeEnv();
    await env.REGISTRY.put('admin:password-hash', hash);
    expect(await verifyAdminPassword(env, 'hunter2-hunter2')).toBe(true);
    expect(await verifyAdminPassword(env, 'wrong')).toBe(false);
  });

  it('falls back to the env secret when no rotation exists', async () => {
    const env = fakeEnv();
    expect(await verifyAdminPassword(env, 'correct horse battery staple')).toBe(true);
    expect(await verifyAdminPassword(env, 'nope')).toBe(false);
  });

  it('a rotated password takes priority over the env secret', async () => {
    const env = fakeEnv();
    expect(await hasCustomAdminPassword(env)).toBe(false);
    await setAdminPassword(env, 'new-panel-password');
    expect(await hasCustomAdminPassword(env)).toBe(true);
    // The old secret no longer works; only the rotated password does.
    expect(await verifyAdminPassword(env, 'correct horse battery staple')).toBe(false);
    expect(await verifyAdminPassword(env, 'new-panel-password')).toBe(true);
  });

  it('rejects empty candidates without touching storage', async () => {
    expect(await verifyAdminPassword(fakeEnv(), '')).toBe(false);
  });

  it('never treats a garbage stored hash as valid', async () => {
    const kv = fakeKV();
    const env = fakeEnv({ REGISTRY: kv });
    await kv.put('admin:password-hash', 'garbage-not-a-real-hash');
    expect(await verifyAdminPassword(env, 'anything')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
