// Security audit: applies every migration to a throwaway database and lists what app users can reach.
// Fails if an internal (_*) or service-only function is executable by anon/authenticated, or if a table
// is readable without RLS.   Usage: tools\node\node.exe devserver\audit-grants.mjs
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migDir = path.join(here, '..', 'supabase', 'migrations');
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(fs.readFileSync(path.join(here, 'shim.sql'), 'utf8'));
for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
const q = async (s) => (await db.query(s)).rows;
const SERVICE_ONLY = ['payment_apply_result', 'payment_claim', 'payment_mark_initiated', 'payment_record_name_check', 'payment_lookup_ref', 'payments_due',
  'sandbox_create', 'sandbox_get', 'sandbox_decide', 'sandbox_account_name', 'sms_queue', 'sms_mark', 'recipient_proof_paths'];
const fns = await q(`select p.proname as name, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
  p.prosecdef as definer from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`);
let bad = 0;
const allowedInternal = ['_rider_fits', '_eligible_online_count', '_folder_uuid', '_kyc_tier', '_mask_phone']; // read-only helpers used by RLS / app_state
for (const f of fns) {
  if ((f.anon || f.auth) && f.name.startsWith('_') && !allowedInternal.includes(f.name)) { console.log('✗ internal function callable by clients:', f.name); bad++; }
  if ((f.anon || f.auth) && SERVICE_ONLY.includes(f.name)) { console.log('✗ service-only function callable by clients:', f.name); bad++; }
}
const anonFns = fns.filter((f) => f.anon).map((f) => f.name);
console.log('anon can call:', anonFns.join(', '));
const tables = await q(`select c.relname as name, c.relrowsecurity as rls, has_table_privilege('authenticated', c.oid, 'select') as sel,
  has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete') as write,
  has_table_privilege('anon', c.oid, 'select') as anon_sel
  from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`);
for (const t of tables) {
  if (!t.rls) { console.log('✗ table without RLS:', t.name); bad++; }
  if (t.write) { console.log('✗ clients can write table directly:', t.name); bad++; }
}
console.log('tables readable by anon:', tables.filter((t) => t.anon_sel).map((t) => t.name).join(', '));
const secrets = await q(`select has_column_privilege('authenticated', 'public.delivery_secrets', 'delivery_pin', 'select') as pin`);
if (secrets[0].pin) { console.log('✗ delivery_pin is selectable'); bad++; }
console.log(bad ? `\n${bad} problem(s)` : `\nOK · ${fns.length} functions, ${tables.length} tables checked`);
process.exit(bad ? 1 : 0);
