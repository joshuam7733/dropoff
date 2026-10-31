// Africa's Talking SMS (https://developers.africastalking.com). Env:
//   AT_USERNAME   'sandbox' for the AT sandbox, or your app username
//   AT_API_KEY    API key (Edge Function secret)
//   AT_SENDER_ID  optional approved alphanumeric sender ID, e.g. DROPOFF
export async function sendSms(env, to, message) {
  if (!env.AT_API_KEY || !env.AT_USERNAME) throw new Error("Africa's Talking is not configured (AT_USERNAME, AT_API_KEY)");
  const host = env.AT_USERNAME === 'sandbox' ? 'https://api.sandbox.africastalking.com' : 'https://api.africastalking.com';
  const form = new URLSearchParams({ username: env.AT_USERNAME, to: toE164(to), message });
  if (env.AT_SENDER_ID) form.set('from', env.AT_SENDER_ID);
  const res = await fetch(host + '/version1/messaging', {
    method: 'POST', headers: { apiKey: env.AT_API_KEY, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form
  });
  const j = await res.json().catch(() => ({}));
  const r = j && j.SMSMessageData && j.SMSMessageData.Recipients && j.SMSMessageData.Recipients[0];
  if (!res.ok || !r || !/Success/i.test(r.status || '')) throw new Error('SMS not accepted: ' + ((r && r.status) || res.status));
  return { messageId: r.messageId, cost: r.cost };
}

// "+256 772 418 905", "0772418905" or "256772418905" → "+256772418905"
export function toE164(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '256' + d.slice(1);
  if (d.length === 9) d = '256' + d;
  return '+' + d;
}
