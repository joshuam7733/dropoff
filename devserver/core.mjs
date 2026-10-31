// Drop Off · Supabase-compatible backend core (environment-neutral).
// One implementation of the auth, REST/RPC, storage and Edge Function endpoints the apps call, used by:
//   · devserver/server.mjs   — Node, HTTP on :54321 (local development and the API test)
//   · prototype/local/*.mjs  — inside the Android apps' WebView, so the apps work on a phone with no server
// Only WebCrypto and a PGlite database are used, so it runs unchanged in Node 20+ and modern browsers.
// Development/demo only: fixed JWT secret, auto-confirmed e-mail, codes delivered to an in-app inbox.

const enc = new TextEncoder(), dec = new TextDecoder();
const b64uBytes = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); };
const b64u = (str) => b64uBytes(enc.encode(str));
const unb64u = (s) => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(t + '==='.slice((t.length + 3) % 4)); return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const safeEqual = (a, b) => { a = String(a); b = String(b); if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');

export const DEV_TABLES = `
  create schema if not exists dev;
  create table if not exists dev.applied (name text primary key, at timestamptz default now());
  create table if not exists dev.files (bucket text, name text, data bytea, primary key (bucket, name));
  create table if not exists dev.inbox (id bigint generated always as identity primary key, kind text, to_ text, subject text, body text, link text, at timestamptz default now());
  create table if not exists dev.otps (key text primary key, hash text, exp bigint, tries int default 0, sent bigint, user_id uuid);`;

// Applies the shim (first run), migrations not yet applied, and optionally the demo seed.
export async function bootstrap(db, { shim, migrations, seed, appUrl, log }) {
  const say = log || (() => {});
  const fresh = !(await db.query(`select 1 from pg_namespace where nspname = 'dev'`)).rows.length;
  if (fresh) { say('· first start: creating the database'); await db.exec(shim); }
  await db.exec(DEV_TABLES);
  const done = new Set((await db.query(`select name from dev.applied`)).rows.map((r) => r.name));
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    say('· migration ' + m.name);
    await db.exec(m.sql);
    await db.query(`insert into dev.applied (name) values ($1)`, [m.name]);
  }
  if (appUrl) await db.query(`update public.app_settings set value = to_jsonb($1::text) where key = 'tracking_base_url'`, [appUrl + '/track.html?t=']);
  if (seed && !done.has('seed.sql')) {
    say('· loading demo seed (supabase/seed.sql)');
    await db.exec(seed);
    await db.query(`insert into dev.applied (name) values ('seed.sql')`);
  }
}

