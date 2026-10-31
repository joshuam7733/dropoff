// Provider callbacks. Deploy with --no-verify-jwt (providers do not send a Supabase JWT).
// The body is treated as a hint only: the core re-queries the provider before recording anything.
import { env, json, rpcOf, serviceClient } from '../_shared/http.ts';
import { makeProvider, webhook } from '../_shared/payments/core.mjs';

Deno.serve(async (req) => {
  if (req.method !== 'POST' && req.method !== 'PUT') return json(405, { error: 'POST only' });
  const body = await req.text();
  if (body.length > 64 * 1024) return json(413, { error: 'too large' });
  const serviceRpc = rpcOf(serviceClient());
  const provider = makeProvider(env.PAYMENT_PROVIDER || 'sandbox', { env, serviceRpc, publicUrl: env.SUPABASE_URL });
  try {
    const out = await webhook({ headers: req.headers, body, provider, serviceRpc });
    return json(out.status, out.body);
  } catch (e) {
    console.error('webhook failed', e);
    return json(500, { error: 'temporary failure, retry' });
  }
});
