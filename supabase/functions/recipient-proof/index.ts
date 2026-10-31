// POST { token, code } from the recipient tracking page (no account).
// The database checks the tracking token + phone digits (with attempt limits); only then are short-lived
// signed URLs created for the proof photo and signature in the private "proofs" bucket.
import { CORS, json, serviceClient } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const { token, code } = await req.json().catch(() => ({}));
  const sb = serviceClient();
  const { data: paths, error } = await sb.rpc('recipient_proof_paths', { p_token: String(token || ''), p_code: String(code || '') });
  if (error) return json(400, { error: error.message });
  if (!paths) return json(403, { error: 'Not available' });
  const out: Record<string, string | null> = {};
  for (const k of ['photo', 'signature']) {
    const p = paths[k];
    if (!p) { out[k] = null; continue; }
    const { data } = await sb.storage.from('proofs').createSignedUrl(p, 600);
    out[k] = data ? data.signedUrl : null;
  }
  return json(200, out);
});
