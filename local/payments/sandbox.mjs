// Sandbox payment provider. Behaves like a mobile money network: a collection or payout request stays
// "pending" until someone answers the prompt on the sandbox approval page (payments-sandbox), which then
// sends a signed callback to payments-webhook. No real money moves. State lives in public.payment_sandbox.
import { signTimestamped, verifyTimestamped } from './signature.mjs';

export function sandboxProvider({ env, serviceRpc, publicUrl }) {
  const secret = env.SANDBOX_WEBHOOK_SECRET || 'sandbox-dev-secret';
  const approvalUrl = (ref) => `${publicUrl}/functions/v1/payments-sandbox?ref=${encodeURIComponent(ref)}`;
  return {
    name: 'sandbox',
    live: false,
    async collect(req) {
      const { provider_ref } = await serviceRpc('sandbox_create', { p: { payment_id: req.reference, direction: 'collection', method: req.method, amount: req.amount, currency: req.currency, msisdn: req.msisdn } });
      // card payments use a hosted checkout page; mobile money pushes a prompt to the phone
      return { providerRef: provider_ref, status: 'pending', checkoutUrl: approvalUrl(provider_ref), raw: { sandbox: true } };
    },
    async disburse(req) {
      const { provider_ref } = await serviceRpc('sandbox_create', { p: { payment_id: req.reference, direction: 'disbursement', method: req.method, amount: req.amount, currency: req.currency, msisdn: req.msisdn } });
      return { providerRef: provider_ref, status: 'pending', checkoutUrl: approvalUrl(provider_ref), raw: { sandbox: true } };
    },
    async status({ providerRef }) {
      const s = await serviceRpc('sandbox_get', { p_ref: providerRef });
      if (!s) return { status: 'failed', reason: 'Unknown sandbox reference' };
      return { status: s.status, amount: s.amount, currency: s.currency, providerTxnId: s.status === 'successful' ? 'SBXTX-' + providerRef.slice(4) : null, reason: s.reason, raw: s };
    },
    async lookupName({ msisdn }) {
      const name = await serviceRpc('sandbox_account_name', { p_msisdn: msisdn });
      return name ? { name } : null;
    },
    // Callback: signature checked here; the payload is only a hint — the core always re-queries status().
    async parseWebhook({ headers, body }) {
      if (!(await verifyTimestamped(secret, headers.get('x-sandbox-signature'), body))) return { ok: false, error: 'bad signature' };
      const j = JSON.parse(body);
      return { ok: true, providerRef: j.provider_ref, eventId: j.event_id };
    },
    // used by the approval page to notify payments-webhook like a real provider would
    async signedCallback(payload) {
      const body = JSON.stringify(payload);
      return { body, headers: { 'content-type': 'application/json', 'x-sandbox-signature': await signTimestamped(secret, body) } };
    }
  };
}
