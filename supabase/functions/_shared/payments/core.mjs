// Drop Off · provider-neutral payment orchestration.
// Plain ES module (fetch + WebCrypto only) so the same code runs in Supabase Edge Functions (Deno) and in
// the local dev server (Node). Money never moves here: only public.payment_apply_result() changes balances,
// and it runs with the service role after the provider's answer has been fetched by us.
//
//   userRpc(fn, args)    → Postgres RPC with the caller's JWT (ownership checks, RLS)
//   serviceRpc(fn, args) → Postgres RPC with the service role (provider results)
import { sandboxProvider } from './sandbox.mjs';
import { mtnMomoProvider } from './mtn-momo.mjs';

export function makeProvider(name, ctx) {
  if (name === 'sandbox') return sandboxProvider(ctx);
  if (name === 'mtn_momo') return mtnMomoProvider(ctx);
  throw new Error('Unknown payment provider: ' + name);
}

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
// Names match when they share at least two words, or one word when either side has a single word.
export function namesMatch(a, b) {
  const A = new Set(words(a)), B = words(b);
  const common = B.filter((w) => A.has(w)).length;
  return common >= Math.min(2, A.size, B.length) && common > 0;
}

// Sends one claimed payment to the provider. Safe to call twice: the database claim and the provider
// reference (our payment id) both prevent a second request.
async function send(claimed, { provider, serviceRpc, callbackUrl }) {
  const p = claimed.payment;
  if (p.provider !== provider.name) {
    await serviceRpc('payment_apply_result', { p: { payment_id: p.id, status: 'failed', reason: 'Payment provider changed. Start again.', source: 'initiate' } });
    return { ok: false, error: 'This payment belongs to a different provider.' };
  }
  const req = { reference: p.id, amount: p.amount, currency: provider.currency || p.currency, msisdn: p.msisdn, method: p.method, description: p.description, callbackUrl };
  if (p.direction === 'disbursement' && !p.nameChecked && provider.lookupName) {
    const holder = await provider.lookupName({ msisdn: p.msisdn }).catch(() => null);
    const match = holder ? namesMatch(holder.name, p.kycName) : false;
    await serviceRpc('payment_record_name_check', { p_payment: p.id, p_account_name: holder ? holder.name : null, p_match: match });
    if (!match) return { ok: true, held: true, status: 'pending', message: 'Held for a quick ops check: the mobile money account name does not match your verified name.' };
  }
  let res;
  try { res = p.direction === 'disbursement' ? await provider.disburse(req) : await provider.collect(req); }
  catch (e) { res = { status: 'error', reason: e.message }; }
  if (res.status === 'error') return { ok: false, error: 'The payment provider is not reachable. We will retry automatically.' };
  if (res.status === 'failed') {
    await serviceRpc('payment_apply_result', { p: { payment_id: p.id, provider: provider.name, status: 'failed', reason: res.reason, source: 'initiate' } });
    return { ok: false, error: res.reason || 'The provider declined the request.' };
  }
  await serviceRpc('payment_mark_initiated', { p_payment: p.id, p_provider_ref: res.providerRef, p_checkout_url: res.checkoutUrl || null, p_detail: res.raw || {} });
  if (res.status === 'successful') await check({ id: p.id, providerRef: res.providerRef, direction: p.direction }, { provider, serviceRpc, source: 'initiate' });
  return { ok: true, status: 'initiated', providerRef: res.providerRef, checkoutUrl: res.checkoutUrl || null, sandbox: !provider.live };
}

// payments-initiate: called by the app (with the user's token) right after creating a payment.
export async function initiate({ paymentId, userRpc, serviceRpc, provider, callbackUrl }) {
  const claimed = await userRpc('payment_request_initiation', { p_payment: paymentId });
  if (!claimed || !claimed.ok) return { ok: false, error: (claimed && claimed.error) || 'This payment cannot be sent.' };
  return send(claimed, { provider, serviceRpc, callbackUrl });
}

// Asks the provider for the truth and records it. Callback payloads are never trusted for amounts or status.
export async function check(item, { provider, serviceRpc, source, eventId, expired }) {
  let s;
  try { s = await provider.status({ providerRef: item.providerRef, direction: item.direction }); }
  catch (e) { return { ok: false, error: e.message }; }
  let status = s.status;
  if (status === 'pending' && expired) status = 'failed';
  return serviceRpc('payment_apply_result', { p: { payment_id: item.id, provider: provider.name, provider_event_id: eventId || null, status,
    amount: s.amount, currency: s.currency, provider_txn_id: s.providerTxnId, provider_status: s.providerStatus || s.status,
    reason: status === 'failed' && s.status === 'pending' ? 'Not approved in time' : s.reason, source: source || 'status_check' } });
}

// payments-webhook: verify (where the provider signs), find our payment, then re-query the provider.
export async function webhook({ headers, body, provider, serviceRpc }) {
  const w = await provider.parseWebhook({ headers, body });
  if (!w.ok) return { status: 401, body: { error: w.error } };
  const pay = await serviceRpc('payment_lookup_ref', { p_provider: provider.name, p_ref: w.providerRef });
  if (!pay) return { status: 200, body: { ok: true, ignored: 'unknown reference' } }; // 200 so the provider stops retrying
  const out = await check({ id: pay.id, providerRef: pay.providerRef || w.providerRef, direction: pay.direction }, { provider, serviceRpc, source: 'webhook', eventId: w.eventId });
  return { status: 200, body: { ok: true, result: out } };
}

// payments-reconcile (cron, every minute): sends pending payments the app never sent, re-checks open ones,
// and expires prompts nobody approved.
export async function reconcile({ provider, serviceRpc, callbackUrl, limit }) {
  const due = (await serviceRpc('payments_due', { p_limit: limit || 50 })) || [];
  const out = { initiated: 0, checked: 0, skipped: 0 };
  for (const item of due) {
    if (item.provider !== provider.name) { out.skipped++; continue; }
    if (item.action === 'initiate') {
      const claimed = await serviceRpc('payment_claim', { p_payment: item.id });
      if (claimed && claimed.ok) { await send(claimed, { provider, serviceRpc, callbackUrl }); out.initiated++; }
    } else {
      await check(item, { provider, serviceRpc, source: 'reconcile', expired: item.expired });
      out.checked++;
    }
  }
  return out;
}
