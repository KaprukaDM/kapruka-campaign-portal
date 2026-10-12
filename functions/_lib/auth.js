// functions/_lib/auth.js
// Shared auth primitives for the single, per-user login system:
//   - PBKDF2 password hashing/verification (Web Crypto; works in Workers —
//     bcrypt/scrypt are not available there)
//   - Signed, httpOnly session cookies (HMAC-SHA256, not encrypted — don't
//     put secrets in the payload, only user id/username/role)
//
// The `_lib` prefix keeps Cloudflare Pages from treating this as a route:
// Pages only auto-routes files whose path (after stripping `_middleware.js`
// and the `_lib`/`_`-prefixed convention) maps to a URL, so anything under
// `_lib/` is import-only, never publicly fetchable.

// Cloudflare Workers' crypto.subtle hard-caps PBKDF2 at 100,000 iterations
// (requests above that throw NotSupportedError) — confirmed by a live 500 on
// this exact code path. 100,000 is still within OWASP's historical PBKDF2-
// SHA256 guidance; it's the ceiling here, not an arbitrary choice.
const PBKDF2_ITERATIONS = 100000;
const SESSION_COOKIE = 'kapruka_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours

function toBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Password hashing ────────────────────────────────────────────────────

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  const salt = fromBase64(parts[2]);
  const expected = fromBase64(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(actual, expected);
}

async function pbkdf2(password, salt, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Session cookies (signed, not encrypted) ─────────────────────────────
// Payload is base64url(JSON) + "." + base64url(HMAC-SHA256 signature).
// Anyone can read the payload (it's just base64, no secret inside it should
// matter if exposed) but cannot forge or alter it without SESSION_SECRET.

function base64url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return fromBase64(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

async function hmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
  );
}

export async function createSessionCookie(payload, secret) {
  const enc = new TextEncoder();
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const token = `${body}.${base64url(new Uint8Array(sig))}`;
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  return attrs.join('; ');
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function readSession(request, secret) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  if (!match) return null;
  const token = match[1];
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const key = await hmacKey(secret);
  const enc = new TextEncoder();
  const valid = await crypto.subtle.verify('HMAC', key, base64urlToBytes(sig), enc.encode(body));
  if (!valid) return null;
  try {
    const json = new TextDecoder().decode(base64urlToBytes(body));
    const payload = JSON.parse(json);
    if (!payload || typeof payload.exp !== 'number' || Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sessionExpiry() {
  return Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
}
