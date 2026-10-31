// POST { payment_id } with the user's Authorization header.
// Checks the caller owns the payment (database), then sends it to the configured provider.
import { CORS, env, json, rpcOf, serviceClient, userClient } from '../_shared/http.ts';
import { initiate, makeProvider } from '../_shared/payments/core.mjs';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const { payment_id } = await req.json().catch(() => ({}));
  if (!payment_id) return json(400, { error: 'payment_id is required' });
  const serviceRpc = rpcOf(serviceClient());
  const provider = makeProvider(env.PAYMENT_PROVIDER || 'sandbox', { env, serviceRpc, publicUrl: env.SUPABASE_URL });
  try {
    const out = await initiate({ paymentId: payment_id, userRpc: rpcOf(userClient(req)), serviceRpc, provider,
      callbackUrl: `${env.SUPABASE_URL}/functions/v1/payments-webhook` });
    return json(out.ok ? 200 : 409, out);
  } catch (e) {
    return json(400, { ok: false, error: (e as Error).message });
  }
});
