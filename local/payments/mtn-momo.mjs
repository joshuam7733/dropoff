// MTN Mobile Money (MoMo Open API) adapter — Collections (request to pay) and Disbursements (transfer).
// REFERENCE IMPLEMENTATION: written against MTN's public API documentation and NOT yet tested with real
// credentials. Test it in the MTN sandbox (momodeveloper.mtn.com; the sandbox only accepts currency EUR)
// before switching payment_provider to 'mtn_momo'.
//
// Env (Edge Function secrets, never in the app):
//   MTN_MOMO_BASE_URL            https://sandbox.momodeveloper.mtn.com  |  production URL from MTN
//   MTN_MOMO_TARGET_ENV          sandbox | mtnuganda
//   MTN_MOMO_CURRENCY            EUR in sandbox, UGX in production
//   MTN_MOMO_COLLECTION_KEY      Ocp-Apim-Subscription-Key for the Collections product
//   MTN_MOMO_COLLECTION_USER / MTN_MOMO_COLLECTION_API_KEY   API user + key for Collections
//   MTN_MOMO_DISBURSEMENT_KEY / MTN_MOMO_DISBURSEMENT_USER / MTN_MOMO_DISBURSEMENT_API_KEY
//
// MTN callbacks are not signed, so parseWebhook only extracts the reference; the core then asks MTN for the
// status with our own credentials before any money moves.
export function mtnMomoProvider({ env }) {
  const base = (env.MTN_MOMO_BASE_URL || '').replace(/\/$/, '');
  const target = env.MTN_MOMO_TARGET_ENV || 'sandbox';
  const currency = env.MTN_MOMO_CURRENCY || 'UGX';
  const products = {
    collection: { key: env.MTN_MOMO_COLLECTION_KEY, user: env.MTN_MOMO_COLLECTION_USER, secret: env.MTN_MOMO_COLLECTION_API_KEY },
    disbursement: { key: env.MTN_MOMO_DISBURSEMENT_KEY, user: env.MTN_MOMO_DISBURSEMENT_USER, secret: env.MTN_MOMO_DISBURSEMENT_API_KEY }
  };
  const tokens = {};
  async function token(product) {
    const t = tokens[product];
    if (t && t.exp > Date.now() + 60000) return t.value;
    const p = products[product];
    if (!base || !p.key || !p.user || !p.secret) throw new Error('MTN MoMo ' + product + ' credentials are not configured');
    const res = await fetch(`${base}/${product}/token/`, { method: 'POST', headers: { authorization: 'Basic ' + btoa(`${p.user}:${p.secret}`), 'ocp-apim-subscription-key': p.key } });
    if (!res.ok) throw new Error('MTN token request failed: ' + res.status);
    const j = await res.json();
    tokens[product] = { value: j.access_token, exp: Date.now() + (+j.expires_in || 3600) * 1000 };
    return j.access_token;
  }
  const headers = async (product, extra) => ({ authorization: 'Bearer ' + (await token(product)), 'x-target-environment': target,
    'ocp-apim-subscription-key': products[product].key, 'content-type': 'application/json', ...(extra || {}) });
  const map = (s) => (s === 'SUCCESSFUL' ? 'successful' : s === 'FAILED' || s === 'REJECTED' || s === 'TIMEOUT' ? 'failed' : 'pending');
  const amountOk = (amount) => String(Math.round(amount));

  async function request(product, path, req, partyKey, callbackUrl) {
    // X-Reference-Id = our payment id (a UUID), so a retried request can never create a second charge at MTN.
    const body = { amount: amountOk(req.amount), currency, externalId: req.reference, [partyKey]: { partyIdType: 'MSISDN', partyId: req.msisdn },
      payerMessage: req.description.slice(0, 80), payeeNote: req.description.slice(0, 80) };
    const extra = { 'x-reference-id': req.reference };
    if (callbackUrl && /^https:\/\//.test(callbackUrl)) extra['x-callback-url'] = callbackUrl;
    const res = await fetch(`${base}/${product}/v1_0/${path}`, { method: 'POST', headers: await headers(product, extra), body: JSON.stringify(body) });
    if (res.status === 202) return { providerRef: req.reference, status: 'pending', raw: { http: 202 } };
    const text = await res.text();
    if (res.status === 409) return { providerRef: req.reference, status: 'pending', raw: { http: 409, note: 'duplicate reference: already requested' } };
    return { providerRef: req.reference, status: 'failed', reason: 'MTN refused the request (' + res.status + ')', raw: { http: res.status, body: text.slice(0, 300) } };
  }

  return {
    name: 'mtn_momo',
    live: target !== 'sandbox',
    currency,
    collect: (req) => request('collection', 'requesttopay', req, 'payer', req.callbackUrl),
    disburse: (req) => request('disbursement', 'transfer', req, 'payee', req.callbackUrl),
    async status({ providerRef, direction }) {
      const product = direction === 'disbursement' ? 'disbursement' : 'collection';
      const path = product === 'collection' ? 'requesttopay' : 'transfer';
      const res = await fetch(`${base}/${product}/v1_0/${path}/${encodeURIComponent(providerRef)}`, { headers: await headers(product) });
      if (res.status === 404) return { status: 'pending', reason: 'not found yet' };
      if (!res.ok) throw new Error('MTN status check failed: ' + res.status);
      const j = await res.json();
      return { status: map(j.status), amount: Math.round(+j.amount), currency: j.currency, providerTxnId: j.financialTransactionId || null,
        reason: j.reason ? (j.reason.message || j.reason.code || String(j.reason)) : null, providerStatus: j.status, raw: j };
    },
    async lookupName({ msisdn }) {
      const res = await fetch(`${base}/collection/v1_0/accountholder/msisdn/${encodeURIComponent(msisdn)}/basicuserinfo`, { headers: await headers('collection') });
      if (!res.ok) return null;
      const j = await res.json();
      const name = [j.given_name, j.family_name].filter(Boolean).join(' ') || j.name;
      return name ? { name } : null;
    },
    async parseWebhook({ body }) {
      let j = {}; try { j = JSON.parse(body); } catch (e) { return { ok: false, error: 'bad body' }; }
      const ref = j.externalId || j.referenceId;
      return ref ? { ok: true, providerRef: ref, eventId: null } : { ok: false, error: 'no reference' };
    }
  };
}
