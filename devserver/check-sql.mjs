// Applies shim + migrations + seed to a throwaway in-memory Postgres (PGlite) and reports the first error.
// Usage: tools\node\node.exe devserver\check-sql.mjs
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const migDir = path.join(root, 'supabase', 'migrations');
const files = [path.join(here, 'shim.sql'), ...fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(migDir, f)), path.join(root, 'supabase', 'seed.sql')];
const db = new PGlite({ extensions: { pgcrypto } });
for (const f of files) {
  try { await db.exec(fs.readFileSync(f, 'utf8')); console.log('ok   ', path.basename(f)); }
  catch (e) { console.log('FAIL ', path.basename(f), '\n', e.message, e.where || '', e.position ? 'pos ' + e.position : ''); process.exit(1); }
}
const q = async (s) => (await db.query(s)).rows;
console.log(await q(`select status, count(*)::int from public.deliveries group by 1 order by 1`));
console.log(await q(`select v.name, w.kind, w.balance, w.pending_balance from public.wallets w join public.vendors v on v.id = w.vendor_id order by 1, 2`));
