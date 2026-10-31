// HMAC helpers on WebCrypto (available in Deno and Node 20+), constant-time comparison.
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export async function hmacBase64(secretBytes, message) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  let s = ''; for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}

export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// "t=<unix seconds>,v1=<hex hmac of `${t}.${body}`>", rejected when older than toleranceSec (replay protection).
export async function signTimestamped(secret, body, now = Date.now()) {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}
export async function verifyTimestamped(secret, header, body, toleranceSec = 300, now = Date.now()) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.trim().split('=')));
  const t = +parts.t;
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  return safeEqual(parts.v1, await hmacHex(secret, `${t}.${body}`));
}

// Standard Webhooks (used by Supabase Auth hooks): headers webhook-id, webhook-timestamp, webhook-signature ("v1,<base64>").
export async function verifyStandardWebhook(secret, headers, body, toleranceSec = 300) {
  const id = headers.get('webhook-id'), ts = headers.get('webhook-timestamp'), sigs = headers.get('webhook-signature');
  if (!secret || !id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - +ts) > toleranceSec) return false;
  const raw = String(secret).replace(/^v1,/, '').replace(/^whsec_/, '');
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const want = await hmacBase64(bytes, `${id}.${ts}.${body}`);
  return sigs.split(' ').some((s) => safeEqual(s.split(',')[1], want));
}
