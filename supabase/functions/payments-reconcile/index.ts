// Scheduled every minute (Supabase cron → net.http_post with header x-cron-secret).
// Sends payments the app never sent, re-checks open ones with the provider, expires unapproved prompts.
import { env, json, rpcOf, serviceClient } from '../_shared/http.ts';
import { makeProvider, reconcile } from '../_shared/payments/core.mjs';
import { safeEqual } from '../_shared/payments/signature.mjs';

Deno.serve(async (req) => {
  if (!env.CRON_SECRET || !safeEqual(req.headers.get('x-cron-secret') || '', env.CRON_SECRET)) return json(401, { error: 'unauthorised' });
  const serviceRpc = rpcOf(serviceClient());
  const provider = makeProvider(env.PAYMENT_PROVIDER || 'sandbox', { env, serviceRpc, publicUrl: env.SUPABASE_URL });
  const out = await reconcile({ provider, serviceRpc, callbackUrl: `${env.SUPABASE_URL}/functions/v1/payments-webhook` });
  return json(200, out);
});
