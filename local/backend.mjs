// Drop Off · on-device backend. Starts Postgres (PGlite, WebAssembly) in the page with the pre-built
// database and serves the app's Supabase requests through devserver/core.mjs, so the rules, RLS policies,
// state machine and payment checks are exactly the server's. Data is stored in this device's IndexedDB.
import { PGlite } from './pglite/index.js';
import { pgcrypto } from './pglite/contrib/pgcrypto.js';
import { createBackend } from './core.mjs';
import * as payCore from './payments/core.mjs';
import { sandboxPage } from './payments/sandbox-page.mjs';

const CFG = window.DO_CONFIG;
const L = window.DO_LOCAL;

async function start() {
  const ver = CFG.localDbVersion;
  const flag = 'dropoff-db-' + ver;
  let fresh = false;
  try { fresh = !localStorage.getItem(flag); } catch (e) { fresh = true; }
  // relaxedDurability: writes reach IndexedDB in the background instead of blocking every query (~45 ms each)
  const opts = { extensions: { pgcrypto }, relaxedDurability: true };
  if (fresh) opts.loadDataDir = await (await fetch(new URL('./dropoff-db.tar.gz', import.meta.url))).blob();
  const db = await PGlite.create('idb://dropoff-' + ver, opts);
  try { localStorage.setItem(flag, '1'); } catch (e) { /* private mode */ }
  const be = await createBackend({ db, apiUrl: CFG.supabaseUrl, appUrl: CFG.appUrl, secret: CFG.localSecret, payments: { ...payCore, sandboxPage },
    log: (m) => { if (/error|failed/i.test(m)) console.warn('[local]', m); } });
  setInterval(() => be.runReconcile(), 15000);
  const base = CFG.supabaseUrl;
  const localFetch = async (input, init) => {
    const req = new Request(input, init);
    if (!req.url.startsWith(base)) return fetch(input, init);
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : new Uint8Array(await req.arrayBuffer());
    const r = await be.handle({ method: req.method, url: req.url, headers: req.headers, body });
    return new Response(r.status === 204 || r.status === 303 ? null : r.body, { status: r.status, headers: r.headers });
  };
  L.status = 'ready';
  return { fetch: localFetch, backend: be, db };
}

start().then(L.resolve, (e) => { L.status = 'failed'; console.error('On-device database failed to start', e); L.reject(e); });
