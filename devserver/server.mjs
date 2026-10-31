// Drop Off · local development backend (Node).
//   :54321  Supabase-compatible API: /auth/v1 · /rest/v1 · /storage/v1 · /functions/v1 · /realtime/v1 (websocket)
//   :3000   the web app (prototype/)
// The endpoints live in core.mjs (shared with the self-contained Android build). The database is real
// Postgres (PGlite) running the same migrations, RLS policies and functions as Supabase.
// Development only: one process, a fixed dev JWT secret, auto-confirmed e-mails, realtime without RLS filtering.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { WebSocketServer } from 'ws';
import * as payCore from '../supabase/functions/_shared/payments/core.mjs';
import { sandboxPage } from '../supabase/functions/_shared/payments/sandbox-page.mjs';
import { bootstrap, createBackend } from './core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const API_PORT = +(process.env.API_PORT || 54321);
const APP_PORT = +(process.env.APP_PORT || 3000);
const API_URL = `http://localhost:${API_PORT}`;
const APP_URL = `http://localhost:${APP_PORT}`;
const DATA = path.join(here, '.data');
export const DEV_SECRET = 'drop-off-local-dev-jwt-secret-not-for-production-000001';
fs.mkdirSync(DATA, { recursive: true });

/* ---------------- database ---------------- */
const db = new PGlite(path.join(DATA, 'pg'), { extensions: { pgcrypto } });
await db.waitReady;
const migDir = path.join(root, 'supabase', 'migrations');
await bootstrap(db, {
  shim: fs.readFileSync(path.join(here, 'shim.sql'), 'utf8'),
  migrations: fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort().map((name) => ({ name, sql: fs.readFileSync(path.join(migDir, name), 'utf8') })),
  seed: process.env.NO_SEED === '1' ? null : fs.readFileSync(path.join(root, 'supabase', 'seed.sql'), 'utf8'),
  appUrl: APP_URL,
  log: console.log
});
// realtime: every table in the supabase_realtime publication announces changes (no row data) on dev_realtime
await db.exec(`
  create or replace function dev.announce() returns trigger language plpgsql as $$
  begin perform pg_notify('dev_realtime', json_build_object('table', tg_table_name, 'type', tg_op)::text); return null; end $$;
  do $$ declare t record; begin
    for t in select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' loop
      execute format('drop trigger if exists dev_announce on public.%I', t.tablename);
      execute format('create trigger dev_announce after insert or update or delete on public.%I for each statement execute function dev.announce()', t.tablename);
    end loop; end $$;`);

const backend = await createBackend({ db, apiUrl: API_URL, appUrl: APP_URL, secret: DEV_SECRET, payments: { ...payCore, sandboxPage }, log: console.log });
setInterval(() => backend.runReconcile(), 15000);

/* ---------------- HTTP adapter ---------------- */
const readBody = (req) => new Promise((ok, bad) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', bad); });
const api = http.createServer(async (req, res) => {
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await readBody(req));
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const r = await backend.handle({ method: req.method, url: API_URL + req.url, headers, body });
  res.writeHead(r.status, r.headers);
  res.end(r.body == null ? undefined : typeof r.body === 'string' ? r.body : Buffer.from(r.body));
});

// realtime: Phoenix protocol (vsn 2.0.0, JSON array frames), postgres_changes only.
const wss = new WebSocketServer({ noServer: true });
let bindingSeq = 1;
api.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/realtime/v1/websocket')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  ws.channels = new Map();
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    const [joinRef, ref, topic, event, payload] = msg;
    const reply = (response) => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: response || {} }]));
    if (event === 'phx_join') {
      const pc = ((payload && payload.config && payload.config.postgres_changes) || []).map((b) => ({ ...b, id: bindingSeq++ }));
      ws.channels.set(topic, { joinRef, pc });
      reply({ postgres_changes: pc });
      ws.send(JSON.stringify([joinRef, null, topic, 'system', { status: 'ok', message: 'Subscribed to PostgreSQL', extension: 'postgres_changes', channel: topic.replace(/^realtime:/, '') }]));
    } else if (event === 'phx_leave') { ws.channels.delete(topic); reply(); }
    else reply();
  });
});
await db.listen('dev_realtime', (raw) => {
  let n; try { n = JSON.parse(raw); } catch (e) { return; }
  const ts = new Date().toISOString();
  wss.clients.forEach((ws) => ws.channels && ws.channels.forEach((ch, topic) => ch.pc.forEach((b) => {
    if ((b.table && b.table !== '*' && b.table !== n.table) || (b.event && b.event !== '*' && b.event !== n.type)) return;
    ws.send(JSON.stringify([ch.joinRef, null, topic, 'postgres_changes', { ids: [b.id], data: { schema: 'public', table: n.table, commit_timestamp: ts,
      eventType: n.type, type: n.type, new: {}, old: {}, columns: [], errors: null } }]));
  })));
});
api.listen(API_PORT, () => console.log(`Drop Off dev backend  ${API_URL}   (dev inbox for e-mails and SMS codes: ${API_URL}/dev/mailbox)`));

/* ---------------- static app ---------------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.data': 'application/octet-stream', '.gz': 'application/gzip', '.tgz': 'application/gzip' };
const appDir = path.join(root, 'prototype');
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, APP_URL).pathname);
  if (p === '/') p = '/index.html';
  const f = path.join(appDir, path.normalize(p).replace(/^([/\\])+/, ''));
  if (!f.startsWith(appDir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(APP_PORT, () => console.log(`Drop Off app           ${APP_URL}`));

// keep the app pointed at this backend unless a real Supabase config has been generated
const cfg = path.join(appDir, 'config.js');
if (!fs.existsSync(cfg) || fs.readFileSync(cfg, 'utf8').includes('"source":"devserver"')) {
  fs.writeFileSync(cfg, `// Generated by devserver/server.mjs for local development. Run scripts/gen-config.mjs to point the app at a real Supabase project.\nwindow.DO_CONFIG = ${JSON.stringify({ source: 'devserver', supabaseUrl: API_URL, supabaseAnonKey: backend.anonKey, appUrl: APP_URL })};\n`);
}
console.log('Demo accounts: ops@dropoff.test, rose@dropoff.test, moses@dropoff.test … password DropOff#2026');