export async function createBackend({ db, apiUrl, appUrl, secret, payments, log }) {
  const say = log || (() => {});
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hmac = async (msg) => b64uBytes(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg))));
  async function sign(payload) {
    const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), p = b64u(JSON.stringify(payload));
    return h + '.' + p + '.' + (await hmac(h + '.' + p));
  }
  async function verify(token) {
    const [h, p, s] = String(token || '').split('.');
    if (!s) return null;
    if (!safeEqual(await hmac(h + '.' + p), s)) return null;
    let c; try { c = JSON.parse(unb64u(p)); } catch (e) { return null; }
    if (c.exp && c.exp < Date.now() / 1000) return null;
    return c;
  }
  const ANON_KEY = await sign({ iss: 'supabase-demo', role: 'anon', iat: 1790000000, exp: 2105000000 });

  /* ---------------- helpers ---------------- */
  async function asRole(claims, fn) {
    const role = ['anon', 'authenticated', 'service_role'].includes(claims && claims.role) ? claims.role : 'anon';
    return db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)`,
        [JSON.stringify(claims || { role }), (claims && claims.sub) || '', role]);
      await tx.exec('set local role ' + role);
      return fn(tx);
    });
  }
  const CORS = {
    'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,apikey,content-type,x-client-info,prefer,range,accept-profile,content-profile,x-upsert,cache-control,x-supabase-api-version,x-region',
    'access-control-expose-headers': 'content-range,x-supabase-api-version'
  };
  // JSON responses (every value, including plain strings, is JSON-encoded like PostgREST does)
  const out = (status, body, headers) => ({ status, headers: { ...CORS, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(headers || {}) },
    body: body === undefined ? null : JSON.stringify(body) });
  // raw responses: HTML pages and file bytes
  const raw = (status, body, headers) => ({ status, headers: { ...CORS, ...(headers || {}) }, body });
  const redirect = (location) => ({ status: 303, headers: { ...CORS, location }, body: null });
  const html = (s) => raw(200, s, { 'content-type': 'text/html; charset=utf-8' });
  const json = (bytes) => { try { return bytes && bytes.length ? JSON.parse(dec.decode(bytes)) : {}; } catch (e) { return {}; } };
  const claimsOf = async (req) => {
    const auth = req.headers.get('authorization') || '';
    return (await verify(auth.startsWith('Bearer ') ? auth.slice(7) : req.headers.get('apikey'))) || { role: 'anon' };
  };
  const pgError = (e) => [e.code === '42501' ? 403 : e.code === 'P0002' ? 404 : e.code === '28000' ? 401 : 400,
    { code: e.code || 'XX000', details: e.detail || null, hint: e.hint || null, message: e.message }];
  const authErr = (status, code, msg) => out(status, { code: status, error_code: code, msg, message: msg, error: code, error_description: msg });
  const inboxAdd = (m) => db.query(`insert into dev.inbox (kind, to_, subject, body, link) values ($1, $2, $3, $4, $5)`, [m.kind, m.to, m.subject, m.body || null, m.link || null]);
  const inbox = async (n) => (await db.query(`select kind, to_ as "to", subject, body, link, at from dev.inbox order by id desc limit $1`, [n || 20])).rows;

  /* ---------------- auth (GoTrue subset) ---------------- */
  function userJson(u) {
    const prov = (u.raw_app_meta_data && u.raw_app_meta_data.provider) || 'email';
    return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email || '', email_confirmed_at: u.email_confirmed_at, phone: u.phone || '',
      phone_confirmed_at: u.phone_confirmed_at, confirmed_at: u.email_confirmed_at || u.phone_confirmed_at, last_sign_in_at: u.last_sign_in_at,
      app_metadata: u.raw_app_meta_data || {}, user_metadata: u.raw_user_meta_data || {},
      identities: [{ id: u.id, user_id: u.id, provider: prov, identity_data: { sub: u.id, email: u.email } }],
      created_at: u.created_at, updated_at: u.updated_at, is_anonymous: false };
  }
  async function session(u, method) {
    const now = Math.floor(Date.now() / 1000);
    const access = await sign({ aud: 'authenticated', exp: now + 3600, iat: now, iss: apiUrl + '/auth/v1', sub: u.id, email: u.email || '', phone: u.phone || '',
      app_metadata: u.raw_app_meta_data || {}, user_metadata: u.raw_user_meta_data || {}, role: 'authenticated', aal: 'aal1',
      amr: [{ method: method || 'password', timestamp: now }], session_id: crypto.randomUUID(), is_anonymous: false });
    const refresh = randomHex(18);
    await db.query(`insert into auth.refresh_tokens (token, user_id) values ($1, $2)`, [refresh, u.id]);
    await db.query(`update auth.users set last_sign_in_at = now() where id = $1`, [u.id]);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: userJson(u) };
  }
  const getUser = async (id) => (await db.query(`select * from auth.users where id = $1`, [id])).rows[0];
  const hashTo = (s) => `#access_token=${s.access_token}&expires_at=${s.expires_at}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer`;
  const safeRedirect = (r) => (typeof r === 'string' && (r.startsWith(appUrl + '/') || r === appUrl) ? r : appUrl + '/app.html');
  const phoneDigits = (p) => { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('0')) d = '256' + d.slice(1); if (d.length === 9) d = '256' + d; return d; };
  const otpHash = async (code) => hex(await crypto.subtle.digest('SHA-256', enc.encode(secret + code)));
  async function issueOtp(k, phone, purpose, userId) {
    const prev = (await db.query(`select sent from dev.otps where key = $1`, [k])).rows[0];
    if (prev && Date.now() - +prev.sent < 30000) return { wait: Math.ceil((30000 - (Date.now() - +prev.sent)) / 1000) };
    const code = randomCode();
    await db.query(`insert into dev.otps (key, hash, exp, tries, sent, user_id) values ($1, $2, $3, 0, $4, $5)
      on conflict (key) do update set hash = excluded.hash, exp = excluded.exp, tries = 0, sent = excluded.sent, user_id = excluded.user_id`,
      [k, await otpHash(code), Date.now() + 10 * 60000, Date.now(), userId || null]);
    await inboxAdd({ kind: 'sms', to: '+' + phone, subject: 'Drop Off code ' + code, body: `Your Drop Off code is ${code}. It expires in 10 minutes. (${purpose})` });
    say('· OTP for +' + phone + ' → ' + code + ' (' + purpose + ')');
    return { ok: true };
  }
  async function checkOtp(k, code) {
    const o = (await db.query(`select * from dev.otps where key = $1`, [k])).rows[0];
    if (!o || +o.exp < Date.now()) return 'expired';
    if (o.tries >= 5) return 'locked';
    if (!safeEqual(o.hash, await otpHash(String(code || '')))) { await db.query(`update dev.otps set tries = tries + 1 where key = $1`, [k]); return 'wrong'; }
    await db.query(`delete from dev.otps where key = $1`, [k]);
    return { userId: o.user_id };
  }
  async function createUser(tx, { email, phone, password, meta, provider }) {
    const id = crypto.randomUUID();
    await tx.query(`insert into auth.users (instance_id, id, aud, role, email, phone, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2, $3, case when $4::text is null then null else extensions.crypt($4::text, extensions.gen_salt('bf')) end,
        case when $2::text is null then null else now() end, $5, $6, '', '', '', '')`,
      [id, email || null, phone || null, password || null, JSON.stringify({ provider, providers: [provider] }), JSON.stringify(meta || {})]);
    await tx.query(`insert into auth.identities (id, user_id, provider_id, identity_data, provider, created_at, updated_at)
      values (gen_random_uuid(), $1::uuid, $2::text, $3::jsonb, $4::text, now(), now())`,
      [id, provider === 'phone' ? phone : provider === 'google' ? 'google-' + email : id, JSON.stringify({ sub: id, email: email || undefined, phone: phone || undefined, email_verified: !!email }), provider]);
    return id;
  }

  async function handleAuth(req, url, sub) {
    const body = json(req.body);
    if (sub === 'settings') return out(200, { external: { email: true, phone: true, google: true }, disable_signup: false, mailer_autoconfirm: true, phone_autoconfirm: false, sms_provider: 'dev-inbox' });
    if (sub === 'signup' && req.method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return authErr(400, 'validation_failed', 'Unable to validate email address: invalid format');
      if (String(body.password || '').length < 8) return authErr(422, 'weak_password', 'Password should be at least 8 characters.');
      if ((await db.query(`select 1 from auth.users where email = $1`, [email])).rows.length) return authErr(422, 'user_already_exists', 'User already registered');
      let id;
      try { id = await db.transaction((tx) => createUser(tx, { email, password: body.password, meta: body.data, provider: 'email' })); }
      catch (e) { say('signup failed: ' + e.message); return authErr(500, 'unexpected_failure', 'Database error saving new user'); }
      return out(200, await session(await getUser(id)));
    }
    if (sub === 'otp' && req.method === 'POST') {
      if (!body.phone) return authErr(400, 'validation_failed', 'Only phone sign-in codes are supported here. Use a password for e-mail.');
      const phone = phoneDigits(body.phone);
      if (!/^2567\d{8}$/.test(phone)) return authErr(400, 'validation_failed', 'Invalid phone number format (E.164 required)');
      const u = (await db.query(`select * from auth.users where phone = $1`, [phone])).rows[0];
      if (!u && body.create_user === false) return authErr(400, 'otp_disabled', 'Signups not allowed for otp');
      const sent = await issueOtp('sms:' + phone, phone, 'sign in');
      if (sent.wait) return authErr(429, 'over_sms_send_rate_limit', `For security purposes, you can only request this after ${sent.wait} seconds.`);
      if (!u) {
        try { await db.transaction((tx) => createUser(tx, { phone, meta: body.data, provider: 'phone' })); }
        catch (e) { say('phone signup failed: ' + e.message); return authErr(500, 'unexpected_failure', 'Database error saving new user'); }
      }
      return out(200, { message_id: crypto.randomUUID() });
    }
    if (sub === 'verify' && req.method === 'POST') {
      const phone = phoneDigits(body.phone);
      const type = body.type;
      if (type !== 'sms' && type !== 'phone_change') return authErr(400, 'validation_failed', 'Unsupported verification type');
      const r = await checkOtp((type === 'sms' ? 'sms:' : 'chg:') + phone, body.token);
      if (typeof r === 'string') return authErr(r === 'locked' ? 429 : 403, 'otp_expired', r === 'locked' ? 'Too many attempts. Request a new code.' : 'Token has expired or is invalid');
      let u;
      if (type === 'sms') {
        u = (await db.query(`update auth.users set phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now() where phone = $1 returning *`, [phone])).rows[0];
      } else {
        if ((await db.query(`select 1 from auth.users where phone = $1 and id <> $2`, [phone, r.userId])).rows.length) return authErr(422, 'phone_exists', 'A user with this phone number has already been registered');
        u = (await db.query(`update auth.users set phone = $2, phone_confirmed_at = now(), updated_at = now() where id = $1 returning *`, [r.userId, phone])).rows[0];
      }
      if (!u) return authErr(404, 'user_not_found', 'User not found');
      return out(200, await session(u, 'otp'));
    }
    // "Continue with Google" stand-in (hosted Supabase shows the real Google consent screen)
    if (sub === 'authorize' && req.method === 'GET') {
      const to = safeRedirect(url.searchParams.get('redirect_to'));
      if (url.searchParams.get('provider') !== 'google') return redirect(to + '#error=unsupported_provider&error_description=Only+Google+is+available');
      return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google sign-in (dev stand-in)</title>
        <body style="font-family:system-ui;background:#F3F5F4;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
        <form method="post" action="${apiUrl}/auth/v1/dev-google" style="background:#fff;padding:28px;border-radius:20px;max-width:360px;width:calc(100% - 32px);box-shadow:0 12px 40px rgba(0,0,0,.12)">
        <div style="font-size:11px;font-weight:800;letter-spacing:.08em;background:#FFB71B;display:inline-block;padding:4px 10px;border-radius:99px">LOCAL DEV STAND-IN</div>
        <h2 style="margin:14px 0 4px">Sign in with Google</h2><p style="color:#5F6C67;font-size:14px;margin:0 0 16px">The local dev server can't reach Google. Enter the Google account to simulate. On a hosted Supabase project this is the real Google consent screen.</p>
        <label style="font-size:13px;font-weight:600">Google e-mail<input name="email" type="email" required placeholder="you@gmail.com" style="display:block;width:100%;box-sizing:border-box;height:44px;margin:6px 0 12px;padding:0 12px;border:1px solid #ccd;border-radius:10px"></label>
        <label style="font-size:13px;font-weight:600">Name on the account<input name="name" required placeholder="Your name" style="display:block;width:100%;box-sizing:border-box;height:44px;margin:6px 0 16px;padding:0 12px;border:1px solid #ccd;border-radius:10px"></label>
        <input type="hidden" name="redirect_to" value="${to.replace(/"/g, '&quot;')}">
        <button style="width:100%;height:46px;border:0;border-radius:12px;background:#0D2B23;color:#fff;font-weight:700;font-size:15px">Continue</button></form></body>`);
    }
    if (sub === 'dev-google' && req.method === 'POST') {
      const f = Object.fromEntries(new URLSearchParams(dec.decode(req.body || new Uint8Array())));
      const to = safeRedirect(f.redirect_to);
      const email = String(f.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return redirect(to + '#error=invalid_request&error_description=Enter+a+valid+e-mail');
      let u = (await db.query(`select * from auth.users where email = $1`, [email])).rows[0];
      if (!u) {
        const nm = String(f.name || '').slice(0, 80);
        u = await getUser(await db.transaction((tx) => createUser(tx, { email, provider: 'google', meta: { full_name: nm, name: nm, email } })));
      }
      return redirect(to + hashTo(await session(u, 'oauth')) + '&provider_token=dev&type=signup');
    }
    if (sub === 'token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = (await db.query(`select * from auth.users where email = lower($1) and encrypted_password = extensions.crypt($2, encrypted_password)`,
          [String(body.email || '').trim(), String(body.password || '')])).rows[0];
        if (!u) return authErr(400, 'invalid_credentials', 'Invalid login credentials');
        return out(200, await session(u));
      }
      if (grant === 'refresh_token') {
        const row = (await db.query(`update auth.refresh_tokens set revoked = true where token = $1 and not revoked returning user_id`, [body.refresh_token || ''])).rows[0];
        if (!row) return authErr(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        return out(200, await session(await getUser(row.user_id)));
      }
      return authErr(400, 'unsupported_grant_type', 'Unsupported grant type');
    }
    const c = await claimsOf(req);
    if (sub === 'user') {
      if (!c.sub) return authErr(401, 'no_authorization', 'Missing or invalid token');
      if (req.method === 'PUT') {
        if (body.password != null && String(body.password).length < 8) return authErr(422, 'weak_password', 'Password should be at least 8 characters.');
        if (body.password) await db.query(`update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')), updated_at = now() where id = $1`, [c.sub, body.password]);
        if (body.data) await db.query(`update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}') || $2::jsonb, updated_at = now() where id = $1`, [c.sub, JSON.stringify(body.data)]);
        if (body.phone) {
          const phone = phoneDigits(body.phone);
          if (!/^2567\d{8}$/.test(phone)) return authErr(400, 'validation_failed', 'Invalid phone number format (E.164 required)');
          if ((await db.query(`select 1 from auth.users where phone = $1 and id <> $2 and phone_confirmed_at is not null`, [phone, c.sub])).rows.length) {
            return authErr(422, 'phone_exists', 'A user with this phone number has already been registered');
          }
          const sent = await issueOtp('chg:' + phone, phone, 'phone change', c.sub);
          if (sent.wait) return authErr(429, 'over_sms_send_rate_limit', `For security purposes, you can only request this after ${sent.wait} seconds.`);
        }
      }
      const u = await getUser(c.sub);
      return u ? out(200, userJson(u)) : authErr(404, 'user_not_found', 'User not found');
    }
    if (sub === 'logout') {
      if (c.sub) await db.query(`update auth.refresh_tokens set revoked = true where user_id = $1`, [c.sub]);
      return out(204);
    }
    if (sub === 'recover' && req.method === 'POST') {
      const u = (await db.query(`select * from auth.users where email = lower($1)`, [String(body.email || '').trim()])).rows[0];
      if (u) {
        const tok = randomHex(16);
        await db.query(`update auth.users set recovery_token = $2, recovery_sent_at = now() where id = $1`, [u.id, tok]);
        const to = url.searchParams.get('redirect_to') || body.redirect_to || appUrl + '/app.html';
        const link = `${apiUrl}/auth/v1/verify?token=${tok}&type=recovery&redirect_to=${encodeURIComponent(to)}`;
        await inboxAdd({ kind: 'email', to: u.email, subject: 'Reset your Drop Off password', link });
        say('· password reset e-mail for ' + u.email + ' → ' + link);
      }
      return out(200, {});
    }
    if (sub === 'verify' && req.method === 'GET') {
      const u = (await db.query(`select * from auth.users where recovery_token = $1 and recovery_token <> '' and recovery_sent_at > now() - interval '1 hour'`, [url.searchParams.get('token') || ''])).rows[0];
      const to = url.searchParams.get('redirect_to') || appUrl + '/app.html';
      if (!u) return redirect(to + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
      await db.query(`update auth.users set recovery_token = '' where id = $1`, [u.id]);
      return redirect(to + hashTo(await session(u)) + '&type=recovery');
    }
    return authErr(404, 'not_found', 'Not found');
  }

  /* ---------------- REST: RPC and simple reads ---------------- */
  const fnCache = new Map();
  async function fnInfo(name) {
    if (fnCache.has(name)) return fnCache.get(name);
    const r = (await db.query(`select p.proargnames as names, p.proargtypes::regtype[]::text[] as types, p.prorettype::regtype::text as ret
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name])).rows[0];
    fnCache.set(name, r || null);
    return r || null;
  }
  const toParam = (v, type) => (v === null || v === undefined ? null
    : type.endsWith('[]') ? '{' + (Array.isArray(v) ? v : [v]).map((x) => '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}'
    : type === 'jsonb' || type === 'json' || typeof v === 'object' ? JSON.stringify(v) : String(v));
  async function rpcCall(claims, name, args) {
    const info = /^[a-z_][a-z0-9_]*$/.test(name) && (await fnInfo(name));
    if (!info) { const e = new Error(`Could not find the function public.${name}`); e.code = 'PGRST202'; throw e; }
    const names = info.names || [], parts = [], vals = [];
    Object.keys(args || {}).forEach((k) => {
      const i = names.indexOf(k);
      if (i < 0) return;
      vals.push(toParam(args[k], info.types[i]));
      parts.push(`${k} => $${vals.length}::${info.types[i]}`);
    });
    const r = await asRole(claims, (tx) => tx.query(`select public.${name}(${parts.join(', ')}) as r`, vals));
    return { info, value: r.rows[0].r === undefined ? null : r.rows[0].r };
  }
  async function handleRest(req, url, rest) {
    const c = await claimsOf(req);
    if (rest.startsWith('rpc/')) {
      const args = req.method === 'GET' ? Object.fromEntries(url.searchParams) : json(req.body);
      try {
        const { info, value } = await rpcCall(c, rest.slice(4), args);
        return info.ret === 'void' ? out(204) : out(200, value);
      } catch (e) {
        if (e.code === 'PGRST202') return out(404, { code: 'PGRST202', message: e.message });
        const [s, b] = pgError(e); return out(s, b);
      }
    }
    if (req.method !== 'GET' || !/^[a-z_][a-z0-9_]*$/.test(rest)) return out(405, { message: 'Only RPC calls and simple reads are supported' });
    const cols = (url.searchParams.get('select') || '*').split(',').map((s) => s.trim()).filter(Boolean);
    if (!cols.every((x) => x === '*' || /^[a-z_][a-z0-9_]*$/.test(x))) return out(400, { message: 'Unsupported select' });
    const where = [], vals = [];
    const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset'].includes(k) || !/^[a-z_][a-z0-9_]*$/.test(k)) continue;
      const m = /^(eq|neq|gt|gte|lt|lte|is)\.(.*)$/.exec(v);
      if (!m) continue;
      if (m[1] === 'is') where.push(`"${k}" is ${m[2] === 'null' ? 'null' : m[2] === 'true' ? 'true' : 'false'}`);
      else { vals.push(m[2]); where.push(`"${k}"::text ${ops[m[1]]} $${vals.length}`); }
    }
    const order = (url.searchParams.get('order') || '').split(',').filter((o) => /^[a-z_][a-z0-9_]*(\.(asc|desc))?$/.test(o)).map((o) => { const [c1, d] = o.split('.'); return `"${c1}" ${d || 'asc'}`; });
    const limit = Math.min(1000, +url.searchParams.get('limit') || 1000);
    const sql = `select ${cols.map((x) => (x === '*' ? '*' : `"${x}"`)).join(', ')} from public."${rest}"${where.length ? ' where ' + where.join(' and ') : ''}${order.length ? ' order by ' + order.join(', ') : ''} limit ${limit}`;
    try { return out(200, (await asRole(c, (tx) => tx.query(sql, vals))).rows); }
    catch (e) { const [s, b] = pgError(e); return out(s, b); }
  }

  /* ---------------- storage (private buckets, signed URLs; bytes kept in dev.files) ---------------- */
  function multipartFile(buf, ctype) {
    const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype || '');
    if (!m) return null;
    const bnd = enc.encode('--' + (m[1] || m[2]));
    const find = (from) => { outer: for (let i = from; i <= buf.length - bnd.length; i++) { for (let j = 0; j < bnd.length; j++) if (buf[i + j] !== bnd[j]) continue outer; return i; } return -1; };
    let pos = find(0);
    while (pos >= 0) {
      const next = find(pos + bnd.length);
      if (next < 0) break;
      const part = buf.subarray(pos + bnd.length + 2, next - 2);
      let sep = -1;
      for (let i = 0; i < part.length - 3; i++) if (part[i] === 13 && part[i + 1] === 10 && part[i + 2] === 13 && part[i + 3] === 10) { sep = i; break; }
      const head = dec.decode(part.subarray(0, sep));
      if (/filename=|name=""/.test(head)) { const t = /content-type:\s*([^\r\n]+)/i.exec(head); return { data: part.slice(sep + 4), type: t ? t[1].trim() : null }; }
      pos = next;
    }
    return null;
  }
  const fileExists = async (bucket, name) => (await db.query(`select 1 from dev.files where bucket = $1 and name = $2`, [bucket, name])).rows.length > 0;
  const signedPath = async (bucket, name, secs) => `/object/sign/${bucket}/${name}?token=${await sign({ url: bucket + '/' + name, exp: Math.floor(Date.now() / 1000) + (+secs || 3600) })}`;
  async function handleStorage(req, url, rest) {
    const c = await claimsOf(req);
    const seg = rest.split('/').map(decodeURIComponent);
    if (seg[0] !== 'object') return out(404, { statusCode: '404', error: 'not_found', message: 'Not found' });
    if (seg[1] === 'sign' && req.method === 'GET') {
      const t = await verify(url.searchParams.get('token'));
      const bucket = seg[2], name = seg.slice(3).join('/');
      if (!t || t.url !== bucket + '/' + name) return out(400, { statusCode: '400', error: 'InvalidJWT', message: 'Invalid or expired signature' });
      const f = (await db.query(`select data from dev.files where bucket = $1 and name = $2`, [bucket, name])).rows[0];
      if (!f) return out(404, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const meta = (await db.query(`select metadata from storage.objects where bucket_id = $1 and name = $2`, [bucket, name])).rows[0];
      return raw(200, new Uint8Array(f.data), { 'content-type': (meta && meta.metadata && meta.metadata.mimetype) || 'application/octet-stream', 'cache-control': 'private, max-age=3600' });
    }
    const signOne = async (bucket, name, secs) => {
      const found = await asRole(c, (tx) => tx.query(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]));
      if (!found.rows.length || !(await fileExists(bucket, name))) return null;
      return signedPath(bucket, name, secs);
    };
    if (seg[1] === 'sign' && req.method === 'POST') {
      const body = json(req.body);
      if (seg.length === 3) return out(200, await Promise.all((body.paths || []).map(async (p) => { const s = await signOne(seg[2], p, body.expiresIn); return { path: p, signedURL: s, error: s ? null : 'Object not found' }; })));
      const s = await signOne(seg[2], seg.slice(3).join('/'), body.expiresIn);
      return s ? out(200, { signedURL: s }) : out(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const bucket = seg[1], name = seg.slice(2).join('/');
      const b = (await db.query(`select * from storage.buckets where id = $1`, [bucket])).rows[0];
      if (!b || !name) return out(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
      let data = req.body || new Uint8Array(), type = req.headers.get('content-type') || 'application/octet-stream';
      if (/multipart\/form-data/.test(type)) { const f = multipartFile(data, type); if (!f) return out(400, { statusCode: '400', error: 'invalid', message: 'No file in upload' }); data = f.data; type = f.type || 'application/octet-stream'; }
      type = type.split(';')[0].trim();
      if (b.file_size_limit && data.length > +b.file_size_limit) return out(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
      if (b.allowed_mime_types && !b.allowed_mime_types.includes(type)) return out(415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${type} is not supported` });
      try {
        const r = await asRole(c, (tx) => tx.query(`insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5) returning id`,
          [bucket, name, c.sub || null, c.sub || null, JSON.stringify({ mimetype: type, size: data.length })]));
        await db.query(`insert into dev.files (bucket, name, data) values ($1, $2, $3) on conflict (bucket, name) do update set data = excluded.data`, [bucket, name, data]);
        return out(200, { Key: bucket + '/' + name, Id: r.rows[0].id });
      } catch (e) {
        if (e.code === '23505') return out(409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        return out(403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      }
    }
    return out(405, { message: 'Not supported' });
  }

  /* ---------------- Edge Functions: payments (shared provider-neutral core) and recipient proof ---------------- */
  const SERVICE = { role: 'service_role' };
  const serviceRpc = async (fn, args) => (await rpcCall(SERVICE, fn, args)).value;
  const provider = payments.makeProvider('sandbox', { env: { SANDBOX_WEBHOOK_SECRET: 'sandbox-dev-secret' }, serviceRpc, publicUrl: apiUrl });
  const CALLBACK = apiUrl + '/functions/v1/payments-webhook';
  let reconciling = false;
  async function runReconcile() {
    if (reconciling) return null;
    reconciling = true;
    try { return await payments.reconcile({ provider, serviceRpc, callbackUrl: CALLBACK }); }
    catch (e) { say('reconcile failed: ' + e.message); return null; }
    finally { reconciling = false; }
  }
  async function sandboxDecide(ref, approve) {
    const r = await serviceRpc('sandbox_decide', { p_ref: String(ref || ''), p_approve: approve, p_reason: approve ? null : 'Declined in sandbox' });
    if (r && r.ok) {
      // the provider calls back, exactly like over HTTP: signed body → webhook → status re-query → ledger
      const cb = await provider.signedCallback({ provider_ref: ref, event_id: crypto.randomUUID() });
      await handle({ method: 'POST', url: CALLBACK, headers: new Headers(cb.headers), body: enc.encode(cb.body) });
    }
    return r;
  }
  async function handleFunctions(req, url, name) {
    if (name === 'payments-initiate') {
      if (req.method !== 'POST') return out(405, { error: 'POST only' });
      const claims = await claimsOf(req);
      const userRpc = async (fn, args) => (await rpcCall(claims, fn, args)).value;
      try {
        const r = await payments.initiate({ paymentId: json(req.body).payment_id, userRpc, serviceRpc, provider, callbackUrl: CALLBACK });
        return out(r.ok ? 200 : 409, r);
      } catch (e) { return out(400, { ok: false, error: e.message }); }
    }
    if (name === 'payments-webhook') {
      try { const r = await payments.webhook({ headers: req.headers, body: dec.decode(req.body || new Uint8Array()), provider, serviceRpc }); return out(r.status, r.body); }
      catch (e) { say('webhook failed: ' + e.message); return out(500, { error: 'temporary failure, retry' }); }
    }
    if (name === 'payments-reconcile') return out(200, (await runReconcile()) || { busy: true });
    if (name === 'payments-sandbox') {
      const self = apiUrl + '/functions/v1/payments-sandbox';
      if (req.method === 'POST') {
        const raw = dec.decode(req.body || new Uint8Array());
        const isJson = /application\/json/.test(req.headers.get('content-type') || '');
        const f = isJson ? json(req.body) : Object.fromEntries(new URLSearchParams(raw));
        const r = await sandboxDecide(f.ref, f.decision === 'approve');
        if (isJson) return out(200, r);
        return html(payments.sandboxPage(await serviceRpc('sandbox_get', { p_ref: String(f.ref || '') }), { actionUrl: self, done: true }));
      }
      const ref = url.searchParams.get('ref') || '';
      return html(payments.sandboxPage(ref ? await serviceRpc('sandbox_get', { p_ref: ref }) : null, { actionUrl: self }));
    }
    if (name === 'recipient-proof') {
      const body = json(req.body);
      try {
        const paths = await serviceRpc('recipient_proof_paths', { p_token: String(body.token || ''), p_code: String(body.code || '') });
        if (!paths) return out(403, { error: 'Not available' });
        const r = {};
        for (const k of ['photo', 'signature']) r[k] = paths[k] && (await fileExists('proofs', paths[k])) ? apiUrl + '/storage/v1' + (await signedPath('proofs', paths[k], 600)) : null;
        return out(200, r);
      } catch (e) { return out(400, { error: e.message }); }
    }
    return out(404, { error: 'Function not found' });
  }

  /* ---------------- router ---------------- */
  // req: { method, url (absolute), headers (Headers or { get }), body (Uint8Array | null) } → { status, headers, body }
  async function handle(req) {
    try {
      if (req.method === 'OPTIONS') return out(204);
      const url = new URL(req.url);
      const p = url.pathname.replace(new URL(apiUrl).pathname.replace(/\/$/, ''), '');
      if (p.startsWith('/auth/v1/')) return await handleAuth(req, url, p.slice(9));
      if (p.startsWith('/rest/v1/')) return await handleRest(req, url, p.slice(9));
      if (p.startsWith('/storage/v1/')) return await handleStorage(req, url, p.slice(12));
      if (p.startsWith('/functions/v1/')) return await handleFunctions(req, url, p.slice(14));
      if (p === '/dev/inbox.json') return out(200, await inbox(20));
      if (p === '/dev/keys') return out(200, { url: apiUrl, anonKey: ANON_KEY });
      if (p === '/dev/mailbox') {
        const esc = (s) => String(s || '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
        return html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dev inbox</title>
          <meta http-equiv="refresh" content="10"><body style="font-family:system-ui;max-width:720px;margin:40px auto;padding:0 16px">
          <h1>Dev inbox</h1><p>E-mails and SMS codes the local auth server would have sent. Newest first · refreshes every 10 s.</p>${(await inbox(80)).map((m) =>
            `<div style="border:1px solid #ddd;border-radius:10px;padding:12px;margin:10px 0"><span style="font-size:11px;font-weight:700;background:${m.kind === 'sms' ? '#FFB71B' : '#E4EFEA'};padding:2px 8px;border-radius:99px">${m.kind === 'sms' ? 'SMS' : 'E-MAIL'}</span> <b>${esc(m.subject)}</b><br>To ${esc(m.to)} · ${esc(new Date(m.at).toISOString())}<br>${m.kind === 'sms' ? esc(m.body) : `<a href="${esc(m.link)}">Open the link</a>`}</div>`).join('') || '<p>Nothing yet.</p>'}</body>`);
      }
      return out(404, { message: 'Not found' });
    } catch (e) { say('error: ' + (e.stack || e.message)); return out(500, { message: e.message }); }
  }

  return { handle, anonKey: ANON_KEY, runReconcile, inbox, sandboxDecide };
}
