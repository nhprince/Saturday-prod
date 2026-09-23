/* ============================================================
   Saturday — admin auth
   A single shared secret signs short-lived bearer tokens. No
   session store: verification is pure and stateless, so any
   Worker instance can check a token without touching KV or D1.
   ============================================================ */
import { Env } from '../types';

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlToBytes = (s: string) => {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface AdminTokenPayload {
  role: 'admin';
  sub: string;      // who signed in — "admin" until real accounts exist
  iat: number;
  exp: number;
}

export async function signAdminToken(env: Env, sub = 'admin', ttlMs = 12 * 60 * 60_000): Promise<string> {
  if (!env.ADMIN_TOKEN_SECRET) throw new Error('ADMIN_TOKEN_SECRET is not configured');
  const payload: AdminTokenPayload = { role: 'admin', sub, iat: Date.now(), exp: Date.now() + ttlMs };
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(env.ADMIN_TOKEN_SECRET);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64url(new Uint8Array(mac))}`;
}

export async function verifyAdminToken(env: Env, token: string | null | undefined): Promise<AdminTokenPayload | null> {
  if (!token || !env.ADMIN_TOKEN_SECRET) return null;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return null;
  try {
    const key = await hmacKey(env.ADMIN_TOKEN_SECRET);
    const ok = await crypto.subtle.verify('HMAC', key, b64urlToBytes(sig), new TextEncoder().encode(payloadB64));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as AdminTokenPayload;
    if (payload.role !== 'admin' || !payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

/** Constant-time-ish compare for the admin password. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ============================================================
   Password rotation
   ADMIN_PASSWORD (a Worker secret) always works and needs no
   setup. Once an admin sets a panel password, its PBKDF2 hash in
   KV takes priority — so the credential can be rotated without
   touching secrets or redeploying.
   ============================================================ */
const PASSWORD_KEY = 'admin:password-hash';
const PBKDF2_ITERATIONS = 120_000;

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt.buffer as ArrayBuffer)}$${toHex(bits)}`;
}

async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = fromHex(parts[2]!);
  const expected = parts[3]!;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
    return safeEqual(toHex(bits), expected);
  } catch { return false; }
}

/** Once a panel password has been set, its KV hash is the ONLY credential —
 *  so rotation fully replaces the secret with no redeploy. Until then the
 *  env secret alone unlocks the panel. */
export async function verifyAdminPassword(env: Env, candidate: string): Promise<boolean> {
  if (!candidate) return false;
  const stored = await env.REGISTRY.get(PASSWORD_KEY);
  if (stored) return verifyPasswordHash(candidate, stored);
  return !!env.ADMIN_PASSWORD && safeEqual(candidate, env.ADMIN_PASSWORD);
}

export async function setAdminPassword(env: Env, newPassword: string): Promise<void> {
  await env.REGISTRY.put(PASSWORD_KEY, await hashPassword(newPassword));
}

export async function hasCustomAdminPassword(env: Env): Promise<boolean> {
  return !!(await env.REGISTRY.get(PASSWORD_KEY));
}
