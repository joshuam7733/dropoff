// Sandbox approval page (stands in for the phone prompt / hosted card checkout). Deploy with --no-verify-jwt.
// Disabled unless PAYMENT_PROVIDER is 'sandbox', so it can never approve a real payment.
import { env, rpcOf, serviceClient } from '../_shared/http.ts';
import { makeProvider } from '../_shared/payments/core.mjs';
import { sandboxPage } from '../_shared/payments/sandbox-page.mjs';

const html = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

Deno.serve(async (req) => {
  if ((env.PAYMENT_PROVIDER || 'sandbox') !== 'sandbox') return html('Not available', 404);
  const serviceRpc = rpcOf(serviceClient());
  const self = `${env.SUPABASE_URL}/functions/v1/payments-sandbox`;
  const url = new URL(req.url);
  if (req.method === 'POST') {
    const form = await req.formData();
    const ref = String(form.get('ref') || ''), approve = form.get('decision') === 'approve';
    await serviceRpc('sandbox_decide', { p_ref: ref, p_approve: approve, p_reason: approve ? null : 'Declined in sandbox' });
    const provider = makeProvider('sandbox', { env, serviceRpc, publicUrl: env.SUPABASE_URL });
    const cb = await provider.signedCallback({ provider_ref: ref, event_id: crypto.randomUUID() });
    await fetch(`${env.SUPABASE_URL}/functions/v1/payments-webhook`, { method: 'POST', headers: cb.headers, body: cb.body });
    return html(sandboxPage(await serviceRpc('sandbox_get', { p_ref: ref }), { actionUrl: self, done: true }));
  }
  const ref = url.searchParams.get('ref') || '';
  return html(sandboxPage(ref ? await serviceRpc('sandbox_get', { p_ref: ref }) : null, { actionUrl: self }));
});
