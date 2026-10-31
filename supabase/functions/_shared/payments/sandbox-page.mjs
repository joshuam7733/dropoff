// The sandbox "phone prompt" / hosted checkout page. Shared by the payments-sandbox Edge Function and the
// local dev server. It asks for no PIN or card number: it only records Approve or Decline, then notifies
// payments-webhook exactly like a provider callback would.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ugx = (n) => 'UGX ' + Math.round(+n || 0).toLocaleString('en-US');

export function sandboxPage(info, { actionUrl, done }) {
  const net = info && (info.method === 'momo' ? 'MTN Mobile Money' : info.method === 'airtel' ? 'Airtel Money' : 'Card checkout');
  const body = !info ? '<p>Unknown or expired request.</p>'
    : info.status !== 'pending' || done ? `<p class="big">${info.status === 'successful' ? '✓ Approved' : info.status === 'failed' ? '✕ Declined' : 'Done'}</p><p>You can close this page and go back to Drop Off.</p>`
    : `<p class="muted">${esc(net)} · ${info.direction === 'collection' ? 'payment request' : 'incoming transfer'}</p>
       <p class="big">${esc(ugx(info.amount))}</p>
       <p>${info.direction === 'collection' ? `Drop Off is asking ${esc(info.msisdn ? '+' + info.msisdn : 'you')} to pay for a ${esc(info.purpose === 'topup' ? 'wallet top-up' : 'delivery')}.`
         : `Drop Off is sending a cash-out to ${esc('+' + info.msisdn)}.`}</p>
       <form method="post" action="${esc(actionUrl)}"><input type="hidden" name="ref" value="${esc(info.providerRef)}">
         <button name="decision" value="approve" class="ok">${info.direction === 'collection' ? 'Approve payment' : 'Confirm received'}</button>
         <button name="decision" value="decline" class="no">${info.direction === 'collection' ? 'Decline' : 'Simulate failure'}</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment sandbox</title>
<style>body{margin:0;font-family:system-ui,sans-serif;background:#0D2B23;color:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;color:#0D2B23;border-radius:22px;padding:26px;max-width:360px;width:calc(100% - 32px);box-shadow:0 20px 60px rgba(0,0,0,.35)}
.tag{display:inline-block;background:#FFB71B;color:#0D2B23;font-weight:800;font-size:11px;letter-spacing:.08em;padding:4px 10px;border-radius:999px}
.big{font-size:32px;font-weight:800;margin:10px 0}.muted{color:#5F6C67;font-size:14px}button{width:100%;height:48px;border-radius:14px;border:0;font-weight:700;font-size:16px;margin-top:10px;cursor:pointer}
.ok{background:#0D2B23;color:#fff}.no{background:#F3F5F4;color:#0D2B23}small{display:block;margin-top:16px;color:#5F6C67}</style></head>
<body><div class="card"><span class="tag">SANDBOX · NO REAL MONEY</span>${body}<small>This page stands in for the customer's phone prompt or a hosted card checkout until a real payment provider is connected.</small></div></body></html>`;
}
